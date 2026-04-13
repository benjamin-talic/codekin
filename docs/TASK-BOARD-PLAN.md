# Agent Joe Task Board

## Context

Agent Joe can spawn child sessions to do work in repositories, but the system has critical gaps that make him ineffective as a manager:

1. **Results are unreadable** — `extractText()` concatenates ALL output messages into a raw text blob (50KB+). Joe burns half his context window parsing it.
2. **Joe is deaf between cron ticks** — polls every 30 minutes via cron, but the server knows instantly when children finish/fail/get stuck.
3. **Only "implement + PR" tasks** — no way to say "go explore this codebase" or "review this PR".
4. **No live visibility** — Joe can't see what a child is currently doing without reading raw output.
5. **Approval routing is manual** — Joe has to poll `/sessions/pending-prompts` to discover stuck children.
6. **No UI** — the user can't see what Joe is managing without asking him.

This plan evolves the existing `OrchestratorChildManager` into a **Task Board** — a server-side task queue with structured results, automatic event delivery to Joe, approval routing, and a UI panel in Joe's chat view.

## Data Model

### TaskEntry (replaces ChildSession)

```typescript
// server/task-board-types.ts
type TaskType = 'implement' | 'explore' | 'review' | 'research'
type TaskStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timed_out'
type TaskState = 'idle' | 'processing' | 'waiting_for_approval' | 'exited'

interface TaskRequest {
  repo: string
  task: string
  branchName: string
  taskType: TaskType
  completionPolicy: 'pr' | 'merge' | 'commit-only' | 'none' // 'none' for explore/research
  useWorktree: boolean
  timeoutMs?: number
  model?: string
  allowedTools?: string[]
}

interface TaskSnapshot {
  state: TaskState
  activeTool: string | null
  turnCount: number
  lastToolSequence: Array<{ toolName: string; summary?: string; completedAt: string }> // last 5
  filesRead: string[]     // from Read/Glob tool events, capped at 50
  filesChanged: string[]  // from Write/Edit tool events, capped at 50
  pendingApproval: {
    requestId: string
    toolName: string
    toolInput: Record<string, unknown>
    since: string
  } | null
}

interface TaskResult {
  summary: string            // last assistant message, capped at 1000 chars
  artifacts: {
    prUrl: string | null     // parsed from gh pr create output
    branchName: string | null
    filesChanged: string[]
    commitCount: number
  }
  duration: number           // ms
}

interface TaskEntry {
  id: string
  request: TaskRequest
  status: TaskStatus
  snapshot: TaskSnapshot
  result: TaskResult | null
  error: string | null
  startedAt: string
  completedAt: string | null
}
```

### TaskEvent (queued for delivery to Joe)

```typescript
type TaskEventType = 'completed' | 'failed' | 'stuck' | 'timed_out' | 'approval_needed'

interface TaskEvent {
  id: string
  taskId: string
  type: TaskEventType
  timestamp: string
  delivered: boolean
  payload: {
    summary?: string
    error?: string
    artifacts?: TaskResult['artifacts']
    approval?: { requestId: string; toolName: string; since: string }
  }
}
```

## Server Architecture

### New: `server/task-board.ts` — TaskBoard class

Wraps and replaces `OrchestratorChildManager`. Three responsibilities:

**A) Task lifecycle** — `spawn()`, `monitorTask()`, structured result extraction
- `spawn(request)` — same flow as current children manager (create session, worktree, start claude, send prompt), but builds prompts per task type and initializes snapshot tracking
- `monitorTask()` — same hook-based monitoring (onSessionResult/onSessionExit), but extracts structured results instead of raw text
- Prompt templates per task type:
  - `implement` — current buildPrompt() logic (branch, PR/push completion steps)
  - `explore` — "Read and analyze. Report findings. Do not make code changes."
  - `review` — "Review and provide actionable feedback by severity."
  - `research` — "Answer this question with file references."

**B) Snapshot tracking** — real-time progress from tool events
- Registers `onToolActive`/`onToolDone` listeners on SessionManager (new hooks, see below)
- Updates snapshot: `activeTool`, `turnCount`, `lastToolSequence` (ring buffer of 5), `filesRead`/`filesChanged` (parsed from tool input)
- Tracks `pendingApproval` via `onSessionPrompt` listener

**C) Event queue** — notifications for Joe
- `queueEvent(taskId, type, payload)` — adds to internal array
- `deliverPendingEvents()` — checks if Joe is idle (`!isProcessing`), formats batch, calls `sessions.sendInput(joeId, message)`
- Delivery triggered in two places: (1) when new event queued and Joe is idle, (2) when Joe's own turn completes (via onSessionResult listener)
- 5-minute stuck timer: when a child's pending approval exceeds 5 min without response, queue a `stuck` event

**Key methods:**
```
spawn(request: TaskRequest): Promise<TaskEntry>
list(): TaskEntry[]
get(id: string): TaskEntry | null
sendMessageToChild(taskId: string, message: string): void
respondToApproval(taskId: string, requestId: string, value: string): void
retryTask(taskId: string): Promise<TaskEntry>
```

### Modify: `server/session-manager.ts` — Add tool event hooks

Add `onToolActive()` and `onToolDone()` listener registration, following the exact pattern of existing `onSessionResult`/`onSessionExit`:

- Add `_toolActiveListeners` and `_toolDoneListeners` arrays (after line ~118)
- Add registration methods `onToolActive()`, `onToolDone()` returning unsubscribe fns (after line ~655)
- Fire listeners from existing `tool_active`/`tool_done` event handlers (lines ~950-955)

This is ~20 lines of code following an established pattern.

### Structured result extraction (replaces `extractText()`)

**`extractSummary(history)`** — Walk `outputHistory` in reverse from the last `result` event, collect `output` messages, cap at 1000 chars. This gives the final assistant message, not the entire stream.

**`extractArtifacts(task)`** — Parse from tool events:
- PR URL: regex `https://github.com/.*/pull/\d+` from `tool_done` summaries and `output` messages
- Files changed: from snapshot.filesChanged
- Commit count: count `tool_done` events where toolName is `Bash` and summary contains "git commit"

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/orchestrator/tasks` | List all tasks |
| `GET` | `/api/orchestrator/tasks/:id` | Get single task with snapshot |
| `POST` | `/api/orchestrator/tasks` | Spawn new task (repo, task, taskType required) |
| `POST` | `/api/orchestrator/tasks/:id/message` | Send follow-up to running child |
| `POST` | `/api/orchestrator/tasks/:id/approve` | Approve/deny child's pending request |
| `POST` | `/api/orchestrator/tasks/:id/retry` | Re-spawn a failed task |
| `GET` | `/api/orchestrator/tasks/events` | Get event queue |

Existing `/api/orchestrator/children` endpoints remain for backward compat, delegating to TaskBoard with `taskType: 'implement'`.

Validation: same as current children endpoint (repo under REPOS_ROOT, branch name regex, etc). `branchName` required for `implement`, auto-generated for other types.

## Event Delivery to Joe

When a task reaches a milestone, the server queues an event. Events batch and deliver when Joe goes idle:

```
[Task Board — 2 updates]

COMPLETED: "Explore auth module" (backend) — 4m 12s
  Found 3 middleware files, JWT-based auth, tokens validated in Redis.

APPROVAL NEEDED: "Add rate limiting" (api-gateway)
  Tool: Bash(git push origin fix/rate-limit) — waiting 45s
  Task ID: abc-123 | Request ID: req-456
```

Delivered via `sessions.sendInput(joeId, message)` — same mechanism as the existing OrchestratorMonitor notifications and cron prompts. Joe sees it as his next conversation turn.

**Approval race handling:** Both Joe (via curl) and human (via UI) can respond. `sendPromptResponse()` already returns 409 if the request is gone. TaskBoard catches this as a no-op.

## UI: TaskBoardPanel

### Component: `src/components/TaskBoardPanel.tsx`

Right sidebar panel following the DiffPanel pattern:
- `isOpen`/`onClose` props, resizable width (280-1200px) stored in localStorage
- Escape to close
- Toggled by clicking the "active sessions" stat card in OrchestratorView header

### Layout

```
TaskBoardPanel
  +-- Resize handle (left edge drag)
  +-- Header ("Task Board" + task counts + close button)
  +-- Scrollable task list, grouped by status
      +-- NEEDS APPROVAL section (amber accent)
      |   +-- TaskCard: tool name, approve/deny buttons, "view in session" link
      +-- RUNNING section (blue accent)
      |   +-- TaskCard: active tool, turn count, duration timer, files changed
      +-- COMPLETED section (green accent)
      |   +-- TaskCard: summary (2 lines, expandable), PR link, duration, files
      +-- FAILED section (red accent)
          +-- TaskCard: error message, retry button, send message button
```

### Actions on task cards

- **Approve/Deny** — calls `POST /api/orchestrator/tasks/:id/approve`
- **View in session** — navigates to child session tab (sessions already in sidebar)
- **View summary** — expands structured result inline
- **Retry** — calls `POST /api/orchestrator/tasks/:id/retry`
- **Send message** — opens inline input, calls `POST /api/orchestrator/tasks/:id/message`

### Data fetching: `src/hooks/useTaskBoard.ts`

Follows `useSessions.ts` pattern: `useState` + `useCallback` + `setInterval(10s)` polling when panel is open. Also refreshes on `sessions_updated` WebSocket events.

### Wiring

- `OrchestratorView.tsx` — StatCard gets `onClick` prop, "active sessions" card toggles panel. Add "needs approval" stat card (amber, only if > 0).
- `OrchestratorContent.tsx` — adds `TaskBoardPanel` as flex sibling to chat area
- `App.tsx` — adds `taskBoardOpen` state, passes toggle/close handlers

## Joe's CLAUDE.md Updates

In `server/orchestrator-manager.ts`, update `CLAUDE_MD_TEMPLATE`:

1. **New "Task Types" section** — explain the four types and when to use each
2. **Update spawn examples** — `POST /api/orchestrator/tasks` with `taskType` field
3. **Replace polling with event delivery** — "You receive automatic notifications. No cron polling needed."
4. **Add "Send Message to Child" section** — `POST /tasks/:id/message` curl example
5. **Add "Approve Child Requests" section** — `POST /tasks/:id/approve` curl example
6. **Remove child monitor cron** — the `*/30 * * * *` cron job is no longer needed
7. **Add cross-repo orchestration guidance** — plan execution order, spawn explore tasks first, then implement with context from results

## Implementation Order

### Phase 1: Server foundation (Steps 1-3)

**Step 1: Types + SessionManager hooks**
- Create `server/task-board-types.ts`
- Add `onToolActive`/`onToolDone` hooks to `server/session-manager.ts`
- Non-breaking, no behavior change

**Step 2: TaskBoard class**
- Create `server/task-board.ts`
- Port spawn/monitor logic from `orchestrator-children.ts`
- Add snapshot tracking and structured result extraction
- Add prompt templates for all four task types
- Tests (port existing + new snapshot/result tests)

**Step 3: Event queue + delivery**
- Add event queue to TaskBoard
- Wire delivery to Joe's idle state
- Add stuck timer for pending approvals
- Tests for batching and delivery timing

### Phase 2: API + Joe prompt (Steps 4-5)

**Step 4: REST endpoints**
- Add task board routes to `server/orchestrator-routes.ts`
- Wire TaskBoard into route factory
- Preserve backward compat for `/api/orchestrator/children`
- Update dashboard stats

**Step 5: Joe's CLAUDE.md**
- Update template in `server/orchestrator-manager.ts`
- Add task types, event delivery explanation, cross-repo guidance
- Remove polling cron

### Phase 3: Frontend (Steps 6-9)

**Step 6: Types + API client**
- Add frontend types to `src/types.ts`
- Add API functions to `src/lib/ccApi.ts`

**Step 7: useTaskBoard hook**
- Create `src/hooks/useTaskBoard.ts`

**Step 8: TaskBoardPanel component**
- Create `src/components/TaskBoardPanel.tsx`

**Step 9: Wire into orchestrator UI**
- OrchestratorView.tsx — clickable stat card
- OrchestratorContent.tsx — panel layout
- App.tsx — state management

### Parallelism

Phase 1 and Phase 3 Steps 6-7 can run in parallel. Step 8 needs Step 7. Step 9 needs Steps 4 + 8.

## Files to Create

| File | Description |
|------|-------------|
| `server/task-board-types.ts` | TaskEntry, TaskSnapshot, TaskEvent, TaskRequest types |
| `server/task-board.ts` | TaskBoard class (lifecycle, snapshots, event queue) |
| `server/task-board.test.ts` | Tests |
| `src/hooks/useTaskBoard.ts` | Frontend data fetching hook |
| `src/components/TaskBoardPanel.tsx` | Right sidebar panel component |

## Files to Modify

| File | Change |
|------|--------|
| `server/session-manager.ts` | Add onToolActive/onToolDone listener hooks (~20 lines) |
| `server/orchestrator-routes.ts` | Add task board REST endpoints, wire TaskBoard |
| `server/orchestrator-manager.ts` | Update CLAUDE_MD_TEMPLATE |
| `server/ws-server.ts` | Create TaskBoard instance, pass to routes |
| `src/types.ts` | Add TaskBoardEntry frontend types |
| `src/lib/ccApi.ts` | Add task board API functions |
| `src/components/OrchestratorView.tsx` | Clickable stat card, needs-approval badge |
| `src/components/OrchestratorContent.tsx` | Add TaskBoardPanel to layout |
| `src/App.tsx` | Add taskBoardOpen state |

## Verification

1. **Server unit tests**: TaskBoard spawn/monitor, snapshot tracking, structured result extraction, event queue batching
2. **API integration**: curl task board endpoints with auth token, verify responses
3. **Event delivery**: Spawn a child task, verify Joe receives completion notification without polling
4. **Approval flow**: Spawn task that hits an unapproved tool, verify it appears in TaskBoardPanel, approve via UI, verify child continues
5. **UI manual test**: Open Joe's chat, click active sessions stat, verify panel opens with correct task data. Test approve/deny, view in session, retry flows.
6. **Cross-repo**: Tell Joe "explore auth in repo X and logging in repo Y" — verify two tasks spawn, results arrive, Joe synthesizes
7. **Backward compat**: Verify existing `/api/orchestrator/children` endpoints still work
