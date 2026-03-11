# Repository Health: codekin

**Date**: 2026-03-11T04:24:39.986Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 84a2f4fe-5e21-4aec-b4a1-238a9647d17f
**Session**: 05e93462-4fe4-4f37-ab6b-15931f2ffbc6

---

Now I have all the data needed. Let me compose the report.

```markdown
# Codekin Repository Health Report
**Generated:** 2026-03-11  
**Branch:** `main` @ `db0e10d` (v0.3.6)  
**Assessor:** Claude Sonnet 4.6 (automated)

---

## Summary

**Overall Health: Good**

The codebase is actively maintained with strict TypeScript, meaningful test coverage, and a clean commit history. The primary concerns are a growing number of stale-but-undeleted remote branches, a CHANGELOG that has fallen significantly behind (missing v0.3.1–v0.3.6), one orphaned component, and a handful of ESLint rules that remain demoted to warnings. No copyleft license violations, no TODO debt, and no stuck PRs.

| Metric | Count |
|---|---|
| Dead code items | 4 (unused exports) + 1 orphan component |
| Stale TODOs/FIXMEs | 0 |
| Config issues | 3 (ESLint warning demotion, no Prettier, server tsconfig gaps) |
| License concerns | 2 (metadata-only, not a legal risk) |
| Doc drift items | 5 CHANGELOG versions missing; 0 README mismatches |
| Stale merged branches | 15 |
| Stuck PRs | 0 (1 open, 1 day old) |
| High-risk diverged branches | 2 |

---

## Dead Code

| File | Export / Symbol | Type | Recommendation |
|---|---|---|---|
| `src/lib/workflowHelpers.ts` | `formatHour` | Unused export (only in tests) | Keep — tested, likely needed for a future TimeEditor UI; add a `// used in tests` comment |
| `src/lib/workflowHelpers.ts` | `toTimeValue` | Unused export (only in tests) | Keep — see above |
| `src/lib/workflowHelpers.ts` | `fromTimeValue` | Unused export (only in tests) | Keep — see above |
| `src/lib/workflowHelpers.ts` | `biweeklyDay` | Internal helper (called by `buildCron`) | Not dead — used internally; **no action needed** |
| `src/components/SessionListPanel.tsx` | `SessionListPanel` | Orphan component — not imported anywhere | Review: either wire it into the app or delete it |

**Notes:**
- `biweeklyDay` was initially flagged but is called internally within `workflowHelpers.ts` by `buildCron`; it is not dead.
- `formatHour`, `toTimeValue`, and `fromTimeValue` are tested by `workflowHelpers.test.ts` but not imported by any production component. This suggests a partially-implemented time-picker UI. The exports should be retained with a comment explaining they are reserved for an upcoming UI, or the tests should be considered the sole consumers and the functions' public visibility can be downgraded.
- `SessionListPanel` (`src/components/SessionListPanel.tsx:62`) is exported but not imported by any other source file. It is a full-featured component (sessions list, delete, new-session callbacks) that likely predates a refactor. **Recommended: delete or migrate to active use.**

---

## TODO/FIXME Tracker

**Result: No actionable items found.**

A full scan of `src/`, `server/`, and `bin/` found zero `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments in production source code. The only occurrences are:
- `server/claude-process.test.ts` lines 60–61, 818 — these are string literals used as test fixture data, not code markers.
- `server/workflows/repo-health.weekly.md` — mentions "TODO tracker" as a feature description in a workflow markdown document.

| Metric | Count |
|---|---|
| TODO | 0 |
| FIXME | 0 |
| HACK | 0 |
| XXX | 0 |
| WORKAROUND | 0 |
| Stale (> 30 days) | 0 |

---

## Config Drift

### 1. ESLint — Excessive Warning Demotion (`eslint.config.js`)

The following `@typescript-eslint` rules are demoted from `error` to `warn` across both frontend and server configs:

| Rule | Current | Recommended |
|---|---|---|
| `@typescript-eslint/no-unsafe-assignment` | `warn` | `error` |
| `@typescript-eslint/no-unsafe-argument` | `warn` | `error` |
| `@typescript-eslint/no-unsafe-member-access` | `warn` | `error` |
| `@typescript-eslint/no-unsafe-return` | `warn` | `error` |
| `@typescript-eslint/no-unsafe-call` | `warn` | `error` |
| `@typescript-eslint/no-misused-promises` | `warn` | `error` |
| `@typescript-eslint/no-non-null-assertion` | `warn` | `error` |
| `@typescript-eslint/require-await` | `warn` | `error` |

**Impact:** CI passes despite live type-safety holes. The codebase comment acknowledges these are "pre-existing patterns" being cleaned up incrementally. A tracking issue or milestone for promoting these to errors would enforce closure.

### 2. No Prettier Configuration

No `.prettierrc`, `prettier.config.js`, or equivalent exists. Formatting is unenforced by tooling. This creates inconsistency risk as contributors grow.

**Recommendation:** Add a minimal `.prettierrc` (e.g., `{ "semi": false, "singleQuote": true, "printWidth": 100 }`) aligned with existing code style, and add `prettier --check` to CI.

### 3. Server `tsconfig.json` — Missing `noUnusedLocals` / `noUnusedParameters`

The frontend configs (`tsconfig.app.json`, `tsconfig.node.json`) both set `"noUnusedLocals": true` and `"noUnusedParameters": true`. The server's `server/tsconfig.json` omits these flags.

| Setting | Frontend | Server |
|---|---|---|
| `strict` | ✅ true | ✅ true |
| `noUnusedLocals` | ✅ true | ❌ absent |
| `noUnusedParameters` | ✅ true | ❌ absent |
| `erasableSyntaxOnly` | ✅ true | ❌ absent |
| `noFallthroughCasesInSwitch` | ✅ true | ❌ absent |

**Recommendation:** Add `"noUnusedLocals": true, "noUnusedParameters": true, "noFallthroughCasesInSwitch": true` to `server/tsconfig.json` for parity.

### 4. TypeScript Version — `~5.9.3` (Very Recent / Pre-Release Range)

The pinned version `~5.9.3` targets a TypeScript release that, as of this report, is recent/bleeding-edge. This is not an error, but it is worth monitoring: the patch-range pin (`~`) means minor point releases are auto-accepted. If TypeScript 5.9 introduces a breaking change, CI may break unexpectedly.

**No blocking issue**, but consider `^5.8` for a more stable upper-bound policy, or lock to a specific patch with `5.9.3`.

---

## License Compliance

**Project License:** MIT

### License Distribution

| License | # Packages |
|---|---|
| MIT | 513 |
| Apache-2.0 | 33 |
| ISC | 23 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 9 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |
| Python-2.0 | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (AFL-2.1 OR BSD-3-Clause) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| UNKNOWN | 2 |

### Flagged Packages

| Package | License Field | Notes |
|---|---|---|
| `busboy` | `UNKNOWN` | Transitive dep of `multer`/`express`. Source is MIT-licensed; `package.json` lacks a `license` field — metadata gap only, not a legal risk. |
| `streamsearch` | `UNKNOWN` | Transitive dep of `busboy`. Same situation — MIT in practice. |

**No GPL, AGPL, LGPL, SSPL, or BUSL dependencies detected.**

The `package.json` `licenseNotes` field correctly documents the `dompurify` dual-license (`MPL-2.0 OR Apache-2.0`), which is permissively compatible with MIT for library use.

**Assessment: Compliant.** The two UNKNOWN entries are a metadata artifact of transitive dependencies, not a compliance risk.

---

## Documentation Freshness

### CHANGELOG Drift — **High Priority**

The `CHANGELOG.md` was last updated for `v0.3.0` (2026-03-09). The project has since released **six additional versions** (v0.3.1 through v0.3.6) with no corresponding changelog entries.

| Version | Tag Date | CHANGELOG Entry |
|---|---|---|
| v0.3.1 | 2026-03-09 | ❌ Missing |
| v0.3.2 | 2026-03-10 | ❌ Missing |
| v0.3.3 | 2026-03-10 | ❌ Missing |
| v0.3.4 | 2026-03-10 | ❌ Missing |
| v0.3.5 | 2026-03-10 | ❌ Missing |
| v0.3.6 | 2026-03-10 | ❌ Missing |

Notable changes in the uncovered range include: image display support, image history persistence, URL auth token parameter, mobile responsive layout overhaul, dark mode contrast fixes, sidebar rework, installer improvements (stdin piping fix, GitHub CLI auth check, npm warning suppression), uninstall command, server dependency restructuring, `codekin config` command, GitHub org auto-detection, and removal of the org prompt from the setup wizard.

**Recommendation:** Backfill `CHANGELOG.md` for v0.3.1–v0.3.6 and enforce CHANGELOG updates as part of the PR/release checklist.

### README Drift — None Detected

All commands in README.md (`curl -fsSL codekin.ai/install.sh | bash`, `codekin token`, `codekin config`, `codekin service`, `codekin start`, `codekin setup`, `codekin uninstall`) match the current `bin/codekin.mjs` implementation. The install URL was updated in PR #81 (`fix/readme-install-url`). No stale paths, commands, or examples detected.

### API / Docs Freshness

The `docs/` directory (9 files) covers: Claude hooks spec, Codex integration plan, docs browser spec, features, GitHub webhooks spec, install/distribution, setup, stream-JSON protocol, and workflows. 

The `docs/INSTALL-DISTRIBUTION.md` documents the CLI commands and config file locations. These match the current `bin/codekin.mjs` implementation including the recently-added `config` and `uninstall` commands. No drift detected.

The `stream-json-protocol.md` may be slightly stale relative to the `image` variant added to `WsServerMessage` in v0.3.1 (PR #67: "Fix: add missing 'image' variant to server WsServerMessage type") — worth a spot-check against the current `src/types.ts` to confirm the protocol doc includes the image message type.

---

## Draft Changelog

The current HEAD is tagged `v0.3.6`. The following is a draft changelog entry covering the six releases since `v0.3.0` that are missing from `CHANGELOG.md`.

---

```
## [0.3.6] - 2026-03-10

### Fixes
- Remove GitHub org prompt from setup wizard (the org is now auto-detected)

### Features
- Auto-detect GitHub orgs from `gh` CLI when `GH_ORG` is not configured
- Add GitHub org auto-detection to the setup/config wizard UI

## [0.3.5] - 2026-03-10

### Fixes
- Inject `PATH` and `HOME` into launchd plist for macOS service (gh CLI access)

## [0.3.4] - 2026-03-10

### Fixes
- Show helpful message when GitHub CLI (`gh`) is not installed

### Chores
- Add `codekin uninstall` command
- Add `codekin config` command to update API keys
- Add GitHub CLI auth check to installer
- Suppress npm deprecation warnings during install
- Add config and uninstall commands to README usage section

## [0.3.3] - 2026-03-10

### Chores
- Replace `react-syntax-highlighter` with shared `highlight.js` instance (bundle size reduction)
- Upgrade: express 4→5, multer 1→2, `@types/node` 24→25, drop `@types/dompurify`
- Fix `no-floating-promises` ESLint violations across frontend and server
- Add server `@types/*` to root devDependencies for CI build

## [0.3.2] - 2026-03-10

### Fixes
- Fix installer breaking when piped through `curl | bash`
- Shorten auth token from 64 to 22 characters
- Add server runtime deps to root `package.json` for global install
- Update install URL to `codekin.ai/install.sh` in README

## [0.3.1] - 2026-03-09

### Features
- Add image display support for tool results in chat

### Fixes
- Fix external images not rendering due to CSP
- Fix images hidden inside collapsed tool activity section
- Fix queued messages losing attached files on execute
- Fix: persist images to session history for replay on session switch
- Fix: read auth token from URL query parameter on initial load
- Add missing `image` variant to server `WsServerMessage` type
- Improve mobile header alignment with fixed height and uniform button sizing
- Fix mobile layout issues: scrollbar, input height, sidebar close
- Darken sidebar text for repo names, icons, and AI Workflows button
- Add mobile-responsive layout with sidebar drawer, top bar, and adaptive modals
- Soften dark mode contrast: darker input bar, uniform text color
- Darken sidebar background
- Fix mobile button sizes not changing on mobile viewport
- Fix mobile UX: prevent keyboard popup on approval dialogs, enlarge tap targets
- Fix mobile menu not closing when tapping content area
- Bump mobile icon sizes to 24px per Material Design standard
```

---

## Stale Branches

All remote branches have activity dated 2026-03-08 to 2026-03-10, so none exceed the 30-day staleness threshold by last-commit date. However, 15 branches have been **merged into `main`** and their remote refs should be deleted to reduce noise.

### Merged — Recommend Deletion

| Branch | Last Commit | Author | Merged into main? | Recommendation |
|---|---|---|---|---|
| `origin/chore/bump-0.3.4` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/chore/bump-0.3.5` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/chore/bump-0.3.6` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/chore/repo-health-audit-fixes` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/feat/auto-detect-orgs-server` | 2026-03-10 | alari76 | ✅ Yes | Delete remote |
| `origin/feat/config-gh-org` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/fix/gh-missing-message` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/fix/installer-stdin-piped` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/fix/launchd-path-injection` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/fix/readme-install-url` | 2026-03-10 | alari76 | ✅ Yes | Delete remote |
| `origin/fix/remove-org-prompt` | 2026-03-10 | alari76 | ✅ Yes | Delete remote |
| `origin/fix/server-deps-in-root` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/fix/suppress-npm-warnings` | 2026-03-10 | alari | ✅ Yes | Delete remote |
| `origin/release/v0.2.0` | 2026-03-08 | alari | ✅ Yes | Delete remote (or retain release refs per policy) |
| `origin/release/v0.3.0` | 2026-03-09 | alari76 | ✅ Yes | Delete remote (or retain release refs per policy) |

**Command to bulk-delete merged non-release branches:**
```bash
git push origin --delete \
  chore/bump-0.3.4 chore/bump-0.3.5 chore/bump-0.3.6 \
  chore/repo-health-audit-fixes \
  feat/auto-detect-orgs-server feat/config-gh-org \
  fix/gh-missing-message fix/installer-stdin-piped fix/launchd-path-injection \
  fix/readme-install-url fix/remove-org-prompt fix/server-deps-in-root \
  fix/suppress-npm-warnings
```

### Unmerged — Monitor

| Branch | Last Commit | Commits Ahead | Merged? |
|---|---|---|---|
| `origin/codekin/reports` | 2026-03-10 | 11 | ❌ No |
| `origin/feat/enforce-branching-policy` | 2026-03-08 | 8 | ❌ No |
| `origin/fix/ci-lint-errors` | 2026-03-09 | 1 | ❌ No |
| `origin/fix/installer-gh-auth-check` | 2026-03-10 | 2 | ❌ No |
| `origin/feat/uninstall-command` | 2026-03-10 | 1 | ❌ No |
| `origin/chore/update-test-coverage-report-2026-03-09` | 2026-03-10 | 1 | ❌ No (open PR #76) |

---

## PR Hygiene

| PR # | Title | Author | Days Open | Review Status | Conflicts | Stuck? |
|---|---|---|---|---|---|---|
| #76 | Chore: update test coverage report 2026-03-09 | alari76 | 1 | No review yet | Unknown | ❌ No (< 7 days) |

**Assessment:** The single open PR is brand-new (1 day). No PRs are stuck. PR hygiene is excellent — the project has a high merge velocity with 92 closed PRs and only 1 open.

---

## Merge Conflict Forecast

Active unmerged branches are assessed against `main` for divergence risk.

| Branch | Behind main | Ahead of main | Risk Level | Notes |
|---|---|---|---|---|
| `origin/codekin/reports` | 210 | 11 | 🔴 High | 210 commits behind; likely touches `dist/` and report files that change frequently |
| `origin/feat/enforce-branching-policy` | 232 | 8 | 🔴 High | 232 commits behind main; significantly diverged — high rebase effort |
| `origin/fix/ci-lint-errors` | 95 | 1 | 🟡 Medium | 95 behind, 1 ahead; CI config may have changed on main |
| `origin/chore/update-test-coverage-report-2026-03-09` | 46 | 1 | 🟡 Medium | 46 behind; report file may conflict with subsequent report commits |
| `origin/fix/installer-gh-auth-check` | 24 | 2 | 🟢 Low | Moderate lag; `bin/codekin.mjs` has changed on main |
| `origin/feat/uninstall-command` | 19 | 1 | 🟢 Low | Small lag; uninstall command was merged via different branch (PR #84) — may be duplicate/superseded |

**High-Risk Notes:**
- `codekin/reports` and `feat/enforce-branching-policy` are severely diverged (200+ commits behind). If these branches are meant to be merged, they require immediate rebase or significant conflict resolution effort.
- `feat/uninstall-command` may be **superseded**: an uninstall command was already shipped in v0.3.4 via PR #84 from a different branch. This branch may be stale/dead work and could be deleted.

---

## Recommendations

1. **Backfill CHANGELOG.md for v0.3.1–v0.3.6** *(High impact — external-facing)*  
   Six versions are undocumented. Use the draft changelog above as a starting point. Add a CHANGELOG update requirement to the PR template to prevent future drift.

2. **Delete 13 merged remote branches** *(Medium impact — git hygiene)*  
   Run the bulk-delete command listed in the Stale Branches section. Retain `release/v0.2.0` and `release/v0.3.0` only if the team has a policy of keeping release branch refs; otherwise delete those too. Consider enabling GitHub's "Automatically delete head branches" setting.

3. **Address or delete `SessionListPanel.tsx`** *(Low impact — dead code)*  
   `src/components/SessionListPanel.tsx` exports `SessionListPanel` but is not imported anywhere. Either wire it into the application or delete it. TypeScript's `noUnusedLocals` does not catch orphan files.

4. **Decide on `codekin/reports` and `feat/enforce-branching-policy` branches** *(Medium impact — merge risk)*  
   Both are 200+ commits behind main. They require explicit owner action: rebase and merge, or delete. Left unattended, they will become impossible to merge without complete rewrites.

5. **Close or merge PR #76** *(Low impact — PR hygiene)*  
   The test coverage report PR is 1 day old and straightforward. Keep the review loop tight to maintain the project's excellent merge velocity.

6. **Add `noUnusedLocals` and `noUnusedParameters` to `server/tsconfig.json`** *(Low impact — config parity)*  
   The server config is missing strictness flags that the frontend already enforces. Adding them will catch unused server-side code at compile time.

7. **Promote ESLint `no-unsafe-*` rules from `warn` to `error`** *(Medium impact — type safety)*  
   Track the remaining `@typescript-eslint/no-unsafe-*` warnings as a milestone. Create a GitHub issue listing all current violations and work them down to zero, then flip each rule to `error`. `no-floating-promises` was already successfully promoted — use the same pattern.

8. **Add a Prettier configuration** *(Low impact — code consistency)*  
   Formatting is currently unenforced. A minimal `.prettierrc` aligned with existing code style (`semi: false`, `singleQuote: true`) and a `prettier --check` step in CI would prevent style drift as the contributor base grows.

9. **Verify `stream-json-protocol.md` includes the `image` message type** *(Low impact — doc freshness)*  
   The `image` variant was added to `WsServerMessage` in v0.3.1 but the docs predate that release. A quick spot-check will confirm whether the protocol doc needs a one-line update.

10. **Investigate `feat/uninstall-command` for supersession** *(Low impact — cleanup)*  
    The `codekin uninstall` command was shipped in v0.3.4 via PR #84 from a different branch. The `origin/feat/uninstall-command` branch (1 commit ahead, 19 behind) may be dead work. Review and delete if superseded.
```