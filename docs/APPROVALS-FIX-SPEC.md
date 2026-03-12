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

## Files Changed Summary

| File | Change |
|---|---|
| `src/hooks/usePromptState.ts` | Rewrite: single state → Map-based queue |
| `src/hooks/useChatSocket.ts` | Wire up queue API, fix dismiss routing, update return shape |
| `src/App.tsx` | Consume `activePrompt` + `promptQueueSize` instead of 6 fields |
| `src/components/PromptButtons.tsx` | No changes needed (receives same props, `key` prop handles remount) |
| `server/session-manager.ts` | Remove requestId fallback, add leave grace period + timer field |

## Test Plan

1. **Queue behavior:** Open a session, trigger two Bash commands in quick succession. Verify both prompts appear sequentially (first one shown, answer it, second appears).
2. **Dismiss filtering:** Let a queued prompt timeout (60s). Verify only that prompt is removed, not the one the user is currently viewing.
3. **Page refresh:** Trigger a Bash approval, refresh the page mid-prompt. Verify the prompt re-appears after reconnect (not silently denied).
4. **No requestId:** Send a `prompt_response` with no `requestId` via devtools WebSocket. Verify it falls through to plain message, not matched to a random approval.
5. **Auto-allow countdown:** Verify the 15s countdown resets correctly when a new prompt becomes active after answering the previous one (guaranteed by `key` prop remount).
