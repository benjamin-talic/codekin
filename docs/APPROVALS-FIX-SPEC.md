# Approvals System Fix Spec

Addresses race conditions, prompt loss, and synchronization bugs in the tool approval flow between Claude CLI hooks, the WebSocket server, and the React frontend.

## Background

The approval system has two parallel paths:

| Path | Trigger | Transport | Used For |
|---|---|---|---|
| **PreToolUse hook** | Claude CLI fires `.claude/hooks/pre-tool-use.mjs` before every tool | HTTP POST to `/api/hook-decision` → Promise resolves → hook returns decision | Primary path for all tool approvals |
| **control_request** | Claude CLI emits on stdout for interactive prompts | Stream-JSON stdin/stdout | Fallback for `AskUserQuestion`, `ExitPlanMode`, and tools not caught by hooks |

Both paths converge on the same client-side prompt UI, which currently stores only a single prompt at a time — the root cause of most glitches.

---

## Fix 1: Prompt Queue (replaces single-slot prompt state)

**Problem:** Client stores one prompt at a time. A second prompt overwrites the first, leaving it unanswered until the 60s server timeout.

**Files to change:**

### `src/hooks/usePromptState.ts` — Replace single state with a Map

```typescript
// Current: single PromptState object
// New: Map<requestId, PromptEntry> + a computed "active" prompt (the oldest)

export interface PromptEntry {
  requestId: string
  options: PromptOption[]
  question: string | null
  multiSelect: boolean
  promptType: 'permission' | 'question' | null
  questions?: PromptQuestion[]
  approvePattern?: string
}

interface UsePromptStateReturn {
  /** The prompt the user should see (oldest in queue, i.e. first-in-first-served). */
  active: PromptEntry | null
  /** Total number of pending prompts (for badge/indicator). */
  queueSize: number
  /** Add a prompt to the queue. */
  enqueue: (msg: WsServerMessage & { type: 'prompt' }) => void
  /** Remove a specific prompt by requestId. */
  dismiss: (requestId?: string) => void
  /** Remove all prompts (used on session leave/switch). */
  clearAll: () => void
}
```

Implementation:
- Internal state: `useState<Map<string, PromptEntry>>(new Map())`
- `enqueue`: generates a fallback `requestId` via `crypto.randomUUID()` if `msg.requestId` is undefined, inserts into Map. Use a `Map` to preserve insertion order.
- `dismiss(requestId?)`: if `requestId` provided, delete that key. If undefined, delete the oldest entry (first key). This handles legacy dismiss messages gracefully.
- `active`: return the first entry from the Map iterator (oldest prompt).
- `clearAll`: reset to empty Map.

### `src/hooks/useChatSocket.ts` — Wire up the queue

Replace the three destructured values:
```typescript
// Before
const { state: promptState, clear: clearPromptState, setFromMessage: setPromptFromMessage } = usePromptState()

// After
const { active: activePrompt, queueSize: promptQueueSize, enqueue: enqueuePrompt, dismiss: dismissPrompt, clearAll: clearAllPrompts } = usePromptState()
```

Message handler changes:
- `case 'prompt'`: call `enqueuePrompt(msg)` instead of `setPromptFromMessage(msg)`
- `case 'prompt_dismiss'`: call `dismissPrompt(msg.requestId)` instead of `clearPromptState()` — **this is fix #4 rolled in here**
- `case 'result'` / `case 'session_joined'` / `sendInput()`: call `clearAllPrompts()` instead of `clearPromptState()`

The `sendPromptResponse` callback changes:
```typescript
const sendPromptResponse = useCallback((value: string | string[]) => {
  const requestId = activePrompt?.requestId
  send({ type: 'prompt_response', value, requestId } as WsClientMessage)
  // Remove answered prompt from queue — next one (if any) becomes active
  if (requestId) dismissPrompt(requestId)
  setIsProcessing(true)
  // ...waitingSessions logic stays the same
}, [send, activePrompt?.requestId, dismissPrompt])
```

Return value changes:
```typescript
return {
  // Replace the 6 individual promptState fields with:
  activePrompt,      // PromptEntry | null
  promptQueueSize,   // number
  sendPromptResponse,
  // ... rest unchanged
}
```

### `src/App.tsx` — Consume the new shape

Replace the destructured prompt fields:
```typescript
// Before
const { promptOptions, promptQuestion, promptType, promptQuestions, approvePattern, multiSelect, ... } = useChatSocket(...)

// After
const { activePrompt, promptQueueSize, ... } = useChatSocket(...)
```

PromptButtons rendering:
```tsx
{activePrompt && (
  <PromptButtons
    key={activePrompt.requestId}  // Forces remount on prompt change — resets countdown
    options={activePrompt.options}
    question={activePrompt.question}
    multiSelect={activePrompt.multiSelect}
    promptType={activePrompt.promptType}
    questions={activePrompt.questions}
    approvePattern={activePrompt.approvePattern}
    onSelect={sendPromptResponse}
    isMobile={isMobile}
  />
)}
```

The `key={activePrompt.requestId}` is critical — it forces React to remount `PromptButtons` when the active prompt changes (e.g., after answering one and the next in queue becomes active). This resets the 15s auto-allow countdown cleanly without the `handleSingleAnswer` dependency issue from the audit (auto-allow countdown bug goes away).

Optional: show a small badge like `"2 pending"` next to the prompt bar when `promptQueueSize > 1` so the user knows more approvals are queued.

---

## Fix 2: Remove requestId fallback on server (require explicit matching)

**Problem:** When `requestId` is missing from `prompt_response`, the server matches it to the oldest pending approval, which may be wrong.

**File:** `server/session-manager.ts`

### `sendPromptResponse()` — Remove `.values().next().value` fallback

```typescript
// Before (line 837-839)
const approval = requestId
  ? session.pendingToolApprovals.get(requestId)
  : session.pendingToolApprovals.values().next().value

// After
const approval = requestId ? session.pendingToolApprovals.get(requestId) : undefined
```

Same change for `pendingControlRequests` (line 848-850):
```typescript
// Before
const pending = requestId
  ? session.pendingControlRequests.get(requestId)
  : session.pendingControlRequests.values().next().value

// After
const pending = requestId ? session.pendingControlRequests.get(requestId) : undefined
```

When `requestId` is undefined and no match is found, the existing fallback behavior already handles this — the code falls through to the plain-message `sendMessage()` path at line 864. This is safe: the user typed something that wasn't a prompt response, so it gets sent as regular input.

Add a `console.warn` when `requestId` is undefined to track occurrences:
```typescript
if (!requestId) {
  console.warn(`[prompt_response] no requestId provided, cannot match to pending approval`)
}
```

---

## Fix 3: Grace period on last-client-leave before auto-deny

**Problem:** When a user refreshes the page, `leave()` fires immediately, auto-denies all pending prompts, and `join()` fires ~100ms later to an empty queue. Claude sees a denial the user never made.

**File:** `server/session-manager.ts`

### `leave()` — Add 3-second grace period

```typescript
leave(sessionId: string, ws: WebSocket): void {
  const session = this.sessions.get(sessionId)
  if (!session) return

  session.clients.delete(ws)

  if (session.clients.size === 0) {
    // Don't auto-deny immediately — the user may be refreshing the page.
    // Wait a few seconds; if a client rejoins, cancel the auto-deny.
    if (session._leaveGraceTimer) clearTimeout(session._leaveGraceTimer)

    session._leaveGraceTimer = setTimeout(() => {
      session._leaveGraceTimer = null
      // Re-check: if still no clients after grace period, auto-deny
      if (session.clients.size === 0) {
        // ... existing auto-deny logic for pendingControlRequests and pendingToolApprovals
      }
    }, 3000)
  }
}
```

### `join()` — Cancel grace timer if client reconnects

```typescript
join(sessionId: string, ws: WebSocket): Session | undefined {
  const session = this.sessions.get(sessionId)
  if (!session) return undefined

  // Cancel pending auto-deny from leave grace period
  if (session._leaveGraceTimer) {
    clearTimeout(session._leaveGraceTimer)
    session._leaveGraceTimer = null
  }

  session.clients.add(ws)
  // ... existing re-broadcast logic unchanged
}
```

### Session type — Add the timer field

Add to the Session interface/type:
```typescript
_leaveGraceTimer?: ReturnType<typeof setTimeout> | null
```

Also clear it in `delete()` alongside the other timers:
```typescript
if (session._leaveGraceTimer) clearTimeout(session._leaveGraceTimer)
```

---

## Fix 4: Filter `prompt_dismiss` by requestId

Already handled by the `dismiss(requestId)` method in the new `usePromptState` (Fix 1). Restating for clarity:

**Before:** `case 'prompt_dismiss': clearPromptState()` — always clears current prompt regardless of which requestId was dismissed.

**After:** `case 'prompt_dismiss': dismissPrompt(msg.requestId)` — only removes the specific prompt matching the requestId. If that prompt happens to be the active one, the next queued prompt becomes active. If it's a background queued prompt (e.g., timed out while user was answering a different one), it's silently removed.

---

## Fix 5: Surface silent hook denials in the UI

**Problem:** When the PreToolUse hook denies a tool due to server error, timeout, or auth failure, the denial reason is returned to Claude CLI but **never appears in the Codekin UI**. The user sees Claude say something like "the tool was denied" or "I'm unable to run that command" with no context about *why*. This is the root cause of the "approval isn't going through" class of bugs — the user doesn't know the approval was never presented to them.

**Files to change:**

### `.claude/hooks/pre-tool-use.mjs` — Notify server on denial

When the hook denies a tool (server error, invalid response, or explicit deny), fire a best-effort notification to the existing `/api/hook-notify` endpoint so the UI can display a system message. The `HttpTransport.notify()` method already exists and is fire-and-forget.

```javascript
// After the catch block (server error) and the invalid-response block:
// Add a notify call before returning the deny decision

async function denyWithNotification(transport, ctx, toolName, toolInput, reason) {
  // Fire-and-forget notification to the UI
  const hubSessionId = ctx.env.hubSessionId;
  if (hubSessionId) {
    transport.notify({
      sessionId: hubSessionId,
      notificationType: 'hook_denial',
      title: `Permission denied: ${toolName}`,
      message: reason,
    });
  }

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
```

Replace the three deny return points in the handler:

1. **Invalid auth (webhook sessions):** `return denyWithNotification(transport, ctx, input.tool_name, input.tool_input, auth.error)`
2. **Invalid server response:** `return denyWithNotification(transport, ctx, input.tool_name, input.tool_input, 'Invalid server response')`
3. **Server error / timeout (catch block):** `return denyWithNotification(transport, ctx, input.tool_name, input.tool_input, \`Server error: ${err.message}\`)`

The existing `/api/hook-notify` endpoint in `server/session-routes.ts` already broadcasts system messages to the session — no server changes needed for the basic notification.

### UI enhancement: Actionable denial messages

When a denial notification arrives, the system message should include guidance on how to grant access. Update the `/api/hook-notify` handler to detect `notificationType: 'hook_denial'` and enrich the message:

**File:** `server/session-routes.ts` — Enhance the hook-notify handler

```typescript
router.post('/api/hook-notify', (req, res) => {
  // ... existing auth + validation ...

  if (notificationType === 'hook_denial') {
    const toolName = req.body.toolName || ''
    const toolInput = req.body.toolInput || {}
    const suggestion = buildAccessSuggestion(toolName, toolInput, session.workingDir)
    const text = `⚠ ${title}: ${message}${suggestion ? `\n${suggestion}` : ''}`
    const msg: WsServerMessage = { type: 'system_message', subtype: 'error', text }
    sessions.addToHistory(session, msg)
    sessions.broadcast(session, msg)
  } else {
    // ... existing notification logic ...
  }

  res.json({ ok: true })
})
```

The `buildAccessSuggestion()` helper generates a CLI command the user can run on their machine to pre-approve the tool:

```typescript
function buildAccessSuggestion(toolName: string, toolInput: Record<string, unknown>, workingDir: string): string {
  // Claude Code's native permission system uses exact-match or pattern rules
  // stored in .claude/settings.local.json under permissions.allow[]
  //
  // Format: "ToolName" for non-Bash tools, "Bash(command)" for exact Bash commands
  // Users can also add to ~/.claude/settings.local.json manually
  //
  // The claude CLI has a built-in way to manage permissions:
  //   claude config add allowedTools "Bash(npm install*)"

  if (toolName === 'Bash') {
    const cmd = String(toolInput.command || '')
    // Derive a safe pattern — use the first token(s) as a prefix
    const firstToken = cmd.split(/\s+/)[0]
    const pattern = `Bash(${firstToken} *)`
    return `💡 To allow this in future, run on your machine:\n\`claude config add allowedTools "${pattern}"\``
  }

  if (['Write', 'Edit', 'WebFetch', 'WebSearch', 'Agent'].includes(toolName)) {
    return `💡 To allow ${toolName} in future, run on your machine:\n\`claude config add allowedTools "${toolName}"\``
  }

  return ''
}
```

### What the user sees

**Before (current):** Claude says "I'm unable to run yarn install because it requires approval that isn't going through." No system message, no context.

**After:** A system message appears in the chat:

```
⚠ Permission denied: Bash: Server error: fetch failed
💡 To allow this in future, run on your machine:
`claude config add allowedTools "Bash(yarn *)"`
```

This gives the user:
1. **Visibility** — they know the approval was blocked, not lost
2. **Actionability** — a copy-pasteable command to permanently allow the tool
3. **Context** — the reason (server error, timeout, auth failure) helps debug

### Note on `claude config` CLI

The `claude config add allowedTools` command is the official Claude Code way to manage permissions. It writes to `.claude/settings.local.json` (user-local, not committed). Key patterns:

| Command | What it allows |
|---|---|
| `claude config add allowedTools "Bash(npm *)"` | Any Bash command starting with `npm` |
| `claude config add allowedTools "Bash(cd /srv/repos/* && *)"` | Commands that cd into any repo |
| `claude config add allowedTools "Write"` | All Write tool calls |
| `claude config add allowedTools "WebSearch"` | All web searches |

For project-scoped permissions (only apply to one repo), add `--project` flag or edit `.claude/settings.local.json` in the project's `.claude/` directory.

---

## Fix 6: Replace exact-command storage with pattern-first approvals

**Problem:** The `repo-approvals.json` file accumulates exact Bash command strings via the "Always Allow" button. Real-world data shows the scale of the problem:

- **270–315 exact commands per repo** for the main project
- **61 unique `gh pr create` strings** (each with different title/body)
- **52 unique `git push` strings** (each with different branch names)
- **64 multi-line commands** stored verbatim (including full commit messages)
- Average **249 characters per stored command**

Meanwhile, the **28–29 patterns** per repo are what actually do the useful matching. The exact commands are almost never matched again (because the next `gh pr create` has a different title), so they just bloat the file with no benefit.

### Root cause

`saveAlwaysAllow()` stores the exact command string for Bash tools. The "Approve Pattern" button only appears when `derivePattern()` returns a safe prefix pattern (e.g., `git diff *`). For commands not in `SAFE_PREFIX_COMMANDS`, there's no pattern option — only exact match.

### Solution: Pattern-first "Always Allow" for Bash

Change the "Always Allow" behavior for Bash commands: instead of storing the exact command, **derive and store a pattern whenever possible**, falling back to exact match only for genuinely unsafe commands.

### `server/approval-manager.ts` — Upgrade `saveAlwaysAllow()`

```typescript
saveAlwaysAllow(workingDir: string, toolName: string, toolInput: Record<string, unknown>): void {
  if (toolName === 'Bash') {
    const cmd = (typeof toolInput.command === 'string' ? toolInput.command : '').trim()

    // Try to derive a pattern first (e.g. "git diff *", "npm run *")
    const pattern = this.derivePattern(toolName, toolInput)
    if (pattern) {
      this.addRepoApproval(workingDir, { pattern })
      console.log(`[auto-approve] saved pattern for repo ${workingDir}: ${pattern}`)
      return
    }

    // For commands with no safe pattern, store exact match
    this.addRepoApproval(workingDir, { command: cmd })
    console.log(`[auto-approve] saved exact command for repo ${workingDir}: ${cmd.slice(0, 80)}`)
  } else {
    this.addRepoApproval(workingDir, { tool: toolName })
    console.log(`[auto-approve] saved tool for repo ${workingDir}: ${toolName}`)
  }
}
```

This single change would have prevented ~90% of the exact command bloat. Most stored commands start with `gh`, `git`, `npm`, `cd`, or other safe prefixes that already have patterns in `SAFE_PREFIX_COMMANDS`.

### Expand `SAFE_PREFIX_COMMANDS` with commonly approved commands

Based on the real-world data, add these missing prefixes:

```typescript
private static readonly SAFE_PREFIX_COMMANDS = new Set([
  // ... existing entries ...

  // Git operations commonly approved
  'git push', 'git remote', 'git cherry-pick', 'git reset',
  'git clean', 'git worktree', 'git archive',

  // GitHub CLI (read-safe operations)
  'gh pr', 'gh api', 'gh repo', 'gh run', 'gh search',
  'gh issue', 'gh release',

  // Package managers
  'yarn', 'pnpm', 'pnpm test', 'pnpm run', 'pnpm install',
  'pnpm --filter', 'pnpm typecheck',
  'bun run', 'bun test', 'bun install',

  // Common dev tools
  'docker', 'docker-compose',
  'pm2',
  'ssh',

  // File inspection (harmless read commands)
  'file', 'du', 'stat', 'tree',
  'basename', 'dirname', 'realpath',
])
```

**Note on `git push` / `git reset` / `ssh`:** These are in `SAFE_PREFIX_COMMANDS` for *pattern derivation*, not for *auto-approval*. Pattern derivation just means "we can safely group `git push origin feat/x` and `git push origin feat/y` into one `git push *` pattern". The user still explicitly approves the pattern — this doesn't bypass the prompt.

### Add compaction for existing commands

Add a one-time migration that runs on startup to compact existing exact commands into patterns:

```typescript
/** Compact exact commands that could be represented by existing patterns. */
private compactExactCommands(): void {
  let totalRemoved = 0
  for (const [dir, entry] of this.repoApprovals) {
    if (entry.commands.size === 0 || entry.patterns.size === 0) continue
    const toRemove: string[] = []
    for (const cmd of entry.commands) {
      // If this command is already matched by an existing pattern, remove it
      for (const pattern of entry.patterns) {
        if (this.matchesPattern(pattern, cmd)) {
          toRemove.push(cmd)
          break
        }
      }
    }
    // Also: if there are 3+ exact commands sharing a safe prefix,
    // create a pattern and remove the exact commands
    const prefixGroups = new Map<string, string[]>()
    for (const cmd of entry.commands) {
      if (toRemove.includes(cmd)) continue
      const prefix = this.commandPrefix(cmd)
      if (prefix && ApprovalManager.SAFE_PREFIX_COMMANDS.has(prefix)) {
        const group = prefixGroups.get(prefix) || []
        group.push(cmd)
        prefixGroups.set(prefix, group)
      }
    }
    for (const [prefix, cmds] of prefixGroups) {
      if (cmds.length >= 3) {
        entry.patterns.add(`${prefix} *`)
        toRemove.push(...cmds)
      }
    }

    for (const cmd of toRemove) entry.commands.delete(cmd)
    totalRemoved += toRemove.length
  }
  if (totalRemoved > 0) {
    console.log(`[auto-approve] compacted ${totalRemoved} exact commands into patterns`)
    this.persistRepoApprovals()
  }
}
```

Call `this.compactExactCommands()` at the end of `restoreRepoApprovalsFromDisk()`.

### UI change: Merge "Always Allow" and "Approve Pattern" buttons

Currently there are two separate buttons. With pattern-first storage, they can be merged:

- **"Always Allow"** → stores pattern when available, exact match otherwise (as above)
- **Remove the separate "Approve Pattern" button** — its behavior is now the default

If the user wants to see what pattern will be stored, show it in the "Always Allow" button tooltip:

```tsx
// In PromptButtons.tsx, for the "Always Allow" button:
title={approvePattern
  ? `Auto-approve: ${approvePattern}`
  : `Auto-approve this exact command`}
```

This simplifies the UI from 4 buttons (Allow / Always Allow / Approve Pattern / Deny) to 3 buttons (Allow / Always Allow / Deny) while being smarter about what gets stored.

---

## Files Changed Summary

| File | Change |
|---|---|
| `src/hooks/usePromptState.ts` | Rewrite: single state → Map-based queue |
| `src/hooks/useChatSocket.ts` | Wire up queue API, fix dismiss routing, update return shape |
| `src/App.tsx` | Consume `activePrompt` + `promptQueueSize` instead of 6 fields |
| `src/components/PromptButtons.tsx` | No changes needed (receives same props, `key` prop handles remount) |
| `server/session-manager.ts` | Remove requestId fallback, add leave grace period + timer field |
| `.claude/hooks/pre-tool-use.mjs` | Add `denyWithNotification()` helper, notify server on all deny paths |
| `server/session-routes.ts` | Enhance `/api/hook-notify` to detect `hook_denial` and append access suggestion |
| `server/approval-manager.ts` | Pattern-first `saveAlwaysAllow()`, expand `SAFE_PREFIX_COMMANDS`, add `compactExactCommands()` |
| `src/components/PromptButtons.tsx` | Remove "Approve Pattern" button, show pattern in "Always Allow" tooltip |

## Test Plan

1. **Queue behavior:** Open a session, trigger two Bash commands in quick succession. Verify both prompts appear sequentially (first one shown, answer it, second appears).
2. **Dismiss filtering:** Let a queued prompt timeout (60s). Verify only that prompt is removed, not the one the user is currently viewing.
3. **Page refresh:** Trigger a Bash approval, refresh the page mid-prompt. Verify the prompt re-appears after reconnect (not silently denied).
4. **No requestId:** Send a `prompt_response` with no `requestId` via devtools WebSocket. Verify it falls through to plain message, not matched to a random approval.
5. **Auto-allow countdown:** Verify the 15s countdown resets correctly when a new prompt becomes active after answering the previous one (guaranteed by `key` prop remount).
6. **Silent denial visibility:** Stop the Codekin server, trigger a Bash command in an active session. Verify the hook denial appears as a system error message in the chat with a `claude config add allowedTools` suggestion.
7. **Access suggestion accuracy:** Trigger denials for Bash, Write, and WebSearch tools. Verify each produces a correct, copy-pasteable `claude config` command.
8. **Pattern-first storage:** Click "Always Allow" on a `git push origin feat/test` command. Verify `repo-approvals.json` stores pattern `git push *`, not the exact command string.
9. **Compaction on startup:** Add 5 exact `gh pr create ...` commands to `repo-approvals.json` manually, restart server. Verify they're compacted into `gh pr *` pattern and exact entries are removed.
10. **UI simplification:** Verify the "Approve Pattern" button is gone and "Always Allow" tooltip shows the pattern that will be stored (e.g., "Auto-approve: git diff *").
