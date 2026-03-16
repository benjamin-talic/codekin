# Daily Code Review: codekin

**Date**: 2026-03-16
**Repository**: /srv/repos/codekin
**Branch**: fix/docs-audit-cleanup

---

## Critical (2)

**C1 — UTF-8 multibyte truncation bug in diff-parser.ts (`server/diff-parser.ts:33-36`)**
The 2 MB diff truncation slices raw bytes, not characters:
```typescript
const buf = Buffer.from(raw, 'utf-8')
const sliced = buf.subarray(0, maxBytes).toString('utf-8')
```
If a multibyte character (emoji, CJK, etc.) straddles the byte boundary, `toString('utf-8')` produces a U+FFFD replacement character or corrupts subsequent parsing. Fix: walk back from `maxBytes` to the last ASCII byte or valid UTF-8 lead byte before slicing.

**C2 — discardChanges() path check uses un-normalized cwd (`server/session-manager.ts:1413-1424`)**
`root` is built as `path.resolve(cwd) + path.sep`. If `cwd` already has a trailing separator (e.g. `/repo/`), `root` becomes `/repo//` and the `startsWith` guard can fail for valid paths, allowing the check to pass for out-of-tree paths when it should reject them. Fix: use `path.join(path.resolve(cwd), path.sep)` or `path.resolve(cwd) + '/'` on a normalized value.

---

## Warning (7)

**W1 — Incomplete shell metacharacter denylist in approval-manager.ts (`server/approval-manager.ts:222, 461`)**
`derivePattern()` and `compactExactCommands()` both reject `|;&\`$(){}` but miss `*`, `?`, `[`, `]`, `~`, and newline in one variant. A command like `cat *` or `rm *.log` stores a pattern that matches more than intended. Switch to an allowlist of safe characters (alphanumerics, `-_./`) rather than a denylist.

**W2 — browse-dirs still accepts arbitrary absolute paths (`server/session-routes.ts:183-185`)**
Flagged on 2026-03-15 (W2) as unresolved. `expandTilde()` is applied but no `BROWSE_ROOT` cap is enforced. A valid auth token allows full server directory enumeration. Add a root restriction defaulting to `$HOME` or `REPOS_ROOT`.

**W3 — ExitPlanMode ID mismatch may leave planning_mode permanently set (`server/claude-process.ts:243, 349-355`)**
`pendingExitPlanModeId` is set to `inner.content_block.id || '__pending__'` but the comparison at line 350 uses a `tool_use_id` from the `tool_result` message — these IDs differ in Claude's stream-json protocol. When they fail to match, the `inPlanningMode` flag is never cleared, and every subsequent turn emits `planning_mode: true`.

**W4 — findSessionForClient() is O(n) on every inbound WebSocket message (`server/session-manager.ts:1282-1287`)**
The function iterates all sessions looking for one whose `clients` Set contains the socket. With many concurrent sessions this adds measurable overhead on each message. Fix: maintain a reverse `Map<WebSocket, string>` from socket to session ID, updated on join/leave.

**W5 — broadcast() serializes JSON once per client (`server/session-manager.ts:1268-1279`)**
For a session with 10+ clients, `JSON.stringify(message)` is called individually for each client. Serialize once before the loop.

**W6 — Repo name regex in upload-routes.ts allows .git and multi-segment paths (`server/upload-routes.ts:276-281`)**
Pattern `/^[\w][\w.-]*$/` accepts `.git`, `foo.git`, and single-segment paths with dots. Though only one segment is validated, a directory named `.git` could interfere with the workspace's own git operations. Tighten to deny leading dots and the literal string `git`.

**W7 — Prompts for non-active sessions are silently dropped (`src/hooks/useChatSocket.ts:291-305`)**
When `promptSessionId !== currentSessionId.current` the handler returns early without queuing the prompt anywhere. If the user has multiple sessions open and a background session requests approval, the prompt is lost and the tool times out. The prompt should be queued or held until the session is made active.

---

## Info (7)

| # | Finding |
|---|---------|
| **I1** | `diff-parser.ts` has 0.91% test coverage (only ~2 LOC covered). UTF-8 truncation, binary file detection, rename parsing, and hunk boundary logic are all untested. |
| **I2** | `commit-event-handler.ts` (134 LOC, 5-layer filter chain) and `approval-manager.ts` (484 LOC) have zero tests. These are high-impact paths that change approval behavior. |
| **I3** | `session-routes.ts` (392 LOC REST API), `ws-server.ts` (503 LOC), `auth-routes.ts`, and `upload-routes.ts` all have zero test coverage — the entire HTTP+WS layer is untested. |
| **I4** | `session-manager.ts` branch coverage is 57%. Gaps are concentrated in timeout/stall paths and the auto-restart logic — both are hard to debug in production without test scaffolding. |
| **I5** | `ccApi.ts` auth-failure detection (`checkAuthResponse`) matches on `res.url.includes('/authelia')` — brittle if the auth provider or URL structure changes. Consider checking only the HTTP status code. |
| **I6** | `package-lock.json` still reports version `0.3.7`; `package.json` is `0.4.0` (flagged 2026-03-15, not yet resolved). Run `npm install` at repo root to regenerate. |
| **I7** | `slashCommands.ts:95` — skill content (entire SKILL.md body) is loaded eagerly into the command registry at startup and kept in memory. For large skill definitions this is wasteful; content could be lazy-loaded on first use. |

---

## Spot Review of Recent Changes

- **approval-auto-approve countdown fix (#138, `PromptButtons.tsx`)**: `setInterval` correctly uses a ref to avoid stale closure; countdown fires reliably. No issues.
- **approval waiting-state fix (#136, `useChatSocket.ts`)**: Safety-net `useEffect` and `sessions_updated` pruning correctly sync waiting state. No issues.
- **CSP Google Fonts fix (#135, `ws-server.ts`)**: `fonts.googleapis.com` and `fonts.gstatic.com` added to both `style-src` and `font-src` correctly. No issues.
- **docs-audit workflow (#134, `workflows/docs-audit/`)**: Workflow definition and weekly registration look correct; `fix: register docs-audit.weekly in UI workflow kinds` (#137) properly adds it to the allowed kinds list.
- **folder picker for repos path (#132, `FolderPicker.tsx`)**: Path validation calls `setReposPath` before showing success, with double-save guard. Path traversal to arbitrary FS locations is still possible via this picker (see W2).

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| Warning  | 7 |
| Info     | 7 |

Top action items:
1. Fix UTF-8 truncation in `diff-parser.ts` (C1) — data corruption risk on any diff with non-ASCII paths or content.
2. Normalize `cwd` in `discardChanges()` (C2) — path escape guard can silently fail.
3. Add tests for `diff-parser.ts`, `approval-manager.ts`, and `commit-event-handler.ts` (I1–I2) — these modules have had recent logic changes with no regression coverage.
