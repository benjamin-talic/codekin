# Complexity Report: codekin

**Date**: 2026-03-09T06:47:36.401Z
**Repository**: /home/dev/repos/codekin
**Branch**: fix/code-review-security-fixes
**Workflow Run**: dc7a4954-9d77-4d5e-aff4-e74f66d1102a
**Session**: 9774d026-662d-4562-96ac-d5ce7bbf4d9d

---

Now let me read the largest files to assess internal complexity.Now let me read the session-manager.ts fully to assess its complexity, since it was truncated.Now I have enough data to produce the report.

## Summary

**Overall Complexity Rating: Medium**

| Metric | Value |
|--------|-------|
| Total source files | 100 |
| Total lines of code | ~27,200 (including tests) |
| Largest file (non-test) | `server/session-manager.ts` — 1,640 lines |
| Deepest nesting | 4 levels (`session-manager.ts:wireClaudeEvents`, `useChatSocket.ts:ws.onmessage`) |
| Most complex function | `SessionManager.wireClaudeEvents` — high event count, nested state machines |
| Files over 300 lines | 13 (non-test) |

The codebase is moderately complex for its size. The server-side session manager is the primary complexity hotspot — it is a god object responsible for session lifecycle, process management, auto-approval logic, persistence, session naming, and prompt routing. The frontend hook `useChatSocket` mirrors this complexity as the client-side counterpart, managing 20+ state variables and a large message switch. Most other files are well-scoped.

## Largest Files

| File | Lines | Primary Responsibility | Refactor Priority |
|------|-------|----------------------|-------------------|
| `server/session-manager.ts` | 1,640 | Session lifecycle, process mgmt, approvals, persistence, naming | **High** |
| `src/hooks/useChatSocket.ts` | 735 | WebSocket connection, message processing, prompt state | **High** |
| `src/components/WorkflowsView.tsx` | 758 | Workflow card layout, run history, activity feed | Medium |
| `src/components/LeftSidebar.tsx` | 688 | Repo tree navigation, archived sessions, modules | Medium |
| `server/workflow-engine.ts` | 654 | Workflow execution, SQLite persistence, cron scheduling | Low |
| `src/App.tsx` | 569 | Root component, session/repo orchestration | Medium |
| `server/claude-process.ts` | 566 | Claude CLI child process, stream-json parsing | Low |
| `server/stepflow-handler.ts` | 553 | Stepflow webhook processing, workspace lifecycle | Low |
| `server/ws-server.ts` | 520 | Express server, WebSocket handling, startup | Medium |
| `server/workflow-loader.ts` | 489 | Workflow definition loading from markdown | Low |
| `src/components/AddWorkflowModal.tsx` | 472 | Workflow creation form | Low |
| `src/components/ChatView.tsx` | 441 | Chat message rendering | Low |
| `server/webhook-handler.ts` | 434 | GitHub webhook event processing | Low |
| `src/components/ApprovalsPanel.tsx` | 407 | Auto-approval management UI | Low |
| `server/stepflow-types.ts` | 308 | Type definitions for stepflow | Low |

## Most Complex Functions

| Location | Est. Complexity | Issue Description | Refactor Suggestion |
|----------|----------------|-------------------|---------------------|
| `session-manager.ts:wireClaudeEvents` (L639–778) | High (CC~18) | 140-line method with 12 event handler registrations, each containing conditional logic and state mutations. Acts as a routing hub between ClaudeProcess events and session state. | Extract each event handler into a named private method (`onText`, `onToolActive`, `onPrompt`, etc.) |
| `useChatSocket.ts:ws.onmessage` (L345–548) | High (CC~20) | 200-line switch statement with 18 cases, inline state updates across 20+ useState hooks. Duplicates logic from `processMessage` in some branches. | Consolidate into a `useReducer` pattern; extract message-type handlers |
| `session-manager.ts:sendPromptResponse` (L983–1019) | Medium-High (CC~10) | Routes through 3 distinct approval paths (tool approval, control request, fallback) with nested conditional logic and multiple Map lookups | Extract each path into its own method (already partially done) |
| `session-manager.ts:requestToolApproval` (L1112–1190) | Medium-High (CC~8) | 80-line method mixing auto-approval checks, promise construction, timeout handling, and UI broadcasting. Complex nested callback structure. | Extract auto-approval check and prompt construction into helpers |
| `session-manager.ts:handleClaudeResult` (L785–848) | Medium (CC~8) | Nested conditionals for API retry logic, session naming triggers, and result broadcasting | Extract retry logic into a separate `handleApiRetry` method |
| `claude-process.ts:handleStreamEvent` (L215–293) | Medium (CC~10) | 3-level switch with nested tool tracking, thinking block state, and planning mode detection | Clean but could benefit from handler-per-block-type extraction |
| `App.tsx:App` (L37–569) | Medium (CC~6) | 530-line component with 20+ hooks, callbacks, and effects. Not deeply nested but very wide — difficult to scan. | Extract session management logic into a custom hook (`useSessionManager`) |
| `webhook-handler.ts:handleWebhook` (L109–269) | Medium (CC~10) | 160-line method with 8 sequential validation/filter stages, each with early return | Structure is actually good (guard clauses), but method is long |
| `stepflow-handler.ts:handleWebhook` (L195–333) | Medium (CC~8) | Similar to webhook-handler — 8 sequential validation stages | Same pattern; could share validation pipeline with webhook-handler |
| `LeftSidebar.tsx:RepoSection` (L453–687) | Medium (CC~6) | 235-line component with inline editing state, archive fetching, and approval panels. Renders deeply nested JSX. | Extract archive section and editing controls into sub-components |

## Coupling & Cohesion Issues

### 1. `SessionManager` is a God Object
**File:** `server/session-manager.ts`
**Issue:** This 1,640-line class handles 8+ distinct responsibilities: session CRUD, Claude process lifecycle, auto-approval registry, persistence (sessions + approvals), session naming via AI, prompt routing (3 approval paths), stall detection, and API error retry logic. It has 14 imports and exposes internal state (`_serverPort`, `_authToken`, `_globalBroadcast`) as public fields.
**Fix:** Extract into focused modules: `ApprovalManager` (approval logic + persistence), `SessionNaming` (AI-powered naming), `SessionPersistence` (disk read/write), keeping `SessionManager` as a thin coordinator.

### 2. `WebhookHandler` and `StepflowHandler` Structural Duplication
**Files:** `server/webhook-handler.ts`, `server/stepflow-handler.ts`
**Issue:** Both handlers implement nearly identical patterns: event ring buffer, processing watchdog, HMAC signature verification, concurrency cap, workspace creation, session spawning, and status tracking. The overall structure is copy-pasted with minor differences.
**Fix:** Extract a shared `WebhookHandlerBase` class or composition utilities for event tracking, concurrency management, and workspace lifecycle.

### 3. `useChatSocket` Hook Does Too Much
**File:** `src/hooks/useChatSocket.ts`
**Issue:** Manages WebSocket connection, reconnection with backoff, message processing, streaming text batching, 10+ prompt-related state variables, session restore, and auth checking. Returns 20+ values from a single hook.
**Fix:** Split into `useWebSocketConnection` (connection lifecycle), `useChatMessages` (message processing/batching), and `usePromptState` (prompt-related state).

### 4. `ws-server.ts` Orchestration Sprawl
**File:** `server/ws-server.ts`
**Issue:** 520-line top-level module that wires together 10+ services (SessionManager, WebhookHandler, StepflowHandler, WorkflowEngine, 5 route modules) with inline CLI arg parsing and WebSocket message routing. No test coverage possible for the wiring logic.
**Fix:** Extract the WebSocket message handler into a `WsMessageRouter` class; move CLI arg parsing to a `config` module.

### 5. Duplicated Message Processing Logic
**Files:** `src/hooks/useChatSocket.ts` (lines 40–113 and 129–200)
**Issue:** `processMessage()` and `rebuildFromHistory()` implement the same message-type switch with the same logic — one immutably (for real-time) and one mutably (for bulk replay). Any new message type requires updating both.
**Fix:** Unify into a single processing function parameterized by mutation strategy, or use a builder class that can operate in both modes.

## Refactoring Candidates

1. **Split `SessionManager` into focused modules**
   - **Location:** `server/session-manager.ts`
   - **Problem:** 1,640-line god object with 8+ responsibilities, making it difficult to test, reason about, or modify safely.
   - **Approach:** Extract `ApprovalManager` (~200 lines: checkAutoApproval, save/remove/persist approvals), `SessionNaming` (~150 lines: getNamingModel, executeSessionNaming, scheduling), `SessionPersistence` (~180 lines: persist/restore sessions and approvals). Keep SessionManager as coordinator.
   - **Effort:** Large

2. **Extract `usePromptState` from `useChatSocket`**
   - **Location:** `src/hooks/useChatSocket.ts`
   - **Problem:** 10 prompt-related useState hooks (promptOptions, promptQuestion, multiSelect, promptRequestId, promptType, promptQuestions, approvePattern, plus clearPromptState) clutter the main hook.
   - **Approach:** Create `usePromptState()` hook that returns `{ state, setFromMessage, clear }` and handles all prompt state transitions.
   - **Effort:** Small

3. **Unify `processMessage` and `rebuildFromHistory`**
   - **Location:** `src/hooks/useChatSocket.ts` (lines 40–200)
   - **Problem:** ~160 lines of duplicated switch logic that must be kept in sync.
   - **Approach:** Create a `MessageReducer` class with `apply(msg)` that mutates internal state, then wrap with immutable/mutable strategies.
   - **Effort:** Small

4. **Extract shared `WebhookHandlerBase`**
   - **Location:** `server/webhook-handler.ts`, `server/stepflow-handler.ts`
   - **Problem:** ~150 lines of duplicated infrastructure (event ring buffer, watchdog, status updates, concurrency cap).
   - **Approach:** Create `BaseWebhookHandler` with event recording, watchdog timer, concurrency check, and workspace lifecycle. Subclasses implement only payload validation and prompt building.
   - **Effort:** Medium

5. **Extract session orchestration from `App.tsx`**
   - **Location:** `src/App.tsx`
   - **Problem:** 530-line root component with 15+ useCallback handlers for session management (select, delete, open, repo switch), making it hard to follow the render tree.
   - **Approach:** Extract `useSessionOrchestration(sessions, chatSocket)` custom hook that encapsulates all session switching/creation/deletion logic, returning only the handlers App needs.
   - **Effort:** Medium

6. **Extract `RepoSection` from `LeftSidebar`**
   - **Location:** `src/components/LeftSidebar.tsx` (lines 453–687)
   - **Problem:** 235-line inline component with its own state (editing, archive fetching, approvals panel). Defined inside the same file as the parent, creating a large single file.
   - **Approach:** Move `RepoSection` to its own file `RepoSection.tsx`. Extract the archive preview section into `InlineArchive.tsx`.
   - **Effort:** Small

7. **Extract `WorkflowRow` and sub-components from `WorkflowsView`**
   - **Location:** `src/components/WorkflowsView.tsx`
   - **Problem:** 758-line file with 10 components defined inline. While individually simple, the file is hard to navigate.
   - **Approach:** Move `MiniRunRow`, `RunDetail`, `StepCard`, `RepoGroup`, and `ActivityRow` into a `workflows/` subdirectory.
   - **Effort:** Small

8. **Reduce `ws-server.ts` to pure wiring**
   - **Location:** `server/ws-server.ts`
   - **Problem:** WebSocket message handling is inline (120-line switch), CLI args parsed inline, shutdown handlers duplicated.
   - **Approach:** Extract `WsMessageRouter` class that takes `SessionManager` and handles the message switch. Merge duplicated SIGTERM/SIGINT handlers. Move CLI arg parsing into `config.ts`.
   - **Effort:** Small