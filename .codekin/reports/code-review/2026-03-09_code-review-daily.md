# Daily Code Review: codekin

**Date**: 2026-03-09T05:02:13.749Z
**Repository**: /home/dev/repos/codekin
**Branch**: feat/workflow-list-larger-fonts
**Workflow Run**: d939cce8-e32e-484f-a784-cf420545d8f8
**Session**: 5e7bcfee-6707-4d22-8087-85407e4bf1af

---

I'll start by gathering project structure, recent git history, and key files in parallel.Now let me do deeper reviews of critical areas in parallel.---

# Codekin Code Review — 2026-03-09

**Branch under review:** `feat/workflow-list-larger-fonts` (current) + `main` (last 7 days)  
**Period:** March 2–9, 2026 | **Commits reviewed:** ~120+  
**Test suite:** 32 files, 795 tests passing, 83.5% statement coverage

---

## Critical

### 1. Shell injection pattern in `workflow-loader.ts:208-209`
Two `execSync` calls use shell-interpolated strings instead of `execFileSync` with argument arrays:
```typescript
const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: repoPath, ... })
const lastCommit = execSync('git log -1 --oneline', { cwd: repoPath, ... })
```
While the commands are hardcoded, `repoPath` flows from user input. The rest of the file correctly uses `execFileSync` (line 213). **Fix: switch to `execFileSync` with array args.**

### 2. SSRF gaps in `stepflow-handler.ts:427-441`
Callback URL validation blocks IPv4 private ranges but misses:
- IPv6 link-local (`fe80::/10`) and unique-local (`fc00::/7`) addresses
- DNS rebinding attacks (no resolve-time validation)
- `allowedCallbackHosts` can be empty, allowing any external URL

### 3. WebSocket auth fails open — `ws-server.ts:66-67`
```typescript
function verifyToken(token: string | undefined): boolean {
  if (!authToken) return true  // No auth configured → accept all
  return token === authToken   // Not timing-safe
}
```
When no token is configured, all connections are accepted. Comparison is also vulnerable to timing attacks. **Fix: fail closed when no token is set; use `crypto.timingSafeEqual`.**

---

## Warning

### 4. Race condition in auto-join logic — `App.tsx:156-160`
`autoJoinedRef` is set to `true` on first join but never reset when `activeSessionId` changes. Users navigating back to a previous session won't auto-rejoin.

### 5. Upload failure silently drops files — `App.tsx:372-381`
When `Promise.all()` rejects during file upload, pending files are cleared from state. The error toast only shows for 3 seconds. **Fix: preserve pending files on failure so users can retry.**

### 6. Settings API errors silently swallowed — `Settings.tsx:115,146`
```typescript
setSupportProvider(settings.token, provider).catch(() => {})
setRetentionDaysApi(settings.token, days).catch(() => {})
```
Users get no feedback when settings fail to save.

### 7. Webhook signature not enforced at startup — `webhook-handler.ts:120-121`
When `GITHUB_WEBHOOK_ENABLED=true` but `GITHUB_WEBHOOK_SECRET` is unset, the server logs a warning and continues. **Should exit with error to prevent unsigned webhook acceptance.**

### 8. Path traversal edge case — `workflow-loader.ts:201-204`
`resolve()` doesn't follow symlinks. A path like `/srv/repos-attacker/...` would pass the `startsWith(REPOS_ROOT)` check if REPOS_ROOT is `/srv/repos`. **Fix: use `realpathSync` and append `path.sep` to the prefix check.**

### 9. Accessibility gaps — `LeftSidebar.tsx`
- Icon-only buttons (theme toggle, logout) lack `aria-label`
- Repo delete uses `<span onClick>` instead of `<button>` (line 548)
- No keyboard accessibility for several interactive elements

### 10. `workflow-loader.ts` has only 35% test coverage
This is the lowest-covered file in the project and handles critical workflow discovery, MD parsing, and git operations.

---

## Info

### 11. Express 4.x is in maintenance mode
`server/package.json` pins Express `^4.21.0`. Express 5 is available (5.2.1). Plan migration when convenient — coordinate with Multer 2.x upgrade (currently on legacy 1.4.5-lts).

### 12. ESLint exhaustive-deps disabled in 10+ locations
Files: `App.tsx` (8 instances), `ChatView.tsx`, `LeftSidebar.tsx`, `WorkflowsView.tsx`. Most lack inline comments explaining why. This makes effect dependencies fragile and hides potential bugs.

### 13. No component-level tests
All 28 React components have 0% test coverage. Only hooks have tests. The 83.5% overall coverage is entirely from server + hook tests.

### 14. Untested server routes
`auth-routes.ts`, `session-routes.ts`, `upload-routes.ts`, `webhook-routes.ts`, `stepflow-handler.ts` — all HTTP route handlers lack test files. These are the primary attack surface.

### 15. API keys passed via environment to child processes — `ws-server.ts:82-93`
`GEMINI_API_KEY`, `OPENAI_API_KEY`, and other secrets are forwarded to Claude child processes via env vars. Acceptable for single-user deployment but would need secrets management for multi-tenant.

### 16. Current branch change is low-risk
The `feat/workflow-list-larger-fonts` branch modifies only `WorkflowsView.tsx` — 36 lines changed, all font-size class updates (e.g., `text-sm` → `text-base`). No logic changes, no new risks.

---

## Coverage Summary

| Area | Statement Coverage | Gaps |
|------|-------------------|------|
| Server (overall) | ~84% | `workflow-loader.ts` at 35%, `session-manager.ts` at 72% |
| Frontend hooks | ~90% | `useTentativeQueue`, `useRepos`, `useWorkflows` untested |
| Frontend components | **0%** | All 28 components untested |
| Dependencies | 0 vulnerabilities | Express 4.x end-of-life, Multer legacy LTS |

## Top 5 Action Items

1. **Fix shell injection** in `workflow-loader.ts:208-209` — switch `execSync` → `execFileSync`
2. **Fix auth fail-open** in `ws-server.ts:66-67` — fail closed + timing-safe compare
3. **Block IPv6 private ranges** in `stepflow-handler.ts` SSRF protection
4. **Add tests for route handlers** — `auth-routes.ts`, `session-routes.ts`, `stepflow-handler.ts`
5. **Increase `workflow-loader.ts` coverage** from 35% to at least 70%