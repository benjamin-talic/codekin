# Daily Code Review: codekin

**Date**: 2026-04-05T04:04:45.507Z
**Repository**: /srv/repos/codekin
**Branch**: chore/reports-2026-04-05
**Workflow Run**: b700e0c1-a5a5-456c-b392-18557205e8bf
**Session**: 326481f9-ad2e-4d4d-ac6c-dae6907f1feb

---

Good overview. Now let me do a deeper code-level review of the critical files.Now let me check the remaining audit gaps.Now I have enough to write the complete review. Let me compile it.

---

## Daily Code Review — 2026-04-05

**Branch:** `chore/reports-2026-04-05` | **Period:** 2026-03-29 → 2026-04-05

---

### Recent Activity Summary

14 commits in 7 days. Key work:
- **Security hardening** (W-01/W-02/W-03) — webhook/WS handler fixes
- **Approvals architecture overhaul** — parity with native Claude CLI permissions
- **Subscription auth support** — unblocks OAuth/Max plan users
- **Long session stability + orchestrator passivity fix**
- **Dependency bump** — TypeScript 6, Vite 8, ESLint 10

Tests: 1,328 passing, 84.20% statement coverage (+9 pp week-over-week).

---

### CRITICAL

_None._

---

### WARNING

**W-1 · File upload MIME bypass (L5 from 2026-04-02 audit — unaddressed)**
`server/upload-routes.ts:176`

```ts
const allowed = ALLOWED_MIME_TYPES.includes(file.mimetype) || ALLOWED_EXTENSIONS.includes(ext)
```

The `||` logic means either MIME type OR extension is sufficient to pass. A client can:
- Name a file `evil.exe` but set `Content-Type: image/png` → extension fails, MIME passes ✓
- Name a file `payload.md` but set `Content-Type: application/javascript` → MIME fails, extension passes ✓

**Fix:** Require both conditions, or map each allowed extension to its expected MIME type and validate the pair:

```ts
const extAllowed = ALLOWED_EXTENSIONS.includes(ext)
const mimeAllowed = ALLOWED_MIME_TYPES.includes(file.mimetype)
const allowed = extAllowed && mimeAllowed
```

---

**W-2 · Two unguarded `console.log` calls in production (partial M3 from 2026-04-02 audit)**
`server/claude-process.ts:237, 241`

The `TOOL_DEBUG` guard properly protects tool I/O content logs (lines 277–475). However two diagnostic logs above the switch statement are unconditionally emitted in production:

```ts
// line 237 — fires for every non-stream event (system, assistant, user, result, ...)
console.log(`[event] type=${event.type} subtype=${subtype || '-'}`)

// line 241 — fires for truly unknown protocol messages, dumps up to 300 chars of raw event JSON
console.log(`[event-unhandled] type=${event.type} data=${JSON.stringify(event).slice(0, 300)}`)
```

Line 237 is low-risk (only logs type/subtype). Line 241 is higher risk — it dumps raw event payload data for any novel message Claude sends, inconsistent with the `TOOL_DEBUG` contract. Both should be gated:

```ts
if (TOOL_DEBUG && event.type !== 'stream_event') { ... }
if (TOOL_DEBUG && !['system', ...].includes(event.type)) { ... }
```

---

**W-3 · Stepflow enabled without secret: warn-only, should be louder (M2 from 2026-04-02 audit — unaddressed)**
`server/ws-server.ts:186-190`

```ts
if (stepflowConfig.enabled) {
  if (!stepflowConfig.secret) {
    console.warn('[stepflow] STEPFLOW_WEBHOOK_SECRET not set — signature validation will fail')
  }
```

Unlike the GitHub webhook handler (which calls `process.exit(1)` when enabled without a secret at line 168), Stepflow only warns. All incoming Stepflow webhooks will be silently rejected by HMAC validation with no clear feedback. This is fail-secure but operationally misleading — operators enabling the integration won't realize it's non-functional.

Recommend either matching the GitHub handler's `process.exit(1)` pattern, or at minimum elevating to `console.error`.

---

**W-4 · `session-manager.ts` test coverage: 58.26% — lowest in the codebase**

This is the core session lifecycle module (create, start, stop, worktree, approvals, persistence). At 58.26% coverage, the untested ~42% represents the highest unmitigated risk surface in the repo. Specific gaps likely in:
- Worktree creation/cleanup paths (`createWorktree`, `cleanupWorktree`)
- Session restart/restore after server restart
- Approval resolution edge cases under concurrent requests

Suggest prioritizing this module in the next test coverage sprint.

---

### INFO

**I-1 · `src/lib/ccApi.ts` — 6 exported functions with no frontend consumers**

`getOrchestratorChildren`, `spawnOrchestratorChild`, `queryOrchestratorMemory`, `getOrchestratorTrust`, `getOrchestratorDashboard`, `getOrchestratorNotifications` are exported but not imported anywhere in `src/`. If these are scaffolded for planned UI panels, add a comment; otherwise they're dead weight raising the maintenance surface.

**I-2 · Unused type definitions**
`src/types.ts`: `DocsPickerProps` and `MobileProps` are defined but unused. Safe to remove.

**I-3 · Orphan component**
`src/components/CustomWorkflowGuide.tsx` has no importers. Review for removal or add to routing.

**I-4 · `server/tsconfig.json` missing `erasableSyntaxOnly: true`**
Minor drift vs. `tsconfig.app.json`. Safe to add; prevents TypeScript 5.5+ erasable syntax issues in server code.

**I-5 · `package.json` missing `engines` field**
Docs reference Node ≥ 20. Adding `"engines": { "node": ">=20.0.0" }` gives `npm install` a clear compatibility signal.

**I-6 · `docs/GITHUB-WEBHOOKS-SPEC.md` stale**
Actor allowlist feature (PR #261, merged 2026-03-29) is not reflected. Docs are ~1 week behind the implementation.

---

### What's Well Done

- **M1 fixed**: `ws-server.ts:71-77` now exits in production when no auth token is configured.
- **workingDir validation**: Both `session-routes.ts:62-71` (REST) and `ws-message-handler.ts:29-42` (WS) now bounds-check paths against home/REPOS_ROOT with `realpathSync`. Complete coverage of both entry points.
- **Env inheritance** (`claude-process.ts:134-147`): Full parent env passthrough with targeted exclusion of `ANTHROPIC_API_KEY`/`CLAUDE_CODE_API_KEY` is cleaner and more robust than the previous allowlist-only approach.
- **Startup timeout** bumped to 60s: sensible given subscription auth cold-start latency.
- **Subscription auth detection** at startup (`ws-server.ts:132-143`): gracefully handles Max plan users without an API key.
- **TOOL_DEBUG gating**: Tool input/output content logs (the actual user data) are correctly gated by `TOOL_DEBUG = process.env.NODE_ENV !== 'production'`.
- **Timing-safe token comparison** (`ws-server.ts:80-87`): SHA-256 hash + `timingSafeEqual` is correct.

---

### Action Items (Priority Order)

| Priority | Item | Location |
|---|---|---|
| **High** | Fix MIME upload check: `||` → `&&` | `server/upload-routes.ts:176` |
| **High** | Gate lines 237/241 behind `TOOL_DEBUG` | `server/claude-process.ts:237,241` |
| **Medium** | Elevate/exit for Stepflow-enabled-without-secret | `server/ws-server.ts:186-190` |
| **Medium** | Expand `session-manager.ts` test coverage to ≥80% | `server/session-manager.ts` |
| **Low** | Add comment or remove 6 dead ccApi orchestrator exports | `src/lib/ccApi.ts` |
| **Low** | Remove `DocsPickerProps`, `MobileProps` | `src/types.ts` |
| **Low** | Review/remove `CustomWorkflowGuide.tsx` | `src/components/` |
| **Low** | Add `erasableSyntaxOnly` to server tsconfig | `server/tsconfig.json` |
| **Low** | Add `engines` field to `package.json` | `package.json` |
| **Low** | Update GitHub Webhooks spec for actor allowlist | `docs/GITHUB-WEBHOOKS-SPEC.md` |