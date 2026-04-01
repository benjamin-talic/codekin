# Repository Health Report — 2026-04-01

**Repository:** codekin
**Branch assessed:** chore/repo-health-report-2026-03-30
**Assessment date:** 2026-04-01
**Latest release:** v0.5.1 (2026-03-28)

---

## Summary

**Overall health: Good**

The codebase is actively maintained with strict TypeScript across all compilation targets, zero TODO/FIXME debt markers, clean dependency licenses, and no orphaned source files. The primary maintenance concerns are cosmetic rather than structural: a large accumulation of undeleted remote branches (including 29 already-merged and ~8 squash-merge remnants), two open reporting PRs pending review, and documentation drift identified in a companion docs audit (most urgently: `docs/FEATURES.md` is missing the Agent Joe feature shipped in v0.5.0 and has wrong API paths for the Docs Browser).

| Metric | Value |
|---|---|
| Dead code items | 0 |
| Stale TODO/FIXME | 0 (none exist) |
| Config issues | 1 minor (ESLint unsafe-* rules as warnings, acknowledged) |
| License concerns | 0 |
| Doc drift items | 7 (from companion docs-audit report) |
| Remote branches total | 66 |
| Merged branches not deleted | 29 |
| Unmerged branches (active) | 37 (most are squash-merge remnants) |
| Open PRs | 2 (both chore/reporting, mergeable) |
| Stuck PRs (>7 days, no review) | 1 (PR #259, 6 days — approaching threshold) |

---

## Dead Code

TypeScript strict mode with `noUnusedLocals: true` and `noUnusedParameters: true` is enforced across all four tsconfig targets (frontend, node, server, workflows). This means genuinely unused exports and parameters will fail the build. A manual scan of all `src/` and `server/` files found no orphaned files and no unreachable modules.

| File | Export/Function | Type | Recommendation |
|---|---|---|---|
| — | — | — | No dead code found |

**Notes:**
- All 47 server production files are reachable from `server/ws-server.ts` (main entry) via import chains.
- All 58 frontend production files are reachable from `src/main.tsx` → `src/App.tsx`.
- The TypeScript compiler enforces unused-locals/params at build time, making this category structurally clean.

---

## TODO/FIXME Tracker

A full scan of `src/`, `server/`, and `workflows/` for `TODO`, `FIXME`, `HACK`, `XXX`, and `WORKAROUND` comments returned **zero results** in project source files.

The only match in the repository is a test assertion in `server/claude-process.test.ts:61` that checks the string `'TODO'` as a literal value — not a debt marker.

| File:Line | Type | Comment | Author | Date | Stale? |
|---|---|---|---|---|---|
| — | — | No items found | — | — | — |

**Summary:** Total: 0 | Stale (>30 days): 0 | By type: TODO: 0, FIXME: 0, HACK: 0, XXX: 0, WORKAROUND: 0

---

## Config Drift

### TypeScript

Four tsconfig targets are in use. All have `"strict": true`.

| Config | Target | Module | Notes |
|---|---|---|---|
| `tsconfig.app.json` | ES2022 | ESNext/bundler | Frontend; `noUnusedLocals`, `noUnusedParameters`, `noFallthroughCasesInSwitch`, `noUncheckedSideEffectImports`, `erasableSyntaxOnly` — modern and thorough |
| `tsconfig.node.json` | ES2023 | — | Covers `vite.config.ts` only; no emit |
| `server/tsconfig.json` | ES2022 | NodeNext | Server; `declaration: true`, `sourceMap: true`, `composite: true`, `noUnusedLocals`, `noUnusedParameters` — correct for ESM Node |
| `workflows/tsconfig.json` | ES2022 | NodeNext | Has `esModuleInterop: true` absent from the server tsconfig — minor inconsistency, low impact since both targets are ESM |

**Findings:**
- No outdated targets (all ≥ ES2022).
- No missing `strict: true`.
- `workflows/tsconfig.json` adds `esModuleInterop: true` not present in `server/tsconfig.json`. This is a minor inconsistency; the server config's stricter default is preferable.
- `tsconfig.app.json` uses `erasableSyntaxOnly: true` — a TypeScript 5.5+ setting preventing use of `enum` and `namespace` in frontend code. This is intentional and modern.

### ESLint

Flat config (`eslint.config.js`) using `typescript-eslint` `strictTypeChecked` preset on all non-test source.

**Finding — unsafe-* rules demoted to warnings:** Ten `@typescript-eslint/unsafe-*` and related rules are set to `'warn'` rather than `'error'`. The config comments these as "incremental adoption — demote pervasive pre-existing patterns to warnings." This is an acknowledged technical debt rather than a misconfiguration. The demoted rules are:

```
@typescript-eslint/restrict-template-expressions
@typescript-eslint/no-confusing-void-expression
@typescript-eslint/no-unnecessary-condition
@typescript-eslint/no-base-to-string
@typescript-eslint/no-non-null-assertion
@typescript-eslint/no-unsafe-assignment
@typescript-eslint/no-unsafe-argument
@typescript-eslint/no-unsafe-member-access
@typescript-eslint/no-unsafe-return
@typescript-eslint/no-misused-promises
@typescript-eslint/use-unknown-in-catch-callback-variable
@typescript-eslint/require-await
```

Critical rules remain as errors: `no-unsafe-call`, `no-floating-promises`, `no-dynamic-delete`, `no-deprecated`.

**Recommendation:** Track progress on converting `no-unsafe-assignment` / `no-unsafe-member-access` violations to typed equivalents. These are the highest-value rules to promote to errors.

### Prettier

`.prettierrc` is present and consistent with project conventions (`semi: false`, `singleQuote: true`, `trailingComma: all`, `printWidth: 120`, `tabWidth: 2`). No drift.

---

## License Compliance

**Project license:** MIT

### Production Dependency Licenses

| License | Count | Dependencies |
|---|---|---|
| MIT | 17 | express, react, react-dom, ws, marked, marked-highlight, cmdk, multer, tailwindcss, @tailwindcss/vite, @tabler/icons-react, react-diff-view, react-markdown, remark-gfm, refractor, better-sqlite3, unidiff |
| BSD-3-Clause | 1 | highlight.js |
| MPL-2.0 OR Apache-2.0 | 1 | dompurify |

### Dev Dependency Licenses

| License | Count | Dependencies |
|---|---|---|
| MIT | 15 | eslint, typescript-eslint, vitest, @vitest/coverage-v8, vite, @vitejs/plugin-react, jsdom, eslint-plugin-react-hooks, eslint-plugin-react-refresh, globals, @types/* (8 packages) |
| Apache-2.0 | 1 | typescript |

### Flagged Dependencies

| Package | License | Risk | Notes |
|---|---|---|---|
| `dompurify` | MPL-2.0 OR Apache-2.0 | **Low** | Dual-licensed; the Apache-2.0 alternative is permissively compatible with MIT. The `package.json` `licenseNotes` field explicitly acknowledges this. |
| `lightningcss` (transitive via tailwindcss) | MPL-2.0 | **Low** | Build-time only; not distributed with the runtime. Acknowledged in `licenseNotes`. |

**Conclusion:** No GPL, AGPL, or LGPL dependencies in production or dev. No copyleft exposure. The two MPL-2.0 items are acknowledged and low-risk.

---

## Documentation Freshness

A companion docs audit was generated by the `docs-audit` workflow and saved to `.codekin/reports/docs-audit/2026-04-01_docs-audit.md`. Key findings are summarized here.

### API / Feature Doc Drift

| Document | Last Modified | Issue | Changed Since? |
|---|---|---|---|
| `docs/FEATURES.md` | 2026-03-18 | Missing Agent Joe (shipped v0.5.0), git worktrees, permission mode selector; wrong API paths for Docs Browser (`/api/repos/:repoId/docs` vs actual `/api/docs`) | Yes — v0.5.0 shipped 2026-03-23 |
| `docs/WORKFLOWS.md` | 2026-03-14 | Missing two built-in workflows: `commit-review.md` and `repo-health.weekly.md` | Yes — workflows added after 2026-03-14 |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-03-23 | Status header still reads "Draft v0.1"; feature shipped in v0.5.0 | Yes — feature shipped |
| `CHANGELOG.md` | 2026-03-23 | No v0.5.1 entry; package is at v0.5.1 | Yes — v0.5.1 released 2026-03-28 |

### README Drift

The README describes CLI-managed installation (`codekin upgrade`, `codekin service install`, etc.) which is correct for the npm distribution model. The CLAUDE.md developer scripts (`npm run dev`, `npm test`, `npm run build`, `npm run lint`) match `package.json` exactly.

| README Reference | Actual State | Drift? |
|---|---|---|
| `npm install` | present in package.json | No |
| `npm run dev` | `"dev": "vite"` — matches | No |
| `npm run build` | `"build": "tsc -b && vite build"` — matches | No |
| `npm test` | `"test": "vitest run"` — matches | No |
| `npm run lint` | `"lint": "eslint ."` — matches | No |
| `PORT` default `32352` | Matches server config | No |
| `REPOS_ROOT` default `~/repos` | Matches server config | No |
| `codekin upgrade` / `codekin service *` | CLI commands — not in this repo's package.json (they belong to the npm-distributed CLI package) | No drift — correct reference |

**Finding:** No README drift relative to the dev workflow. The documentation freshness issues are in `docs/` files, not the README.

---

## Draft Changelog

**Period:** Since v0.5.1 tag (2026-03-28) through 2026-04-01
*(7 commits on main since the release tag)*

---

### [Unreleased] — 2026-04-01

#### Features
- **Webhook actor allowlist filter** — Webhook events can now be filtered by actor login via an allowlist, preventing unwanted triggering from bots or service accounts. (#261)

#### Fixes
- **Context size management for GPT and Gemini review tools** — Prevents context overflow when calling external review tools on large diffs or outputs. (#262)

#### Documentation
- **Improved code comments** — Code comment quality improvements across the codebase following the 2026-03-28 comment assessment audit. (#260)

#### Chores
- Updated ExitPlanMode hook behaviour and bumped GPT model default to latest version.
- Added skip patterns for translations, assets, and generated files in workflow scanning.
- Added repo health, code review, and test coverage reports for 2026-03-28 through 2026-04-01.

---

## Stale Branches

**Staleness threshold:** no commit activity in the last 30 days (before 2026-03-02).

**Finding:** No remote branches exceed the 30-day staleness threshold. The oldest branch last touched more than 14 days ago is `origin/chore/repo-health-report-2026-03-14` (18 days old). However, branch hygiene is a significant concern: 29 merged branches have not been deleted, and approximately 28 additional branches are squash-merge remnants (their content is in `main` but `git branch --merged` does not detect them because squash merges create new commits).

### Merged but not deleted (recommend deletion)

These 29 branches are confirmed merged into `main` via `git branch -r --merged origin/main`:

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| origin/chore/dependency-updates-2026-03-18 | 2026-03-19 | alari | Yes | Delete |
| origin/chore/docs-cleanup-2026-03-18 | 2026-03-18 | alari | Yes | Delete |
| origin/chore/repo-health-report-2026-03-20 | 2026-03-21 | alari | Yes | Delete |
| origin/docs/comment-audit-improvements | 2026-03-21 | alari | Yes | Delete |
| origin/docs/v0.5.0-release-notes | 2026-03-23 | alari | Yes | Delete |
| origin/feat/joe-sidebar-icon-status | 2026-03-22 | alari | Yes | Delete |
| origin/feat/joe-sidebar-status-dot | 2026-03-22 | alari | Yes | Delete |
| origin/feat/per-session-allowed-tools | 2026-03-19 | alari | Yes | Delete |
| origin/feat/shepherd-session-cleanup-api | 2026-03-19 | alari | Yes | Delete |
| origin/feat/sidebar-status-tooltips | 2026-03-22 | alari | Yes | Delete |
| origin/fix/agent-joe-cron-tools | 2026-03-22 | alari | Yes | Delete |
| origin/fix/agent-joe-session-sidebar | 2026-03-19 | alari | Yes | Delete |
| origin/fix/agent-session-icon | 2026-03-22 | alari | Yes | Delete |
| origin/fix/bug-fixes-2026-03-18 | 2026-03-19 | alari | Yes | Delete |
| origin/fix/code-review-audit-findings | 2026-03-21 | alari | Yes | Delete |
| origin/fix/cron-create-split-error | 2026-03-22 | alari | Yes | Delete |
| origin/fix/increase-shepherd-concurrency | 2026-03-19 | alari | Yes | Delete |
| origin/fix/native-permissions-dual-write | 2026-03-21 | alari | Yes | Delete |
| origin/fix/orchestrator-listener-leak-and-type-safety | 2026-03-24 | alari | Yes | Delete |
| origin/fix/orchestrator-path-guards | 2026-03-23 | alari | Yes | Delete |
| origin/fix/orchestrator-session-icon-color | 2026-03-23 | alari | Yes | Delete |
| origin/fix/security-hardening-2026-03-18 | 2026-03-18 | Claude (Webhook) | Yes | Delete |
| origin/fix/session-allowedtools-hook-bypass | 2026-03-19 | alari | Yes | Delete |
| origin/fix/shepherd-icon-status-color | 2026-03-22 | alari | Yes | Delete |
| origin/fix/tool-split-error | 2026-03-22 | alari | Yes | Delete |
| origin/refactor/reduce-complexity-2026-03-18 | 2026-03-18 | alari | Yes | Delete |
| origin/test/diff-parser-coverage-2026-03-18 | 2026-03-18 | alari | Yes | Delete |
| origin/wt/8ea42b7c | 2026-03-23 | alari76 | Yes | Delete (orphaned worktree branch) |
| origin/wt/ec931b88 | 2026-03-23 | alari76 | Yes | Delete (orphaned worktree branch) |

**Bulk delete command (safe — all confirmed merged):**
```bash
git branch -r --merged origin/main | grep -v 'origin/main' | sed 's|origin/||' | xargs -I{} git push origin --delete {}
```

### Unmerged branches (squash-merge remnants — content already in main)

These branches show as unmerged by git but their corresponding PRs were squash-merged. Review individually before deleting.

| Branch | Last Commit | Evidence Content Is in Main |
|---|---|---|
| origin/fix/exit-plan-mode-deny-with-message | 2026-03-24 | Commit `94d5244` on main |
| origin/fix/orchestrator-empty-state-layout | 2026-03-24 | Commit `8fbb5a6` on main |
| origin/fix/remove-stall-timer | 2026-03-24 | Commit `a62efa8` on main |
| origin/fix/suppress-orchestrator-noise | 2026-03-24 | Commit `b9e8659` on main |
| origin/fix/plan-mode-gating-enforcement | 2026-03-25 | Commit `ec9e689` on main |
| origin/refactor/plan-manager-state-machine | 2026-03-25 | Commit `499e6fd` on main |
| origin/docs/improve-code-comments | 2026-03-28 | Commit `67477d0` on main |
| origin/feat/webhook-actor-allowlist | 2026-03-29 | Commit `ab0f422` on main |
| origin/fix/review-tool-context-limits | 2026-03-29 | Commit `b9d8b10` on main |
| *(and ~19 more from 2026-03-22–2026-03-23)* | 2026-03-22–23 | Merged during v0.5.0 development |

---

## PR Hygiene

| PR# | Title | Author | Days Open | Review Status | Mergeable | Stuck? |
|---|---|---|---|---|---|---|
| #263 | chore: add repo health and code review reports for 2026-03-28 through 2026-03-30 | alari76 | 2 | No review | Yes | No |
| #259 | chore: add repo health reports for 2026-03-25 and 2026-03-26 | alari76 | 6 | No review | Yes | Approaching (threshold: 7 days) |

**Notes:**
- Both PRs are automated chore/reporting PRs — they do not require feature review but should be merged promptly to keep report branches clean.
- PR #259 will cross the 7-day "stuck" threshold on 2026-04-02 if not merged.
- No feature or fix PRs are currently open.

---

## Merge Conflict Forecast

**Active branches** = last commit within 14 days (since 2026-03-18). Only branches with genuine unmerged content are assessed here.

| Branch | Commits Ahead of Main | Commits Behind Main | Files Modified (branch) | Overlapping Files with Main | Risk |
|---|---|---|---|---|---|
| origin/chore/repo-health-report-2026-03-30 (current) | 3 | 3 | `.codekin/reports/**` only | None (report files are additive) | **Low** |
| origin/chore/repo-health-report-2026-03-26 | ~2 | ~5 | `.codekin/reports/**` only | None | **Low** |
| origin/chore/repo-health-report-2026-03-25 | ~2 | ~6 | `.codekin/reports/**` only | None | **Low** |
| origin/feat/joe-chat-variant | ~5 | ~10 | `src/components/**` | Possible overlap with UI changes in main | **Medium** — needs rebase check |
| origin/feat/session-lifecycle-hooks | ~3 | ~10 | `server/**` | Possible overlap with session/orchestrator changes | **Medium** — needs rebase check |
| origin/codekin/reports | ~3 | ~15 | `.codekin/**` | Report paths | **Low** |

**Notes:**
- The `feat/joe-chat-variant` and `feat/session-lifecycle-hooks` branches have not been updated since 2026-03-17 and 2026-03-23 respectively. They predate significant orchestrator refactors and are likely to have conflicts if resumed. These should be rebased or closed.
- Report-only branches have no source code overlap and carry no conflict risk.

---

## Recommendations

1. **Delete the 29 merged remote branches.** This is the highest-impact hygiene action. Run the bulk-delete command in the Stale Branches section above. The `wt/*` worktree branches are safe to delete — they are orphaned worktree refs with no associated local state.

2. **Merge or close PR #259 immediately** (age: 6 days). It crosses the 7-day stuck threshold tomorrow. Both open PRs are reporting chores that should be merged without ceremony. PR #263 should follow.

3. **Update `docs/FEATURES.md`** to add Agent Joe / Orchestrator content and fix the Docs Browser API paths. This is the most user-visible documentation gap — the headline v0.5.0 feature is absent from the primary feature reference. See the companion docs-audit report for specific sections needed.

4. **Add a `CHANGELOG.md` entry for v0.5.1.** The package is at v0.5.1 (released 2026-03-28) but the changelog ends at v0.5.0. Even a minimal patch entry maintains changelog reliability.

5. **Update `docs/WORKFLOWS.md`** to add `commit-review` and `repo-health.weekly` to the built-in workflows table. Users will see these workflows in the UI with no documentation.

6. **Review and close `feat/joe-chat-variant` and `feat/session-lifecycle-hooks`** if they are no longer being pursued. Both are >10 commits behind main after significant orchestrator refactors. If still wanted, they need a rebase before the divergence grows further.

7. **Promote ESLint `no-unsafe-assignment` and `no-unsafe-member-access` to errors** incrementally. These two rules, currently at warning level, represent the highest type-safety value. Fixing the underlying `any` types would make the codebase fully `strictTypeChecked`-compliant at error level.

8. **Enable automatic branch deletion on merge** in the GitHub repository settings (Settings → General → "Automatically delete head branches"). This prevents the accumulation of merged branches and eliminates the need for periodic manual cleanup.

9. **Align `workflows/tsconfig.json` with `server/tsconfig.json`** by removing `esModuleInterop: true` from workflows (or adding it to server if it's actually needed). The inconsistency is minor but could cause subtle module resolution differences if the targets diverge.

10. **Fix `docs/ORCHESTRATOR-SPEC.md` status header** from "Draft v0.1" to "Phase 1 implemented (v0.5.0)". Single-line change that prevents contributor confusion when reading the spec.
