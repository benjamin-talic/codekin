# Codekin — Repository Health Report
**Date:** 2026-04-06  
**Branch:** main  
**Assessed by:** Automated health check

---

## Summary

The repository is in good health overall. Active development is high (696 commits in the last 30 days), the TypeScript configuration is strict across all targets, and no raw TODO/FIXME annotations exist in first-party source files. Key findings are:

- **Dead code (minor):** One exported interface (`SlashAutocompleteHandle`) is defined but never consumed. `TimePicker` uses a default export in a codebase that otherwise uses named exports.
- **Docs drift:** `docs/FEATURES.md` references the removed `react-syntax-highlighter` dependency; the actual renderer uses `marked` + `highlight.js`.
- **Stale branches:** 13 of 15 remote branches (excluding `main`) have not merged and are significantly behind `main`, ranging from 2 to 350 commits behind. Several are older than 30 days.
- **License:** All dependencies are permissively licensed. Two entries report `unknown` license — worth investigating.
- **No TODOs/FIXMEs** in any first-party source file (only in vendored `node_modules`).
- **One open PR** (#287) has been open since 2026-04-05 with an `UNKNOWN` mergeability status.

---

## Dead Code

### Orphan Exported Symbols

| Symbol | File | Issue |
|---|---|---|
| `SlashAutocompleteHandle` | `src/components/SlashAutocomplete.tsx:31` | Exported interface never imported anywhere. The component uses `cmdk` for keyboard navigation internally; the handle type was likely a leftover from a `forwardRef` refactor. |

### Default Export Inconsistency

| Symbol | File | Issue |
|---|---|---|
| `TimePicker` | `src/components/TimePicker.tsx` | Uses `export default` while all other components in `src/components/` use named exports. Not dead code, but an inconsistency that makes tree-shaking and refactoring harder. |

### Internal Functions / Orphan Files

No orphan files were found — all server modules (`commit-event-handler.ts`, `session-restart-scheduler.ts`, `orchestrator-memory.ts`, `orchestrator-learning.ts`, `orchestrator-reports.ts`, `orchestrator-monitor.ts`, `error-page.ts`, `version-check.ts`, `session-persistence.ts`, `plan-manager.ts`) are imported by at least one other module. All frontend hooks and components are similarly imported.

### Notes

The `src/lib/hljs.ts` shared instance is imported by both `ChatView` and `MarkdownRenderer`. It is not exported from the package boundary but is internally well-connected.

---

## TODO/FIXME Tracker

**No TODO, FIXME, HACK, XXX, or WORKAROUND comments were found in any first-party source file** under `src/` or `server/`.

The grep sweep did surface thousands of matches in `server/node_modules/rollup/dist/` (vendored build tool internals), which are not actionable.

**Summary:** Total: 0 | By type: n/a | Stale: 0

---

## Config Drift

### TypeScript

All three tsconfig targets are well-configured with strict mode enabled.

| Config | Target | `strict` | `noUnusedLocals` | `noUnusedParameters` | `noFallthroughCasesInSwitch` | Notes |
|---|---|---|---|---|---|---|
| `tsconfig.app.json` | ES2022 | ✅ | ✅ | ✅ | ✅ | Also sets `erasableSyntaxOnly`, `noUncheckedSideEffectImports` |
| `tsconfig.node.json` | ES2023 | ✅ | ✅ | ✅ | ✅ | Vite config only |
| `server/tsconfig.json` | ES2022 | ✅ | ✅ | ✅ | ✅ | `NodeNext` module resolution, `isolatedModules`, `composite` |

No missing strict-mode settings. The server tsconfig correctly uses `NodeNext` module resolution to match the ESM + `.js` extension import style.

### ESLint

ESLint config (`eslint.config.js`) uses `typescript-eslint` strict preset. Several type-safety rules have been **demoted to warnings** pending incremental adoption:

| Rule (downgraded to warn) | Risk |
|---|---|
| `@typescript-eslint/no-unsafe-assignment` | Medium — allows `any` propagation |
| `@typescript-eslint/no-unsafe-argument` | Medium |
| `@typescript-eslint/no-unsafe-member-access` | Medium |
| `@typescript-eslint/no-unsafe-return` | Medium |
| `@typescript-eslint/no-non-null-assertion` | Low–Medium |
| `@typescript-eslint/no-unnecessary-condition` | Low |
| `@typescript-eslint/no-misused-promises` | Medium |
| `@typescript-eslint/require-await` | Low |

The config includes an inline comment acknowledging these should be promoted to errors over time. **Recommendation:** track these as a backlog item and promote incrementally.

Test files (`**/*.test.{ts,tsx}`) use only `tseslint.configs.recommended` (not strict), with `@typescript-eslint/no-explicit-any` disabled — reasonable for test code.

### Prettier

Prettier is configured (`{ semi: false, singleQuote: true, trailingComma: "all", printWidth: 120 }`). No issues.

---

## License Compliance

**Project license:** MIT  
**LICENSE file:** Present — `MIT License, Copyright (c) 2025 Codekin Contributors`

### Dependency License Summary

| License | Count | Status |
|---|---|---|
| MIT | 312 | ✅ Compatible |
| ISC | 18 | ✅ Compatible |
| MPL-2.0 | 12 | ✅ Build-time only (noted in `package.json#licenseNotes`) |
| BSD-3-Clause | 9 | ✅ Compatible |
| Apache-2.0 | 8 | ✅ Compatible |
| BSD-2-Clause | 8 | ✅ Compatible |
| (MPL-2.0 OR Apache-2.0) | 1 | ✅ `dompurify` — noted in licenseNotes |
| BlueOak-1.0.0 | 1 | ✅ Permissive |
| CC-BY-4.0 | 1 | ⚠️ Typically documentation/data only — verify it's not compiled into the bundle |
| CC0-1.0 | 1 | ✅ Public domain |
| 0BSD | 1 | ✅ Permissive |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 | ✅ Compatible |
| (MIT OR WTFPL) | 1 | ✅ Compatible |
| **unknown** | **2** | ⚠️ **Needs investigation** |

**Action required:**
1. Identify the 2 packages with `unknown` license. Run `node -e "const l=require('./package-lock.json'); Object.entries(l.packages||{}).filter(([k,v])=>k.startsWith('node_modules/') && !k.slice(13).includes('/') && !v.license).forEach(([k])=>console.log(k))"` to list them.
2. Verify the CC-BY-4.0 package is not bundled into distributed artifacts.

---

## Documentation Freshness

### Stale Reference in `docs/FEATURES.md`

**File:** `docs/FEATURES.md`, line 57  
**Issue:** States "Fenced code blocks are highlighted with language-specific coloring via `react-syntax-highlighter` using the VS Code Dark+ theme."  
**Reality:** `react-syntax-highlighter` is not in `package.json`. The project actually uses `marked` + `marked-highlight` + `highlight.js` (see `src/components/MarkdownRenderer.tsx` and `src/lib/hljs.ts`).

This was likely introduced before the dependency was swapped and was not caught in the April 5 docs audit.

### Recent Server/API Changes (Last 30 Days)

Highly active — the following server files were touched across multiple commits:

- `server/claude-process.ts` — 5+ commits (session lifecycle, restart stabilization, subscription auth)
- `server/session-manager.ts` — 4+ commits (idle reaper, agent exemptions, race-condition fixes)
- `server/ws-server.ts` — 4+ commits
- `server/approval-manager.ts` — approvals architecture overhaul (#280)
- `server/ws-message-handler.ts` — security audit fixes
- `server/webhook-handler.ts` — security fixes

`docs/API-REFERENCE.md` was updated in commit `bb82455` (2026-04-04). Given the volume of server changes since then, it may be worth a targeted review against `server/session-routes.ts` and `server/approval-manager.ts` to confirm the API surface is still in sync.

### README vs package.json Script Alignment

All scripts referenced in README.md and CONTRIBUTING.md (`npm run dev`, `npm run build`, `npm test`, `npm run test:watch`, `npm run lint`, `npm run preview`) exist in `package.json`. ✅

### Referenced Path Check

- `docs/screenshot.png` — exists ✅  
- `docs/INSTALL-DISTRIBUTION.md` — exists ✅  
- `CONTRIBUTING.md` — exists ✅  
- `LICENSE` — exists ✅

---

## Draft Changelog

Changes merged to `main` in the last 7 days (2026-03-30 to 2026-04-06):

### Fixes
- Fall back to fresh session when `--resume` hangs with zero output (#292)
- Stabilize Claude process lifecycle to prevent restart loops (#290)
- Resolve restart loop caused by race condition in `startClaude()` (#288)
- Address 3 security audit warnings (W-01, W-02, W-03)
- Support subscription auth and unblock standalone CLI sessions (#283)
- Address 5 code review findings (W-02, W-03, W-04, W-09, I-09) (#282)
- Overhaul approvals architecture for parity with native CLI (#280)
- Upgrade lodash to 4.18.1 (high-severity audit vuln)
- Resolve Agent Joe passivity (#273)
- Improve long session stability and resource management (#272)

### Features
- Add `--dangerously-skip-permissions` as a permission mode setting

### Refactoring
- Reduce code complexity across 6 high-priority areas (#267)

### Tests
- Improve code coverage across server and frontend modules (#265)

### Chores
- Upgrade TypeScript 6, Vite 8, ESLint 10, jsdom 29

### Documentation
- Update API reference, orchestrator spec, protocol docs, and changelog

**Recent tags:** `v0.5.3` (2026-04-03), `v0.5.2`, `v0.5.1`, `v0.5.0`, `v0.4.1`

> 5 commits have landed on `main` since `v0.5.3` — consider cutting `v0.5.4`.

---

## Stale Branches

Branches are classified as **stale** if last activity was >30 days before 2026-04-06 (before 2026-03-07) or significantly behind `main` with no recent activity.

| Branch | Last Activity | Ahead | Behind | Merged? | Recommendation |
|---|---|---|---|---|---|
| `origin/fix/code-review-2026-04-05` | 2026-03-16 | 0 | 2 | ✅ Yes | Delete |
| `origin/chore/reports-2026-04-04` | 2026-03-16 | 1 | 11 | ❌ No | Delete (stale, superseded) |
| `origin/chore/reports-2026-04-05` | 2026-03-16 | 1 | 7 | ❌ No | Delete (stale, superseded) |
| `origin/codekin/reports` | 2026-03-16 | 57 | 350 | ❌ No | ⚠️ Delete (350 behind, unrecoverable) |
| `origin/fix/resume-hang-fallback` | 2026-03-16 | 1 | 1 | ❌ No | Delete (stale, superseded by #292) |
| `origin/feat/joe-chat-variant` | 2026-03-17 | 1 | 203 | ❌ No | ⚠️ Delete (203 behind) |
| `origin/chore/repo-health-report-2026-03-18` | 2026-03-18 | 2 | 196 | ❌ No | ⚠️ Delete (196 behind) |
| `origin/test/approval-flow-v3` | 2026-03-23 | 1 | 76 | ❌ No | Delete (approval arch overhauled in #280) |
| `origin/chore/repo-health-report-2026-03-25` | 2026-03-25 | 2 | 54 | ❌ No | Delete (superseded) |
| `origin/chore/repo-health-report-2026-03-26` | 2026-03-28 | 5 | 52 | ❌ No | Delete (superseded) |
| `origin/chore/repo-health-report-2026-03-30` | 2026-04-01 | 4 | 46 | ❌ No | Delete (superseded) |
| `origin/fix/lodash-audit-vulnerability` | 2026-04-03 | 1 | 34 | ❌ No | Delete (fix likely landed via main) |
| `origin/fix/long-session-stability` | 2026-04-03 | 2 | 35 | ❌ No | Review — may be superseded by #290 |
| `origin/fix/security-audit-findings` | 2026-04-03 | 5 | 35 | ❌ No | ⚠️ High conflict risk — rebase or close |
| `origin/chore/repo-health-report-2026-03-14` | 2026-03-14 | 2 | 350 | ❌ No | ⚠️ Delete (350 behind, oldest stale branch) |

**14 of 15** non-main branches are unmerged and stale.

---

## PR Hygiene

| # | Title | Author | Opened | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|---|
| #287 | chore: add repo health assessment for 2026-04-05 | alari76 | 2026-04-05 | 1 | — | UNKNOWN | No |

Only one open PR. The `UNKNOWN` mergeability status from the GitHub API typically means it is still being computed or has not been evaluated yet. No action is urgent — the PR was opened yesterday.

---

## Merge Conflict Forecast

Branches with activity in the last 14 days (since 2026-03-23):

| Branch | Last Activity | Ahead main | Behind main | Overlapping Files | Risk |
|---|---|---|---|---|---|
| `origin/fix/lodash-audit-vulnerability` | 2026-04-03 | 1 | 34 | `package.json`, `package-lock.json` | Low — lodash fix likely already on main |
| `origin/fix/long-session-stability` | 2026-04-03 | 2 | 35 | `server/claude-process.ts`, `server/session-manager.ts` | Medium — both files heavily modified on main |
| `origin/fix/security-audit-findings` | 2026-04-03 | 5 | 35 | `server/ws-message-handler.ts`, `server/webhook-handler.ts` | **High** — same files patched by security PRs on main |
| `origin/test/approval-flow-v3` | 2026-03-23 | 1 | 76 | `server/approval-manager.ts` | **High** — approval arch completely overhauled in #280 |
| `origin/chore/repo-health-report-2026-03-30` | 2026-04-01 | 4 | 46 | `.codekin/reports/` only | Low — report files, no code conflict |

---

## Recommendations

### High Priority

1. **Branch cleanup sweep**: Delete the 12+ stale branches. At minimum, immediately delete `origin/codekin/reports`, `origin/chore/repo-health-report-2026-03-14`, `origin/feat/joe-chat-variant`, and `origin/chore/repo-health-report-2026-03-18` — all 196–350 commits behind with no path to merge.

2. **Resolve `fix/security-audit-findings` conflict risk**: This branch has 5 diverged commits touching the same security-sensitive files (`ws-message-handler.ts`, `webhook-handler.ts`) that were patched on `main`. Either rebase immediately and merge, or close as superseded.

3. **Investigate the 2 `unknown`-license dependencies**: Run the identification query and confirm license compatibility before the next release.

### Medium Priority

4. **Remove `SlashAutocompleteHandle` export** (`src/components/SlashAutocomplete.tsx:31`): Zero consumers — either wire it up or delete it.

5. **Fix `docs/FEATURES.md` stale reference** (line 57): Replace the `react-syntax-highlighter` mention with the actual stack (`marked` + `marked-highlight` + `highlight.js`).

6. **Cut `v0.5.4`**: Five production-relevant fixes (session lifecycle, `--resume` fallback, subscription auth, security) have landed since `v0.5.3`. Tag a patch release.

7. **Promote ESLint warnings to errors**: 8 type-safety rules are demoted to `warn`. Start with `no-unsafe-assignment` and `no-misused-promises`.

### Low Priority

8. **Normalize `TimePicker` to a named export**: Aligns with the rest of `src/components/` and prevents import-style confusion.

9. **Review `docs/API-REFERENCE.md` against current approval routes**: The approvals architecture overhaul in #280 may have changed the request/response shapes.

10. **Verify CC-BY-4.0 dependency**: Confirm it is documentation/data only and not compiled into distributed frontend assets.
