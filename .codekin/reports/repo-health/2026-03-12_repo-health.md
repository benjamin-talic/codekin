# Repository Health Report — codekin

**Date**: 2026-03-12
**Branch assessed**: `main`
**Last tag**: `v0.3.7` (2026-03-11)
**Commits since tag**: 16 (all on main, post-tag feature additions)

---

## Summary

**Overall Health: Good**

Codekin is a healthy, actively developed project with strict TypeScript, zero TODO/FIXME debt, and a well-structured test suite. The main concerns are: (1) the CHANGELOG is missing the `v0.3.7` entry and all subsequent post-tag commits on `main`; (2) a large number of merged remote branches have not been cleaned up; (3) two orphaned unmerged branches with significant main-branch divergence pose future merge risk; and (4) two dependencies have unknown license metadata.

| Metric | Status |
|---|---|
| Dead code items | 2 flagged (test-only exports, possible orphan) |
| TODO/FIXME debt | **0** (clean) |
| Config issues | 0 critical, 1 minor note |
| License concerns | 2 unknown licenses (busboy, streamsearch) |
| Doc drift items | 2 (CHANGELOG missing v0.3.7+; post-tag features undocumented) |
| Stale branches (30d) | 0 truly stale; **29 merged branches** not yet deleted from remote |
| Unmerged open branches | 8 (5 with unique commits ahead of main) |
| Open PRs | 1 (PR #76, 2 days old, no review yet) |
| Stuck PRs (>7d) | 0 |

---

## Dead Code

The project enforces `noUnusedLocals: true` and `noUnusedParameters: true` in all tsconfigs, so genuine unused locals are caught at build time. The items below are patterns that TypeScript cannot catch because they cross module or package boundaries.

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `server/webhook-github.ts` | `_setGhRunner`, `_resetGhRunner` | Test-only exports (underscore prefix) | Acceptable as-is; consider moving into a test-only module or using `vi.mock` instead of exporting test seams |
| `src/lib/deriveActivityLabel.ts` | (all exports) | Possible orphan — no import found in grep scan | Verify it is imported; if not, remove or consolidate into `workflowHelpers.ts` |
| `src/hooks/useRepos.ts` → `RepoGroup` | `RepoGroup` interface | Name collision with `src/components/workflows/RepoGroup.tsx` component | Low risk; rename the interface to `RepoGroupData` or `GroupedRepo` to avoid confusion |

**Note**: No orphan files were found among server modules; all server-side modules are imported by either `ws-server.ts` or a route factory. Full import-graph tracing was not performed — the TypeScript compiler is the authoritative source for unused exports within the project.

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments were found in any `.ts`, `.tsx`, `.js`, or `.jsx` source file.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | — | — | — | — |

**Summary**: 0 total · 0 TODO · 0 FIXME · 0 HACK · 0 stale

> A stale TODO that appeared in `server/ws-server.ts:418` (`// TODO: track usage`) as of the 2026-03-08 assessment has since been resolved.

---

## Config Drift

All configs are well-maintained. No critical drift found.

| Config file | Setting | Current value | Recommended value | Verdict |
|---|---|---|---|---|
| `tsconfig.app.json` | `strict` | `true` | `true` | ✅ |
| `tsconfig.app.json` | `noUnusedLocals` | `true` | `true` | ✅ |
| `tsconfig.app.json` | `noUnusedParameters` | `true` | `true` | ✅ |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | Project choice (TypeScript 5.5+) | ✅ — intentional for native TS support readiness |
| `tsconfig.app.json` | `target` | `ES2022` | `ES2022`+ | ✅ |
| `server/tsconfig.json` | `strict` | `true` | `true` | ✅ |
| `server/tsconfig.json` | `moduleResolution` | `NodeNext` | `NodeNext` (ESM Node) | ✅ |
| `tsconfig.node.json` | `target` | `ES2023` | `ES2022`+ | ✅ |
| `.prettierrc` | `semi` | `false` | Project preference | ✅ |
| `.prettierrc` | `printWidth` | `120` | 80–120 | ✅ |
| `eslint.config.js` | TypeScript strict rules | Enabled (`@typescript-eslint/recommended-type-checked`) | Enabled | ✅ |
| `eslint.config.js` | React hooks rules | Enabled | Enabled | ✅ |
| `vite.config.ts` | Dev proxy `/cc → :32352` | Present | — | ✅ matches CLAUDE.md port |

**Minor note**: `tsconfig.app.json` excludes `src/**/*.test.ts` and `src/**/*.test.tsx` from the main build, but `vitest.config.ts` governs test compilation independently. This split is intentional and correct, but means test files are compiled with vitest's own type environment rather than the strict app tsconfig. Worth verifying no type divergence exists between environments.

---

## License Compliance

Project license: **MIT**

### License Summary Table

| License | Count | Risk |
|---|---|---|
| MIT | 513 | ✅ None |
| Apache-2.0 | 33 | ✅ None |
| ISC | 23 | ✅ None |
| MPL-2.0 | 12 | ⚠️ Weak copyleft (file-level); no spreading to MIT project code |
| BSD-3-Clause | 9 | ✅ None |
| BSD-2-Clause | 8 | ✅ None |
| BlueOak-1.0.0 | 4 | ✅ Permissive |
| MIT-0 | 2 | ✅ None |
| **UNKNOWN** | **2** | **❌ Investigate** |
| CC-BY-4.0 | 1 | ⚠️ Content license; typically applies to docs/assets, not code |
| CC0-1.0 | 1 | ✅ Public domain |
| Python-2.0 (PSF) | 1 | ✅ Permissive |
| 0BSD | 1 | ✅ None |
| (AFL-2.1 OR BSD-3-Clause) | 1 | ✅ None |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ None |
| (MIT OR WTFPL) | 1 | ✅ None |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ None |

### Flagged Dependencies

| Package | License in lock file | Action |
|---|---|---|
| `node_modules/busboy` | UNKNOWN | Verify: busboy is MIT-licensed; the `license` field is missing from its `package-lock.json` entry. Confirm by reading `node_modules/busboy/LICENSE`. |
| `node_modules/streamsearch` | UNKNOWN | Same as above — transitive dependency of busboy. Both are well-known MIT packages. Missing field is the issue, not the actual license. |

**MPL-2.0 note**: The 12 MPL-2.0 packages (likely `@mozilla/readability` and related Mozilla tools) use file-level copyleft. Since codekin does not modify these packages' source files, there is no obligation to release codekin under MPL. This is acceptable for an MIT project.

---

## Documentation Freshness

### CHANGELOG Drift — High Priority

The CHANGELOG (`CHANGELOG.md`) has not been updated past `v0.3.6`. The `v0.3.7` tag was created on 2026-03-11, but:
1. **`v0.3.7` has no CHANGELOG entry** — the version bump commit (`Bump version to 0.3.7`) is not accompanied by a CHANGELOG section.
2. **16 commits landed on `main` after the v0.3.7 tag**, representing at least 6 discrete features/fixes that are undocumented.

### API Docs Freshness

| Area | Last changed | Docs updated? | Notes |
|---|---|---|---|
| `src/types.ts` — `WsServerMessage` | 2026-03-11 (`image` event type added) | ⚠️ `docs/stream-json-protocol.md` may not reflect `image` event | Verify image event is covered in protocol spec |
| `server/commit-event-handler.ts` | 2026-03-11 (new) | ⚠️ No dedicated docs for commit-review event architecture | New event-driven dispatch system has no doc coverage |
| Cross-repo auto-approval (`approval-manager.ts`) | 2026-03-11 (new) | ⚠️ Not described in `docs/FEATURES.md` | New feature added without doc update |
| `server/workflow-loader.ts` — commit-review kind | 2026-03-11 (new) | ⚠️ `docs/WORKFLOWS.md` lists 6 built-in workflows; commit-review is now a 7th | Needs a new entry in WORKFLOWS.md |

### README Drift

| README claim | Actual state | Verdict |
|---|---|---|
| Install: `curl -fsSL codekin.ai/install.sh \| bash` | `install.sh` exists at repo root | ✅ |
| Scripts: `npm run dev`, `npm run build`, `npm test`, `npm run test:watch`, `npm run lint` | All present in `package.json` | ✅ |
| Port 32352 mentioned in CLAUDE.md | Matches `server/config.ts` `PORT` | ✅ |
| `src/types.ts` as shared types file | Still accurate | ✅ |
| Fonts: Inconsolata, Lato | Present in `src/index.css` | ✅ |

No README drift found. The README and CONTRIBUTING.md accurately reflect the current project structure.

---

## Draft Changelog

This covers commits since `v0.3.7` (2026-03-11) through 2026-03-12. All commits are on `main`.

```markdown
## [Unreleased] — since v0.3.7

### Features
- Add `commit-review` as a new event-driven workflow kind in the Workflows UI
- Add `commit-review` workflow definition (built-in `.md` workflow spec)
- Add commit-review event dispatcher: trigger event-driven workflows on commit events via new `commit-event-handler` architecture
- Add cross-repo auto-approval inference: tool approvals from one repo session are carried over to matching repos automatically

### Fixes
- Fix missing approval prompts for WebSearch, WebFetch, Agent, and other tools that were silently auto-approved via the `control_request` fallback path, bypassing the UI approval popup
- Fix AskUserQuestion handling: forward malformed questions (missing/empty) as generic `control_request` instead of silently returning (which caused CLI hangs); preserve explicit option `value` fields; add missing `image` event to `ClaudeProcessEvents`
- Fix stale cron schedules not being cleaned up when a workflow repo is removed
- Decouple commit-event authentication from the main webhook auth path

### Chores
- Remove obsolete `.codekin/outputs/` directory
- Update `package-lock.json` for v0.3.7
```

---

## Stale Branches

Today's date: 2026-03-12. The 30-day stale threshold is 2026-02-10. **No remote branch has its last commit before that date** — all branches are active within the last 4 days. However, branch hygiene is poor: 29 branches that are already merged into `main` remain open on the remote.

### Merged Branches Not Yet Deleted (Remote Cleanup Needed)

| Branch | Last Commit | Merged into main? | Recommendation |
|---|---|---|---|
| `origin/chore/bump-0.3.4` | 2026-03-10 | ✅ Yes | Delete |
| `origin/chore/bump-0.3.5` | 2026-03-10 | ✅ Yes | Delete |
| `origin/chore/bump-0.3.6` | 2026-03-10 | ✅ Yes | Delete |
| `origin/chore/remove-obsolete-outputs` | 2026-03-11 | ✅ Yes | Delete |
| `origin/chore/repo-health-audit-fixes` | 2026-03-10 | ✅ Yes | Delete |
| `origin/docs/readme-features` | 2026-03-11 | ✅ Yes | Delete |
| `origin/feat/auto-detect-orgs-server` | 2026-03-10 | ✅ Yes | Delete |
| `origin/feat/commit-review-dispatcher` | 2026-03-11 | ✅ Yes | Delete |
| `origin/feat/commit-review-workflow-def` | 2026-03-11 | ✅ Yes | Delete |
| `origin/feat/commit-review-workflow-ui` | 2026-03-11 | ✅ Yes | Delete |
| `origin/feat/config-gh-org` | 2026-03-10 | ✅ Yes | Delete |
| `origin/feat/cross-repo-auto-approval` | 2026-03-11 | ✅ Yes | Delete |
| `origin/feat/readme-website-link` | 2026-03-11 | ✅ Yes | Delete |
| `origin/feat/usage-limit-sidebar` | 2026-03-11 | ✅ Yes | Delete |
| `origin/fix/code-review-audit-2026-03-11` | 2026-03-11 | ✅ Yes | Delete |
| `origin/fix/gh-missing-message` | 2026-03-10 | ✅ Yes | Delete |
| `origin/fix/installer-stdin-piped` | 2026-03-10 | ✅ Yes | Delete |
| `origin/fix/launchd-path-injection` | 2026-03-10 | ✅ Yes | Delete |
| `origin/fix/readme-install-url` | 2026-03-10 | ✅ Yes | Delete |
| `origin/fix/remove-gh-org-readme` | 2026-03-11 | ✅ Yes | Delete |
| `origin/fix/remove-org-prompt` | 2026-03-10 | ✅ Yes | Delete |
| `origin/fix/server-deps-in-root` | 2026-03-10 | ✅ Yes | Delete |
| `origin/fix/suppress-npm-warnings` | 2026-03-10 | ✅ Yes | Delete |
| `origin/fix/ui-improvements` | 2026-03-11 | ✅ Yes | Delete |
| `origin/fix/usage-limit-rate-limit-event` | 2026-03-11 | ✅ Yes | Delete |
| `origin/fix/webhook-sidebar-grouping` | 2026-03-11 | ✅ Yes | Delete |
| `origin/release/v0.2.0` | 2026-03-08 | ✅ Yes | Keep (release branch — archive) |
| `origin/release/v0.3.0` | 2026-03-09 | ✅ Yes | Keep (release branch — archive) |

### Unmerged Branches (Not yet on main)

| Branch | Last Commit | Commits Ahead | Commits Behind | Notes |
|---|---|---|---|---|
| `origin/feat/enforce-branching-policy` | 2026-03-08 | 8 | 283 | Unmerged; very large divergence; high conflict risk |
| `origin/fix/ci-lint-errors` | 2026-03-09 | 1 | 146 | Unmerged; 1 unique commit; may be superseded |
| `origin/chore/update-test-coverage-report-2026-03-09` | 2026-03-10 | 1 | 97 | Open PR #76; awaiting review |
| `origin/fix/installer-gh-auth-check` | 2026-03-10 | 2 | 75 | Unmerged; 2 unique commits |
| `origin/feat/uninstall-command` | 2026-03-10 | 1 | 70 | Unmerged; 1 unique commit (uninstall feature) |
| `origin/codekin/reports` | 2026-03-11 | 14 | 261 | Special reports branch; large divergence; high conflict risk |
| `origin/chore/repo-health-audit-improvements` | 2026-03-11 | 1 | 22 | Unmerged |
| `origin/feat/commit-review-workflow` | 2026-03-11 | 1 | 14 | Unmerged; related work may already be in merged PRs |

---

## PR Hygiene

| PR # | Title | Author | Created | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|---|
| #76 | Chore: update test coverage report 2026-03-09 | alari76 | 2026-03-10 | 2 | No review | UNKNOWN | No (< 7 days) |

**No stuck PRs** (no PR open for more than 7 days without review activity).

PR #76 is a chore/documentation PR. Its `mergeable` state is `UNKNOWN` in the GitHub API — this typically resolves after a refresh. The `codekin/reports` branch it likely targets diverged significantly from main (261 commits behind), which may explain the unknown mergeable status.

---

## Merge Conflict Forecast

Branches with unique commits (ahead of main) assessed for conflict risk with `main`:

| Branch | Ahead | Behind | Risk Level | Notes |
|---|---|---|---|---|
| `origin/codekin/reports` | 14 | 261 | 🔴 High | 14 unique commits + 261 main commits it hasn't seen = almost certain widespread conflicts; the reports branch appears to be a long-running diverged branch |
| `origin/feat/enforce-branching-policy` | 8 | 283 | 🔴 High | 8 commits against 283 new main commits; policy enforcement files likely conflict with infra changes |
| `origin/fix/installer-gh-auth-check` | 2 | 75 | 🟡 Medium | 2 unique commits touching installer; installer code has been heavily modified on main |
| `origin/fix/ci-lint-errors` | 1 | 146 | 🟡 Medium | 1 ESLint fix commit; ESLint config may have changed on main |
| `origin/feat/uninstall-command` | 1 | 70 | 🟡 Medium | 1 commit adding uninstall; `bin/codekin.mjs` and install flow may have changed |
| `origin/feat/commit-review-workflow` | 1 | 14 | 🟢 Low | 1 commit; 14 behind; the commit-review feature landed via other branches; likely superseded |
| `origin/chore/repo-health-audit-improvements` | 1 | 22 | 🟢 Low | 1 commit; reports/docs only; low conflict risk |
| `origin/chore/update-test-coverage-report-2026-03-09` | 1 | 97 | 🟢 Low-Med | 1 chore commit; test coverage reports don't touch production code |

**High-risk details**:
- `origin/codekin/reports` — This branch appears to be a persistent branch used to commit generated report files. Since reports are now committed directly to main (or via short-lived feature branches), this long-running branch is likely obsolete. If not needed, it should be closed without merging.
- `origin/feat/enforce-branching-policy` — 8 commits of policy enforcement logic against a codebase that has changed by 283 commits. Requires a full rebase against main before it can be safely reviewed.

---

## Recommendations

1. **Write the v0.3.7 CHANGELOG entry and plan v0.3.8** *(High impact)*
   The CHANGELOG has not been updated since v0.3.6. The v0.3.7 tag exists on main but has no changelog entry. Six meaningful post-tag features/fixes (commit-review workflow, cross-repo auto-approval, AskUserQuestion fix, approval prompt fix, cron cleanup, image event) are undocumented. Write the v0.3.7 entry and immediately bump to v0.3.8 for the post-tag work.

2. **Delete merged remote branches** *(Medium impact — hygiene)*
   26 feature/fix/chore branches are already merged into main and should be deleted from the remote. Run:
   ```sh
   git branch -r --merged origin/main | grep -v 'origin/main\|origin/release' | sed 's/origin\///' | xargs -I{} git push origin --delete {}
   ```
   Enable "Automatically delete head branches" in GitHub repository settings to prevent this accumulation going forward.

3. **Resolve or close the `codekin/reports` branch** *(Medium impact — risk)*
   This branch is 14 commits ahead and 261 behind main with high conflict risk. If reports are being committed there, migrate the workflow to commit directly to main via short-lived branches (as seems to be the current approach). Close the branch without merging.

4. **Triage unmerged feature branches** *(Medium impact)*
   Five branches have unique commits not yet on main: `feat/enforce-branching-policy`, `fix/ci-lint-errors`, `fix/installer-gh-auth-check`, `feat/uninstall-command`, `chore/repo-health-audit-improvements`. For each: determine if the work is still needed (some may be superseded by main), rebase against main, and either open a PR or close the branch.

5. **Resolve unknown licenses for `busboy` and `streamsearch`** *(Low impact — compliance)*
   Both packages are well-known MIT packages but their license field is absent from `package-lock.json`. Verify by inspecting `node_modules/busboy/LICENSE` and `node_modules/streamsearch/LICENSE`. If confirmed MIT, this is a non-issue; consider adding a `license-check` step to CI to catch this automatically.

6. **Update `docs/WORKFLOWS.md` to include `commit-review`** *(Low impact — docs)*
   The doc lists 6 built-in workflow kinds; `commit-review` is now a 7th. Add an entry describing its trigger conditions, configuration, and expected output.

7. **Update `docs/stream-json-protocol.md` for `image` event type** *(Low impact — docs)*
   The `image` event was added to `ClaudeProcessEvents` in the 2026-03-11 AskUserQuestion fix. Verify this is reflected in the protocol specification.

8. **Document cross-repo auto-approval in `docs/FEATURES.md`** *(Low impact — docs)*
   The new cross-repo auto-approval feature (added 2026-03-11) is not described in any documentation. Add a brief section explaining how approval inference across repos works.

9. **Consider renaming `src/lib/deriveActivityLabel.ts` export collision** *(Low impact)*
   Verify the file is imported somewhere; if it is an orphan, remove it. If used, note the naming proximity to the `RepoGroup` interface/component collision in `useRepos.ts`.

10. **Merge or close PR #76** *(Low impact)*
    PR #76 ("update test coverage report 2026-03-09") has been open for 2 days with no review. The branch is 97 commits behind main. If the test coverage report is still accurate, rebase and merge; otherwise close and regenerate the report on a fresh branch.

---

## Security Audit

**Auditor**: Automated (Claude Code security scan)
**Scan date**: 2026-03-12

### Security Summary

**Overall Risk Rating: Low**

The codebase demonstrates a strong security posture. No critical or injection-class exploitable vulnerabilities were found. Authentication is cryptographically sound, input validation is generally correct, and security headers are properly configured.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 2 |
| Low | 2 |
| Informational | 3 |

---

### Critical Findings

None.

---

### High Findings

#### H1 — Path Traversal: Incomplete Boundary Check in docs-routes

**File**: `server/docs-routes.ts:150–154`
**Type**: Path Traversal

**Code**:
```typescript
const resolved = resolve(repoPath, filePath)
const repoResolved = resolve(repoPath)
if (!resolved.startsWith(repoResolved + '/') && resolved !== repoResolved) {
  return res.status(404).json({ error: 'File not found' })
}
```

**Description**: The path traversal guard uses a string prefix check (`startsWith(repoResolved + '/')`) without first resolving symlinks. An attacker who can create or control a symlink within the repository directory could escape the intended boundary. The guard does not call `realpathSync()` before comparison, so a path normalised by `resolve()` to an absolute location outside the repo root is checked only by string comparison.

**Impact**: If exploitable, an authenticated user could read arbitrary files on the server that the Node process has read access to (e.g., `/etc/passwd`, private keys, other repositories' source code).

**Remediation**:
```typescript
import { realpathSync } from 'fs'
const resolved = realpathSync(resolve(repoPath, filePath))
const repoResolved = realpathSync(resolve(repoPath))
if (!resolved.startsWith(repoResolved + path.sep)) {
  return res.status(403).json({ error: 'Access denied' })
}
```
Use `realpathSync` to canonicalise both paths before comparison. This resolves symlinks and normalises separators, closing the bypass vector.

---

### Medium Findings

#### M1 — SQL Injection Pattern: Unparameterised `orderBy` in `buildListQuery`

**File**: `server/workflow-engine.ts:165–179`
**Type**: SQL Injection (pattern-level, currently low exploitability)

**Code**:
```typescript
function buildListQuery(table: string, opts: ListQueryOpts) {
  let sql = `SELECT * FROM ${table} WHERE 1=1`
  for (const f of opts.filters) {
    sql += ` AND ${f.column} = ?`   // column not validated
    params.push(f.value)
  }
  if (opts.orderBy) sql += ` ORDER BY ${opts.orderBy}` // NOT parameterised
  ...
}
```

**Description**: Both `opts.orderBy` and `f.column` are concatenated directly into the SQL string without whitelist validation. Call sites currently pass hardcoded literals, so this is not actively exploitable — however, if the function is reused or inputs become user-controlled, it becomes a full SQL injection vector.

**Impact**: SQL injection enabling data exfiltration or corruption if call sites ever accept user-controlled `orderBy` or `column` values.

**Remediation**: Add a column/order-by allowlist:
```typescript
const ALLOWED_ORDER_COLS = new Set(['created_at', 'updated_at', 'status', 'kind'])
if (opts.orderBy && !ALLOWED_ORDER_COLS.has(opts.orderBy)) {
  throw new Error(`Invalid orderBy column: ${opts.orderBy}`)
}
```

---

#### M2 — CORS Origin Falls Back to `localhost` Without Explicit Production Guard

**File**: `server/config.ts:24–31`, `server/ws-server.ts:250`
**Type**: Configuration — CORS

**Code**:
```typescript
export const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

if (process.env.NODE_ENV === 'production' && !process.env.CORS_ORIGIN) {
  console.error('[config] ERROR: ...')
  process.exit(1)
}
```

**Description**: The guard correctly exits in `NODE_ENV=production` if `CORS_ORIGIN` is unset. However, staging or CI environments that set `NODE_ENV=staging` or omit the variable entirely will silently fall back to `localhost:5173`. The CORS origin is applied without restricting `Access-Control-Allow-Credentials`, which could allow cross-origin state mutation from the fallback origin in those environments.

**Impact**: In non-production environments with network exposure, cross-origin requests from any page served on localhost could interact with the API.

**Remediation**: Extend the guard to cover any environment that is not purely local development:
```typescript
if (!process.env.CORS_ORIGIN && process.env.NODE_ENV !== 'development') {
  throw new Error('CORS_ORIGIN must be explicitly set in non-development environments')
}
```

---

### Low Findings

#### L1 — Unauthenticated Token-Verification Endpoint Enables Brute-Force Oracle

**File**: `server/auth-routes.ts:35–38`
**Type**: Information Disclosure / Brute Force

**Code**:
```typescript
router.post('/auth-verify', (req, res) => {
  const token = extractToken(req)
  res.json({ valid: verifyToken(token) })
})
```

**Description**: The `/auth-verify` endpoint is publicly accessible and returns a boolean confirming whether a submitted token is valid. While HMAC-SHA256 token derivation makes brute-force computationally infeasible, the endpoint provides a direct oracle — any attacker with a candidate token can confirm its validity without rate limiting.

**Impact**: Facilitates offline-to-online token testing; amplifies impact of any token leak.

**Remediation**: Add IP-based rate limiting to this endpoint, and/or return HTTP 401 on failure rather than `{ valid: false }` to avoid leaking the verification result format.

---

#### L2 — No Rate Limiting on General REST API Endpoints

**File**: `server/ws-server.ts` (multiple endpoints)
**Type**: Denial of Service / Resource Exhaustion

**Description**: Webhook endpoints correctly apply `createWebhookRateLimiter` and WebSocket connections are rate-limited. REST endpoints such as `GET /api/sessions`, `POST /api/approvals/:id`, and `GET /api/workflows` have no per-IP or per-token rate limits. An attacker with a valid token could send high-volume requests to exhaust server resources.

**Impact**: Authenticated denial of service; potential resource exhaustion (CPU, SQLite write contention).

**Remediation**: Apply a global rate-limit middleware before all `/api/*` routes:
```typescript
import rateLimit from 'express-rate-limit'
app.use('/api/', rateLimit({ windowMs: 60_000, max: 300 }))
```

---

### Secrets & Credentials Exposure

**No hardcoded secrets, API keys, passwords, or private keys were found in any source file.**

- All token references in source files are environment variable reads (`process.env.AUTH_TOKEN`, `process.env.WEBHOOK_SECRET`, etc.).
- No `.env` files are committed to the repository.
- No Base64-encoded credentials were found.
- Token literals in test fixtures are clearly synthetic (e.g., `'test-token'`, `'mock-secret'`).

---

### Positive Security Practices Noted

| Practice | Location |
|---|---|
| Timing-safe token comparison (`crypto.timingSafeEqual`) | `server/auth-routes.ts`, `server/webhook-handler.ts` |
| HMAC-SHA256 session token derivation (master key never exposed) | `server/auth-routes.ts` |
| Security headers: `X-Frame-Options`, `X-Content-Type-Options`, `HSTS`, CSP | `server/ws-server.ts:235–246` |
| Secret redaction in log output | `server/crypto-utils.ts:13–27` |
| Repository root boundary enforcement with `realpathSync` in upload/clone paths | `server/upload-routes.ts` |
| DOMPurify sanitisation before `dangerouslySetInnerHTML` | `src/components/MarkdownRenderer.tsx` |
| Array-based `spawn()` arguments (no `shell: true`) | `server/claude-process.ts` |
| File upload MIME type and size validation | `server/upload-routes.ts` |
| Webhook HMAC-SHA256 signature verification | `server/webhook-handler.ts:88–91` |

---

### Security Recommendations

1. **[HIGH] Fix symlink-bypass path traversal in `server/docs-routes.ts`** — Add `realpathSync()` canonicalisation before the boundary check. This is the only finding that could allow an authenticated user to read files outside a repository directory.
2. **[MEDIUM] Whitelist `orderBy` and `column` values in `buildListQuery`** (`server/workflow-engine.ts`) — Prevent this pattern from becoming exploitable if ever called with user-controlled input.
3. **[MEDIUM] Extend the CORS origin guard to non-`production` NODE_ENV values** (`server/config.ts`) — Any deployed instance that doesn't set `NODE_ENV=production` will silently fall back to a localhost origin.
4. **[LOW] Add rate limiting to `/auth-verify`** (`server/auth-routes.ts`) — Apply per-IP throttling (e.g., 10 req/min) to prevent the endpoint from functioning as a token-testing oracle.
5. **[LOW] Apply global rate limiting to `/api/*` routes** (`server/ws-server.ts`) — Protect against authenticated resource exhaustion; the webhook rate limiter already exists as a model.
6. **[INFO] Codify `shell: false` in `child_process` calls via CI lint rule** — Formalise the existing safe practice to prevent regression.
7. **[INFO] Consider adding a CSP `report-uri`** — The CSP header is present; a reporting endpoint would provide visibility into future injection attempts.
