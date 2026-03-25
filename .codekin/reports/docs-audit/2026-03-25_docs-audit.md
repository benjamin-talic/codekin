# Repository Health Report — 2026-03-25

> **Scope:** Codekin v0.5.0 | Branch: `main` | Generated: 2026-03-25

---

## Summary

**Overall Health: Good**

The codebase is in strong shape. TypeScript strict mode is enforced across all configs, no TODO/FIXME comments exist in source files, the README is accurate, and no open PRs are pending. The primary concerns are a growing accumulation of stale/merged remote branches (29 confirmed, ~24 more squash-merged orphans) and a stale `docs/API-REFERENCE.md` that has not been updated despite 13 server route commits since its last edit. Dead code is minimal and limited to internal-only exports that should simply have their `export` keyword removed.

| Metric | Count |
|---|---|
| Dead code items | 3 |
| TODO/FIXME comments | 0 |
| Config issues | 2 (minor) |
| License concerns | 2 (UNKNOWN label, benign) |
| Doc drift items | 1 (API-REFERENCE.md) |
| Merged branches pending deletion | 29 |
| Squash-merged orphan branches | ~24 |
| Open PRs | 0 |
| Stuck PRs | 0 |

---

## Dead Code

| File | Export / Function | Type | Recommendation |
|---|---|---|---|
| `server/commit-event-hooks.ts` | `HookConfig` (interface) | Unused export | Used only within the same file; remove `export` keyword |
| `server/commit-event-hooks.ts` | `installCommitHook`, `uninstallCommitHook` | Unused exports | Called only by `syncCommitHooks` in the same file; remove `export` keywords |
| `server/orchestrator-learning.ts` | `findDuplicate` | Unused export | Called only by `smartUpsert` in the same file; remove `export` keyword |

**Notes:**
- No orphan source files detected — every `.ts`/`.tsx` in `src/` and `server/` is reachable from an entry point.
- All other exported symbols in `server/orchestrator-learning.ts` (`extractMemoryCandidates`, `smartUpsert`, `recordFindingOutcome`, `loadSkillProfile`, `updateSkillLevel`, `getGuidanceStyle`, `recordDecision`, `assessDecisionOutcome`, `getPendingOutcomeAssessments`, `runAgingCycle`) are actively imported by `orchestrator-routes.ts` and/or `orchestrator-monitor.ts`.
- `session-restart-scheduler.ts` exports (`evaluateRestart`, `RestartState`, `RestartAction`) are actively used by `session-manager.ts`.

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, `XXX`, or `WORKAROUND` comments were found in any source file (`.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`). The only matches in the entire repository are test assertion strings that use the word `TODO` as a search pattern argument in `claude-process.test.ts`.

**Summary:**

| Type | Count | Stale (>30 days) |
|---|---|---|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 0 | 0 |
| **Total** | **0** | **0** |

---

## Config Drift

### TypeScript (`tsconfig.app.json` / `tsconfig.node.json` / `server/tsconfig.json`)

| Config File | Setting | Current Value | Status |
|---|---|---|---|
| All three | `strict` | `true` | Good |
| All three | `noUnusedLocals` | `true` | Good |
| All three | `noUnusedParameters` | `true` | Good |
| All three | `noFallthroughCasesInSwitch` | `true` | Good |
| All three | `skipLibCheck` | `true` | Acceptable for large dependency trees |
| `tsconfig.app.json` | `target` | `ES2022` | Good |
| `tsconfig.node.json` | `target` | `ES2023` | Minor skew — one version ahead of app config |
| `tsconfig.app.json` / `tsconfig.node.json` | `noPropertyAccessFromIndexSignature` | not set | Consider enabling for stricter index access safety |

**Finding 1 — Target version skew:** `tsconfig.app.json` targets `ES2022` while `tsconfig.node.json` targets `ES2023`. Both are defensible (browser vs. Node runtime), but the gap could cause subtle cross-environment issues if shared code paths rely on ES2023-only features.

**Finding 2 — ESLint rule demotion:** `eslint.config.js` intentionally demotes 10+ `@typescript-eslint` rules from `error` to `warn` (e.g. `restrict-template-expressions`, `no-non-null-assertion`, `no-unsafe-assignment`, `no-misused-promises`). The config comment acknowledges these as pre-existing patterns for incremental cleanup. They should be promoted to `error` over time to fully realize strict-lint benefits.

### Prettier (`/.prettierrc`)

| Setting | Value | Status |
|---|---|---|
| `semi` | `false` | Non-default; project-wide consistent |
| `singleQuote` | `true` | Non-default; project-wide consistent |
| `trailingComma` | `"all"` | Good |
| `printWidth` | `120` | Wider than default (80); acceptable for this codebase |
| `tabWidth` | `2` | Good |

No issues with Prettier config.

---

## License Compliance

Project license: **MIT**

### Summary Table

| License | Dependency Count |
|---|---|
| MIT | 524 |
| ISC | 23 |
| Apache-2.0 | 19 |
| MPL-2.0 | 12 |
| BSD-3-Clause | 10 |
| BSD-2-Clause | 8 |
| BlueOak-1.0.0 | 4 |
| MIT-0 | 2 |
| UNKNOWN | 2 |
| Python-2.0 | 1 |
| CC-BY-4.0 | 1 |
| CC0-1.0 | 1 |
| 0BSD | 1 |
| (MPL-2.0 OR Apache-2.0) | 1 |
| (MIT OR WTFPL) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |

### Flagged Dependencies

| Package | Reported License | Concern | Assessment |
|---|---|---|---|
| `busboy` | UNKNOWN | `license` field missing in `package-lock.json` | Transitive dep of `multer`; widely known to be MIT/ISC. No legal risk, but automated compliance tools will flag it. Consider adding to `licenseNotes`. |
| `streamsearch` | UNKNOWN | `license` field missing in `package-lock.json` | Transitive dep of `busboy`. Same situation as above. |

**MPL-2.0 note:** `dompurify` (`MPL-2.0 OR Apache-2.0`) and `lightningcss` (build-time `MPL-2.0`) are correctly documented in `package.json`'s `licenseNotes` field. No copyleft concern for distribution.

**No GPL, AGPL, or LGPL dependencies detected.**

---

## Documentation Freshness

### API Docs

| Doc File | Last Updated | Server Route Commits Since | Status |
|---|---|---|---|
| `docs/API-REFERENCE.md` | 2026-03-16 (9 days ago) | 13 | **Stale** |
| `docs/ORCHESTRATOR-SPEC.md` | 2026-03-23 (2 days ago) | 0 | Current |
| `docs/stream-json-protocol.md` | 2026-03-22 (3 days ago) | 0 | Current |
| `docs/FEATURES.md` | ~2026-03-18 | — | Likely current |

**Stale: `docs/API-REFERENCE.md`** — 13 commits have touched `server/session-routes.ts` and `server/orchestrator-routes.ts` since this file was last updated. Notable additions not yet reflected in the docs:

- Session lifecycle hook endpoints added in PR #235 (`/orchestrator/lifecycle/*`)
- Orchestrator child approval endpoints
- AskUserQuestion routing changes (now via PreToolUse hook rather than `control_request`)
- Changes to the orchestrator path guard and `branchName` validation (#237)

### README Drift

| README Claim | Actual State | Status |
|---|---|---|
| `npm run dev` — start Vite dev server | Script exists in `package.json` | Correct |
| `npm run build` — typecheck + production build | `tsc -b && vite build` | Correct |
| `npm test` — run tests once | `vitest run` | Correct |
| `npm run test:watch` — watch mode | `vitest` | Correct |
| `npm run lint` — eslint | `eslint .` | Correct |
| Server port default: `32352` | Matches `server/config.ts` | Correct |
| `REPOS_ROOT` env var | Matches `server/config.ts` | Correct |
| `docs/INSTALL-DISTRIBUTION.md` referenced | File exists | Correct |
| `CONTRIBUTING.md` referenced | File exists | Correct |

**No README drift detected.** All install steps, scripts, and configuration references are accurate and match current project structure.

---

## Draft Changelog

### Unreleased (since v0.5.0 — 2026-03-23)

#### Features

- Add session lifecycle hooks and orchestrator approval endpoints for child session management (#235)

#### Fixes

- Resolve orchestrator listener leak, type-unsafe mutations, and wrong report path (#253)
- Show stall warning only once per user input cycle; remove persistent banner from chat (#252, #256)
- Use deny-with-message pattern for ExitPlanMode hook approval (#255)
- Improve orchestrator empty state layout (#254)
- Suppress repetitive orchestrator noise in chat (#251)
- Prevent ExitPlanMode double-approval and timeout-denial bugs (#245)
- Exit plan mode immediately when PreToolUse hook approves ExitPlanMode (#244)
- Save exact commands when "Always Allow" clicked for non-patternable tools (#246)
- Prevent double-gating race condition in orchestrator respond endpoint (#241)
- Avoid marking child session completed while tool approvals are pending (#240)
- Wire up orchestrator prompt listener; extend child approval timeout (#238)
- Harden orchestrator report path guard and branchName validation (#237)
- Update orchestrator system prompt to reflect 5 concurrent session limit (#236)
- Use gray color for orchestrator approval/denial messages (#243)
- Polish orchestrator chat view: resizable input, remove clutter (#247)
- Add missing `isOrchestrator` dep to `onDragStart` useCallback (#248)
- Update orchestrator spec to reflect 5 concurrent session limit (#249)
- Remove unnecessary template literal in ws-server prompt notification (#239)

#### Tests

- Fix code coverage gaps from March 16 coverage audit (#233)

#### Chores

- Bump version to 0.5.0
- Add automated repo health reports for 2026-03-23 and 2026-03-24

---

## Stale Branches

### Confirmed Merged (via `git branch -r --merged origin/main`) — Safe to Delete

All 29 branches below are fully merged into `main` with no unmerged commits remaining.

| Branch | Last Commit | Author | Merged? | Recommendation |
|---|---|---|---|---|
| `chore/dependency-updates-2026-03-18` | 2026-03-19 | alari | Yes | Delete |
| `chore/docs-cleanup-2026-03-18` | 2026-03-18 | alari | Yes | Delete |
| `chore/repo-health-report-2026-03-18` | 2026-03-18 | alari | Yes | Delete |
| `chore/repo-health-report-2026-03-20` | 2026-03-21 | alari | Yes | Delete |
| `docs/comment-audit-improvements` | 2026-03-21 | alari | Yes | Delete |
| `docs/v0.5.0-release-notes` | 2026-03-23 | alari | Yes | Delete |
| `feat/joe-sidebar-icon-status` | 2026-03-22 | alari | Yes | Delete |
| `feat/joe-sidebar-status-dot` | 2026-03-22 | alari | Yes | Delete |
| `feat/per-session-allowed-tools` | 2026-03-19 | alari | Yes | Delete |
| `feat/shepherd-session-cleanup-api` | 2026-03-19 | alari | Yes | Delete |
| `feat/sidebar-status-tooltips` | 2026-03-22 | alari | Yes | Delete |
| `fix/agent-joe-cron-tools` | 2026-03-22 | alari | Yes | Delete |
| `fix/agent-joe-session-sidebar` | 2026-03-19 | alari | Yes | Delete |
| `fix/agent-session-icon` | 2026-03-22 | alari | Yes | Delete |
| `fix/bug-fixes-2026-03-18` | 2026-03-19 | alari | Yes | Delete |
| `fix/code-review-audit-findings` | 2026-03-21 | alari | Yes | Delete |
| `fix/cron-create-split-error` | 2026-03-22 | alari | Yes | Delete |
| `fix/increase-shepherd-concurrency` | 2026-03-19 | alari | Yes | Delete |
| `fix/native-permissions-dual-write` | 2026-03-21 | alari | Yes | Delete |
| `fix/orchestrator-listener-leak-and-type-safety` | 2026-03-24 | alari | Yes | Delete |
| `fix/orchestrator-path-guards` | 2026-03-23 | alari | Yes | Delete |
| `fix/orchestrator-session-icon-color` | 2026-03-23 | alari | Yes | Delete |
| `fix/security-hardening-2026-03-18` | 2026-03-18 | Claude (Webhook) | Yes | Delete |
| `fix/session-allowedtools-hook-bypass` | 2026-03-19 | alari | Yes | Delete |
| `fix/shepherd-icon-status-color` | 2026-03-22 | alari | Yes | Delete |
| `fix/tool-split-error` | 2026-03-22 | alari | Yes | Delete |
| `refactor/reduce-complexity-2026-03-18` | 2026-03-18 | alari | Yes | Delete |
| `test/diff-parser-coverage-2026-03-18` | 2026-03-18 | alari | Yes | Delete |
| `wt/8ea42b7c` | 2026-03-23 | alari76 | Yes | Delete (worktree remnant) |
| `wt/ec931b88` | 2026-03-23 | alari76 | Yes | Delete (worktree remnant) |

### Squash-Merged Orphans — Content Confirmed in `main`, Branch SHA Not Tracked by Git

These branches appear unmerged to `git branch --merged` because the project uses squash merges, but their content is confirmed present in `main` by subject-line matching. Safe to delete.

| Branch | Last Commit | Content in `main` |
|---|---|---|
| `fix/always-allow-exact-commands` | 2026-03-23 | Yes — PR #246 |
| `fix/control-response-format` | 2026-03-22 | Yes — PR #223 |
| `fix/exit-plan-mode-approval-bugs` | 2026-03-23 | Yes — PR #245 |
| `fix/exit-plan-mode-deny-with-message` | 2026-03-24 | Yes — PR #255 |
| `fix/exit-plan-mode-stuck-after-approval` | 2026-03-23 | Yes — PR #244 family |
| `fix/orchestrator-approval-wiring` | 2026-03-23 | Yes — PR #238 family |
| `fix/orchestrator-chat-polish` | 2026-03-23 | Yes — PR #247 |
| `fix/orchestrator-concurrent-limit` | 2026-03-23 | Yes — PR #249 |
| `fix/orchestrator-concurrent-limit-docs` | 2026-03-23 | Yes — PR #249 |
| `fix/orchestrator-empty-state-layout` | 2026-03-24 | Yes — PR #254 |
| `fix/orchestrator-greeting-guidelines` | 2026-03-22 | Yes — PR #226 |
| `fix/orchestrator-info-message-color` | 2026-03-23 | Yes — PR #243 |
| `fix/orchestrator-repo-policy-discovery` | 2026-03-22 | Yes — PR #227 |
| `fix/orchestrator-security-hardening` | 2026-03-23 | Yes — PR #237 family |
| `fix/pending-prompts-completed-sessions` | 2026-03-23 | Yes — PR #240 |
| `fix/plan-mode-exit-stuck` | 2026-03-22 | Yes — PR #221 |
| `fix/remove-shepherd-rename-orchestrator` | 2026-03-22 | Yes — PR #225 |
| `fix/remove-stall-timer` | 2026-03-24 | Yes — PR #256 |
| `fix/respond-endpoint-race-condition` | 2026-03-23 | Yes — PR #241 |
| `fix/suppress-orchestrator-noise` | 2026-03-24 | Yes — PR #252 |
| `refactor/shepherd-to-orchestrator` | 2026-03-22 | Yes — PR #224 |
| `test/approval-flow-v3` | 2026-03-23 | Yes — PR #233 family |
| `test/coverage-gaps` | 2026-03-23 | Yes — PR #233 |
| `ui/question-prompt-sizing` | 2026-03-22 | Yes — PR #232 |

### Potentially Active or Intentional — Review Before Deleting

| Branch | Last Commit | Commits Ahead of `main` | Notes |
|---|---|---|---|
| `feat/joe-chat-variant` | 2026-03-17 | 1 | WIP chat variant; review or close if abandoned |
| `feat/session-lifecycle-hooks` | 2026-03-23 | 2 | Recent; may have follow-on work not yet PRed |
| `chore/repo-health-report-2026-03-14` | 2026-03-14 | 2 | Webhook-generated health report; check if content was committed to `main` separately |
| `codekin/reports` | 2026-03-16 | 32 | Dedicated reports-storage branch with 32 unique commits — intentional? Clarify purpose |

---

## PR Hygiene

No open pull requests. `gh pr list` returned an empty result.

All recent work has been merged. No stuck, stale, or conflict-blocked PRs to report.

---

## Merge Conflict Forecast

No branches with significant divergence from `main` and overlapping active file edits were detected. All recent `fix/` branches are either merged or contain a single squash-mergeable commit against a now-stable area.

| Branch | Commits Ahead | Potential Overlap with `main` | Risk |
|---|---|---|---|
| `feat/joe-chat-variant` | 1 | Possibly `ChatView.tsx`, `OrchestratorView.tsx` — heavily modified in recent PRs | Low–Medium |
| `feat/session-lifecycle-hooks` | 2 | Possibly `orchestrator-routes.ts`, `orchestrator-monitor.ts` | Low |

---

## Recommendations

1. **Delete 29 confirmed-merged remote branches** — These are safe to remove immediately. Run `git push origin --delete <branch>` for each entry in the "Confirmed Merged" table or use `gh api` bulk deletion. Consider configuring GitHub to auto-delete branches on PR merge.

2. **Delete ~24 squash-merged orphan branches** — Their content is confirmed in `main`. Because the project uses squash merges exclusively, `git branch --merged` will never detect them. Add a periodic cleanup step (e.g. a weekly workflow) to prune branches whose tip-commit subject matches a commit already on `main`.

3. **Update `docs/API-REFERENCE.md`** — 13 server route commits have landed since 2026-03-16. At minimum: document the session lifecycle hook endpoints added in #235, the orchestrator approval endpoints, and the AskUserQuestion handling change.

4. **Resolve or close `feat/joe-chat-variant`** — Open since 2026-03-17 with one WIP commit. Open a PR to merge if the variant is ready, or delete the branch to reduce clutter.

5. **Clarify the `codekin/reports` branch purpose** — 32 commits not present in `main`. If this is intentional (a separate orphan history for storing generated reports), document it. If the reports should live on `main`, decide on a consolidation strategy.

6. **Remove `export` from three internal-only symbols** — `HookConfig`, `installCommitHook`, `uninstallCommitHook` (all in `commit-event-hooks.ts`) and `findDuplicate` (`orchestrator-learning.ts`) are never imported outside their own file. Removing `export` reduces the public API surface and lets TypeScript enforce their private scope.

7. **Promote ESLint `warn` rules to `error` incrementally** — `eslint.config.js` has 10 type-safety rules downgraded to `warn`. Create a tracking issue and promote them one at a time as the code is cleaned up: start with `no-non-null-assertion` and `restrict-template-expressions`, which are the most common sources of runtime surprises.

8. **Add `busboy` and `streamsearch` to `licenseNotes`** — These two packages have `UNKNOWN` license entries in `package-lock.json`. They are known permissive dependencies, but documenting them in `package.json`'s `licenseNotes` field (as is done for DOMPurify and lightningcss) will prevent automated compliance tools from flagging them.

9. **Consider enabling `noPropertyAccessFromIndexSignature`** — All three tsconfigs are missing this flag. Enabling it would prevent silent `undefined` values from index signatures slipping through the type checker, which complements the existing `strict: true` setup.

10. **Align TypeScript `target` versions** — `tsconfig.app.json` targets `ES2022` and `tsconfig.node.json` targets `ES2023`. Either align them or add a comment explaining the intentional divergence, so future contributors understand why they differ.
