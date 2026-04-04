# Daily Code Review: codekin

**Date**: 2026-04-04
**Branch**: chore/reports-2026-04-01
**Scope**: Last 7 days of commits (2026-03-28 → 2026-04-04)

---

## Overall: GOOD

**0 critical** (C-01 resolved), **7 warnings** (5 carry-overs + 2 new), **5 info** (4 carry-overs + 1 new).

Commit `6ab51f2` (security and code review findings fix) resolved all 3 items flagged as CRITICAL or newly introduced in the previous two cycles. The approvals overhaul (PR #280, commit `6f1a899`) was a large structural change; no new vulnerabilities introduced.

---

## Resolved since 2026-04-03

| ID | Finding | Resolution |
|----|---------|-----------|
| C-01 | Symlink bypass in `/api/clone` bounds check (`upload-routes.ts:286–290`) | Fixed in `6ab51f2`: `realpathSync(REPOS_ROOT)` now used before `startsWith` |
| W-07 | Hardcoded 3-second `setTimeout` before `sendInput()` in `workflow-loader.ts` | Fixed in `6ab51f2`: replaced with `sessions.waitForReady()` listening for `system_init` |
| W-08 | `git stash` + `checkout` concurrency hazard in `save_report` | Fixed in `6ab51f2`: replaced with `git worktree add/remove` per-run isolation |
| —   | Tool I/O debug logs leaked secrets in production | Fixed in `6ab51f2`: all 12 `console.log` call sites gated behind `NODE_ENV !== 'production'` |
| —   | Server started without auth in production | Fixed in `6ab51f2`: exits with error when `AUTH_TOKEN` unset in production |

---

## CRITICAL — 0

No critical findings.

---

## WARNING — 5 carry-overs + 2 new

| ID | Age | File:Line | Finding |
|----|-----|-----------|---------|
| W-01 | 2 weeks | `server/webhook-handler.ts:169` | Actor allowlist `includes()` is case-sensitive. GitHub usernames are case-insensitive (e.g. `Octocat` vs `octocat`). An attacker whose login differs only in case from an allowlisted user would be incorrectly permitted. **Fix:** `.toLowerCase()` both sides before comparison. |
| W-02 | 5 weeks | `server/auth-routes.ts:35` | `/auth-verify` endpoint has no rate limiting. Brute-force of the session token is unbounded. **Fix:** Add `express-rate-limit` middleware (already a dependency via `ws-server.ts`). |
| W-03 | 6 weeks | `server/session-routes.ts:60`, `server/ws-message-handler.ts:28` | `workingDir` accepted from client (POST body / WS message) and passed to `sessions.create()` without `REPOS_ROOT` bounds check. An authenticated user can create a session pointing at any path on the server filesystem (e.g. `/etc`, `/root`). **Fix:** Validate `workingDir` is under an allowed root (home dir or `REPOS_ROOT`) before creating the session. |
| W-04 | 5 weeks | `server/ws-server.ts:375` | `X-Forwarded-For` header trusted unconditionally for client IP logging. In non-proxy deployments this allows spoofing. **Fix:** Only trust the header when `TRUST_PROXY=true` is set in env. |
| W-05 | 4 days | `server/session-manager.ts:599–640` | `leave()` / `delete()` race: if `leave()` sets the grace timer and `delete()` fires before the timer callback runs, the pending-prompt auto-deny fires against a deleted session. The approvals overhaul did not address this. **Fix:** Check session still exists in the grace-timer callback before acting. |
| **W-06** | **4 days** | `server/ws-message-handler.ts` | `get_diff` and `discard_changes` message handlers call async session methods without `.catch()`. Unhandled rejections are silently swallowed. **Fix:** Add `.catch(err => send({ type: 'error', ... }))` to both. |
| **W-09** | **New** | `server/ws-server.ts:440–441` | Post-auth WebSocket rate limit (60 msg/s) silently drops excess messages with no client notification: `return // silently drop`. A large paste or rapid command submission will appear to succeed client-side but be discarded server-side. **Fix:** Send a `{ type: 'error', message: 'Rate limit exceeded' }` frame before returning. |

**W-02, W-03, W-04 are 5–6 weeks old.** These should be assigned to the next milestone — each is a ≤ 5-line fix.

---

## INFO — 4 carry-overs + 1 new

| ID | File:Line | Finding |
|----|-----------|---------|
| I-05 | `src/utils/ccApi.ts` | `authFetch` has no request timeout. A hung server response will stall the caller indefinitely. Consider `AbortSignal.timeout(10_000)`. |
| I-06 | `server/workflow-loader.ts:433` | Module-level `registeredRepoKinds` Set is never cleared. If a workflow `kind` is renamed on disk, the old name is silently skipped until server restart. Low severity but can confuse debugging. |
| I-07 | `server/session-manager.ts:55–58` | `API_RETRY_PATTERNS` uses bare strings `/500/`, `/502/` which match against full error message content, not just HTTP status codes. A response body containing the string "500" would incorrectly trigger a retry. |
| I-08 | `package.json` | TypeScript 6, Vite 8, ESLint 10, jsdom 29 all landed this week. No CI regressions observed yet — continue monitoring for latent type-check or transform regressions in the next 1–2 days. |
| **I-09** | **`server/claude-process.ts`** | **New:** No startup timeout for the Claude CLI process. If the spawned process hangs before emitting `system_init`, the session blocks indefinitely. **Fix:** Add a 30-second timeout that emits an error event if `system_init` is not received. |

---

## Positive

- **`6ab51f2` is an exemplary security fix commit**: targeted, well-scoped, addresses 5 independent issues in a single coherent changeset with clear commit message enumeration.
- **Approvals overhaul (PR #280)**: Significant refactor of `session-manager.ts`, `approval-manager.ts`, and `session-routes.ts`. Code is cleaner post-overhaul; new `_leaveGraceTimer` + `pendingToolApprovals` map pattern correctly handles the approval lifecycle edge cases.
- **`/api/browse-dirs`** (`session-routes.ts:248–264`) already has robust path validation with `realpathSync` + allowedRoots check — the pattern from `6ab51f2` was correctly applied here as well.
- **SQL injection, XSS, command injection** protections remain solid: parameterized queries in `session-archive.ts`, DOMPurify in `MarkdownRenderer.tsx`, `execFileAsync` array args throughout.
- **Zero TODO/FIXME debt** continues.
