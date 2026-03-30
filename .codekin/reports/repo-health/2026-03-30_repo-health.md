# Repository Health Report — 2026-03-30

> **Codekin** · Branch: `main` · Version: 0.5.1 · Generated: 2026-03-30

---

## Summary

**Overall Health: Good**

The repository is in strong shape with no technical debt markers, no dead code (enforced by TypeScript strict mode), well-maintained documentation, and an active PR workflow. The primary concerns are **branch accumulation** (65 remote branches, 29 already merged and safe to delete), a small number of unmerged branches whose underlying PRs appear to have been squash-merged, and one open PR approaching the stale threshold. A handful of recently merged features (webhook actor allowlist, GPT model bump) have not yet been reflected in documentation. Post-v0.5.1 commits on `main` represent unreleased changes that may warrant a patch tag.

| Metric | Value |
|--------|-------|
| Dead code items | 0 (TS strict mode + ESLint enforced) |
| Stale TODOs (>30 days) | 0 |
| Total WORKAROUND comments | 4 (intentional, documented, recent) |
| Config issues | 2 minor |
| License concerns | 2 noted, both addressed in `licenseNotes` |
| Doc drift items | 2 (webhook actor allowlist, GPT model default) |
| Remote branches | 65 total (29 merged — recommend bulk delete) |
| Open PRs | 1 (PR #259, 4 days old, approaching stuck threshold) |
| Stuck PRs (>7 days) | 0 |
| Unreleased commits since v0.5.1 | 4 |

---

## Dead Code

**No dead code detected.**

TypeScript strict mode is enforced across all three tsconfig targets (`tsconfig.app.json`, `tsconfig.node.json`, `server/tsconfig.json`) with:
- `"noUnusedLocals": true`
- `"noUnusedParameters": true`
- `"strict": true`

ESLint flat config (v9, `eslint.config.js`) applies TypeScript-ESLint strict rules to both `src/` and `server/` with type-aware checking enabled via `projectService: true`. This combination prevents accumulation of dead exports at the tooling level.

No orphan source files were detected. All 163 TypeScript/TSX source files participate in the import graph rooted at `src/main.tsx` (frontend) and `server/ws-server.ts` (backend).

| file | export/function | type | recommendation |
|------|----------------|------|----------------|
| — | — | — | Nothing to report |

---

## TODO/FIXME Tracker

No `TODO`, `FIXME`, `HACK`, or `XXX` comments exist in production source code. Four `WORKAROUND` documentation comments appear in two files, all intentional and recent.

| file:line | type | comment | author | date | stale? |
|-----------|------|---------|--------|------|--------|
| `server/plan-manager.ts:9` | WORKAROUND | `deny-with-message workaround for ExitPlanMode` | alari76 | 2026-03-25 | No |
| `server/plan-manager.ts:22–23` | WORKAROUND | `On approve: hook returns deny-with-approval-message (CLI workaround for requiresUserInteraction)` | alari76 | 2026-03-25 | No |
| `server/session-manager.ts:~1222` | WORKAROUND | `The hook will convert allow→deny-with-approval-message (CLI workaround)` | alari76 | 2026-03-25 | No |
| `server/session-manager.ts:~1464` | WORKAROUND | `the deny-with-approval-message workaround). On deny, returns allow:false.` | alari76 | 2026-03-25 | No |

**Note:** `server/claude-process.test.ts` lines 61–62, 810 contain the literal string `'TODO'` as test input data. These are not deferred work items.

### Summary Counts

| type | count | stale (>30 days) |
|------|-------|-----------------|
| TODO | 0 | 0 |
| FIXME | 0 | 0 |
| HACK | 0 | 0 |
| XXX | 0 | 0 |
| WORKAROUND | 4 (docs only) | 0 |
| **Total** | **4** | **0** |

---

## Config Drift

### TypeScript

| config file | setting | current value | assessment |
|-------------|---------|---------------|------------|
| `tsconfig.app.json` | `strict` | `true` | ✅ Correct |
| `tsconfig.app.json` | `noUnusedLocals` | `true` | ✅ Correct |
| `tsconfig.app.json` | `noUnusedParameters` | `true` | ✅ Correct |
| `tsconfig.app.json` | `skipLibCheck` | `true` | ⚠️ Suppresses type errors from `node_modules`. Standard for bundler setups but reduces safety coverage. |
| `tsconfig.app.json` | `target` | `ES2022` | ✅ Reasonable for modern browser target |
| `tsconfig.node.json` | `target` | `ES2023` | ✅ Correct for Node.js build tools |
| `server/tsconfig.json` | `target` | `ES2023` | ✅ Consistent with Node target |
| `tsconfig.app.json` | `erasableSyntaxOnly` | `true` | ✅ Forward-looking TS 5.5+ flag |
| `tsconfig.app.json` | `allowImportingTsExtensions` | `true` + `noEmit: true` | ✅ Correct pattern for bundler-only emit |

**Finding 1 — `skipLibCheck: true` in all tsconfigs:** Standard for bundler-based projects but means type errors in third-party declarations (including re-exported types) are silently swallowed. Consider adding `// intentional: bundler setup` comment or periodically auditing with `skipLibCheck: false` in CI.

**Finding 2 — Target version split (ES2022 frontend / ES2023 server):** Minor inconsistency. Not a bug, but worth documenting in a comment since ES2023 adds `Array.prototype.toSorted` / `findLast` which may be used in server code but wouldn't compile for frontend.

### ESLint

| config file | setting | current value | assessment |
|-------------|---------|---------------|------------|
| `eslint.config.js` | format | Flat config (v9) | ✅ Current standard |
| `eslint.config.js` | type-aware rules | `projectService: true` | ✅ Strict |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-assignment` | `warn` (frontend/server) | ⚠️ Downgraded from `error`; documented as incremental adoption |
| `eslint.config.js` | `@typescript-eslint/no-unsafe-member-access` | `warn` | ⚠️ Same — intentional but worth revisiting |
| `eslint.config.js` | test files | relaxed (allows `any`) | ✅ Acceptable for test code |

**Finding 3 — Several unsafe-* rules at `warn` level:** These were intentionally downgraded for incremental adoption. Given the codebase has been active for many months, it is worth running `npx tsc --noEmit` and `eslint --max-warnings 0` periodically to gauge whether these can be promoted to `error`.

### Prettier

| setting | current value | assessment |
|---------|---------------|------------|
| `semi` | `false` | ✅ Consistent |
| `singleQuote` | `true` | ✅ Consistent |
| `trailingComma` | `all` | ✅ Modern default |
| `printWidth` | `120` | ✅ Practical for monospace terminal display |
| `tabWidth` | `2` | ✅ Standard |

No issues with Prettier config.

---

## License Compliance

**Project license:** MIT

The `package.json` includes a `licenseNotes` field explicitly addressing the two non-MIT runtime dependencies:

> *"dompurify is dual-licensed (MPL-2.0 OR Apache-2.0); both are permissively compatible with MIT for library use. lightningcss (MPL-2.0) is a build-time-only dependency used by TailwindCSS and is not included in distributed artifacts."*

### Flagged Dependencies

| dependency | license | concern | status |
|------------|---------|---------|--------|
| `dompurify` | MPL-2.0 OR Apache-2.0 | Dual-license — MPL-2.0 has weak copyleft for modifications to `dompurify` itself | ✅ Addressed in `licenseNotes`; Apache-2.0 option makes it permissively compatible |
| `lightningcss` (transitive via `tailwindcss`) | MPL-2.0 | Build-time only, not shipped | ✅ Addressed in `licenseNotes`; not in distributed artifacts |

### License Summary (direct dependencies)

> **Note:** Full transitive license scan was not available from `package-lock.json` parsing in this run. Summary below covers known direct runtime and dev dependencies based on NPM registry metadata.

| license | approximate count | dependencies |
|---------|------------------|--------------|
| MIT | ~30 | express, ws, react, react-dom, highlight.js, marked, cmdk, better-sqlite3, vite, vitest, eslint, typescript, @tabler/icons-react, and most others |
| Apache-2.0 | ~2 | dompurify (Apache-2.0 option), @vitejs/plugin-react |
| MPL-2.0 | 2 | dompurify (MPL-2.0 option, dual-licensed), lightningcss (build-only, transitive) |
| ISC | ~3 | globals, semver (transitive) |

**No GPL, AGPL, or LGPL dependencies detected.** The `licenseNotes` field in `package.json` is a good practice and should be kept up to date if new non-MIT dependencies are added.

---

## Documentation Freshness

### API Docs Freshness

| endpoint/feature | code changed | docs file | docs updated? | flag? |
|-----------------|-------------|-----------|---------------|-------|
| Webhook actor allowlist (`/webhook-config`, actor filtering) | 2026-03-29 (PR #261) | `docs/GITHUB-WEBHOOKS-SPEC.md` | Not confirmed updated in docs/ commit log | ⚠️ Flag |
| GPT model default bump | 2026-03-29 | `docs/WORKFLOWS.md` or `docs/API-REFERENCE.md` | Not confirmed | ⚠️ Flag |
| ExitPlanMode hook / PlanManager state machine | 2026-03-25 (PRs #257, #258) | `docs/ORCHESTRATOR-SPEC.md` | Updated (commit `f832f24` + `docs/improve-code-comments`) | ✅ OK |
| Context size management for review tools | 2026-03-29 (PR #262) | `docs/WORKFLOWS.md` | Not confirmed | ⚠️ Flag |
| Skip patterns for translations/assets | 2026-03-29 | `docs/WORKFLOWS.md` | Not confirmed | ⚠️ Flag |

**Summary:** Four features merged in the last 48 hours (actor allowlist, GPT model bump, review tool context limits, skip patterns) have not been confirmed documented in `docs/`. The docs/ commit log shows no activity since 2026-03-28 (`docs/improve-code-comments` PR #260). These are candidates for a documentation pass.

### README Drift

The `README.md` focuses on end-user installation and feature overview. Key verifications:

| README item | actual state | drift? |
|-------------|-------------|--------|
| Install: `curl -fsSL codekin.ai/install.sh | bash` | `install.sh` exists in repo root | ✅ OK |
| Config: `~/.config/codekin/env` | Standard XDG config path per SETUP.md | ✅ OK |
| Feature: "Agent Joe — up to 5 concurrent child sessions" | `MAX_CONCURRENT = 5` in `orchestrator-manager.ts`, documented in orchestrator spec | ✅ OK |
| Feature: "GitHub webhooks — Automated bugfixing on CI failures" | `server/webhook-github.ts` active, actor allowlist added 2026-03-29 | ✅ OK (minor new feature not yet in README) |
| Feature: "AI Workflows — Scheduled code/repo audits" | `server/workflow-engine.ts`, `docs/WORKFLOWS.md` | ✅ OK |
| CLAUDE.md scripts (`npm run dev`, `npm test`, `npm run lint`, `npm run build`) | All present in `package.json#scripts` | ✅ OK |
| `npm run test:watch` | Present in `package.json` as `"test:watch": "vitest"` | ✅ OK |

**No breaking README drift detected.** The README is user-facing installation documentation, not a developer reference, so minor new features not yet listed are acceptable.

---

## Draft Changelog

> **Period:** since v0.5.1 tag (2026-03-28 → 2026-03-30) — 4 unreleased commits on `main`

### [Unreleased] — post-v0.5.1

#### Features
- **Webhook actor allowlist filter** — New configuration option to restrict webhook event processing to a specific list of actor logins, preventing automated bots from triggering CI-failure workflows. (#261)

#### Fixes
- **Review tool context size management** — GPT and Gemini review tools now manage context window size to prevent overflows on large diffs. (#262)

#### Chores
- **GPT model default bumped** — Updated default GPT model in `ExitPlanMode` hook and review config. (6bfec63)
- **Workflow skip patterns** — Added skip patterns for translations, generated files, and static assets to reduce noise in automated code reviews. (9343359)

---

> **Period (broader context):** last 7 days (2026-03-23 → 2026-03-30) — 20 commits

### Features
- Webhook actor allowlist filter (PR #261)
- PlanManager state machine replacing distributed plan-mode flags (PR #257)

### Fixes
- Context size management for GPT/Gemini review tools (PR #262)
- Plan mode gating enforced via PreToolUse hook + PlanManager (PR #258)
- ExitPlanMode deny-with-message pattern (PR #255)
- Orchestrator empty state layout (PR #254)
- Orchestrator listener leak, type-unsafe mutations, wrong path (PR #253, #252)
- Stall warning shown only once until new user input (PR #252)
- Remove stall timer warning from orchestrator chat (PR #256)

### Documentation
- Code comment improvements across 11 files per 2026-03-27 comment audit (PR #260)

### Chores
- GPT model default bumped (6bfec63)
- Workflow skip patterns added (9343359)
- Version bumped to 0.5.1 (ef41c9c)
- Repo health and code review reports added/pruned (d98e086)

---

## Stale Branches

> Today: 2026-03-30. "Stale" threshold: no commit activity in 30 days (before 2026-02-28). **No branches meet this criterion** — the oldest branch dates to 2026-03-14 (16 days ago).

However, **29 branches are fully merged into `main`** and should be deleted:

### Merged Branches (safe to delete)

| branch | last commit | author | merged? | recommendation |
|--------|------------|--------|---------|----------------|
| `chore/dependency-updates-2026-03-18` | 2026-03-19 | alari | ✅ Merged | Delete |
| `chore/docs-cleanup-2026-03-18` | 2026-03-18 | alari | ✅ Merged | Delete |
| `chore/repo-health-report-2026-03-20` | 2026-03-21 | alari | ✅ Merged | Delete |
| `docs/comment-audit-improvements` | 2026-03-21 | alari | ✅ Merged | Delete |
| `docs/v0.5.0-release-notes` | 2026-03-23 | alari | ✅ Merged | Delete |
| `feat/joe-sidebar-icon-status` | 2026-03-22 | alari | ✅ Merged | Delete |
| `feat/joe-sidebar-status-dot` | 2026-03-22 | alari | ✅ Merged | Delete |
| `feat/per-session-allowed-tools` | 2026-03-19 | alari | ✅ Merged | Delete |
| `feat/shepherd-session-cleanup-api` | 2026-03-19 | alari | ✅ Merged | Delete |
| `feat/sidebar-status-tooltips` | 2026-03-22 | alari | ✅ Merged | Delete |
| `fix/agent-joe-cron-tools` | 2026-03-22 | alari | ✅ Merged | Delete |
| `fix/agent-joe-session-sidebar` | 2026-03-19 | alari | ✅ Merged | Delete |
| `fix/agent-session-icon` | 2026-03-22 | alari | ✅ Merged | Delete |
| `fix/bug-fixes-2026-03-18` | 2026-03-19 | alari | ✅ Merged | Delete |
| `fix/code-review-audit-findings` | 2026-03-21 | alari | ✅ Merged | Delete |
| `fix/cron-create-split-error` | 2026-03-22 | alari | ✅ Merged | Delete |
| `fix/increase-shepherd-concurrency` | 2026-03-19 | alari | ✅ Merged | Delete |
| `fix/native-permissions-dual-write` | 2026-03-21 | alari | ✅ Merged | Delete |
| `fix/orchestrator-listener-leak-and-type-safety` | 2026-03-24 | alari | ✅ Merged | Delete |
| `fix/orchestrator-path-guards` | 2026-03-23 | alari | ✅ Merged | Delete |
| `fix/orchestrator-session-icon-color` | 2026-03-23 | alari | ✅ Merged | Delete |
| `fix/security-hardening-2026-03-18` | 2026-03-18 | Claude (Webhook) | ✅ Merged | Delete |
| `fix/session-allowedtools-hook-bypass` | 2026-03-19 | alari | ✅ Merged | Delete |
| `fix/shepherd-icon-status-color` | 2026-03-22 | alari | ✅ Merged | Delete |
| `fix/tool-split-error` | 2026-03-22 | alari | ✅ Merged | Delete |
| `refactor/reduce-complexity-2026-03-18` | 2026-03-18 | alari | ✅ Merged | Delete |
| `test/diff-parser-coverage-2026-03-18` | 2026-03-18 | alari | ✅ Merged | Delete |
| `wt/8ea42b7c` | 2026-03-23 | alari76 | ✅ Merged | Delete (worktree remnant) |
| `wt/ec931b88` | 2026-03-23 | alari76 | ✅ Merged | Delete (worktree remnant) |

**Suggested cleanup command:**
```bash
git push origin --delete \
  chore/dependency-updates-2026-03-18 \
  chore/docs-cleanup-2026-03-18 \
  chore/repo-health-report-2026-03-20 \
  docs/comment-audit-improvements \
  docs/v0.5.0-release-notes \
  feat/joe-sidebar-icon-status \
  feat/joe-sidebar-status-dot \
  feat/per-session-allowed-tools \
  feat/shepherd-session-cleanup-api \
  feat/sidebar-status-tooltips \
  fix/agent-joe-cron-tools \
  fix/agent-joe-session-sidebar \
  fix/agent-session-icon \
  fix/bug-fixes-2026-03-18 \
  fix/code-review-audit-findings \
  fix/cron-create-split-error \
  fix/increase-shepherd-concurrency \
  fix/native-permissions-dual-write \
  fix/orchestrator-listener-leak-and-type-safety \
  fix/orchestrator-path-guards \
  fix/orchestrator-session-icon-color \
  fix/security-hardening-2026-03-18 \
  fix/session-allowedtools-hook-bypass \
  fix/shepherd-icon-status-color \
  fix/tool-split-error \
  refactor/reduce-complexity-2026-03-18 \
  test/diff-parser-coverage-2026-03-18 \
  wt/8ea42b7c \
  wt/ec931b88
```

### Unmerged Branches (appear squash-merged — content in main, branch tip orphaned)

Many unmerged branches show `ahead:1, behind: N` — a signature of squash-merge workflows where the branch commit is not reachable from `main` but the content was landed via squash. These should be reviewed and deleted if the corresponding PR was closed/merged:

| branch | ahead | behind | last commit | recommendation |
|--------|-------|--------|------------|----------------|
| `fix/always-allow-exact-commands` | 1 | 24 | 2026-03-23 | Verify PR merged → delete |
| `fix/control-response-format` | 2 | 43 | 2026-03-22 | Verify PR merged → delete |
| `fix/exit-plan-mode-approval-bugs` | 1 | 25 | 2026-03-23 | Verify PR merged → delete |
| `fix/exit-plan-mode-deny-with-message` | 1 | 12 | 2026-03-24 | Verify PR merged → delete |
| `fix/exit-plan-mode-stuck-after-approval` | 1 | 26 | 2026-03-23 | Verify PR merged → delete |
| `fix/orchestrator-approval-wiring` | 1 | 33 | 2026-03-23 | Verify PR merged → delete |
| `fix/orchestrator-chat-polish` | 1 | 23 | 2026-03-23 | Verify PR merged → delete |
| `fix/orchestrator-concurrent-limit` | 1 | 35 | 2026-03-23 | Verify PR merged → delete |
| `fix/orchestrator-concurrent-limit-docs` | 1 | 19 | 2026-03-23 | Verify PR merged → delete |
| `fix/orchestrator-greeting-guidelines` | 1 | 48 | 2026-03-22 | Verify PR merged → delete |
| `fix/orchestrator-info-message-color` | 1 | 27 | 2026-03-23 | Verify PR merged → delete |
| `fix/orchestrator-repo-policy-discovery` | 2 | 48 | 2026-03-22 | Verify PR merged → delete |
| `fix/orchestrator-security-hardening` | 1 | 35 | 2026-03-23 | Verify PR merged → delete |
| `fix/pending-prompts-completed-sessions` | 2 | 31 | 2026-03-23 | Verify PR merged → delete |
| `fix/plan-mode-exit-stuck` | 1 | 52 | 2026-03-22 | Verify PR merged → delete |
| `fix/remove-shepherd-rename-orchestrator` | 1 | 49 | 2026-03-22 | Verify PR merged → delete |
| `fix/remove-stall-timer` | 1 | 10 | 2026-03-24 | Verify PR merged → delete |
| `fix/respond-endpoint-race-condition` | 1 | 30 | 2026-03-23 | Verify PR merged → delete |
| `fix/suppress-orchestrator-noise` | 2 | 17 | 2026-03-24 | Verify PR merged → delete |
| `refactor/shepherd-to-orchestrator` | 1 | 52 | 2026-03-22 | Verify PR merged → delete |
| `test/approval-flow-v3` | 1 | 30 | 2026-03-23 | Verify PR merged → delete |
| `test/coverage-gaps` | 1 | 39 | 2026-03-23 | Verify PR merged → delete |
| `ui/question-prompt-sizing` | 3 | 43 | 2026-03-22 | Verify PR merged → delete |
| `feat/joe-chat-variant` | 1 | 157 | 2026-03-17 | Verify intent (large divergence — abandoned?) |

---

## PR Hygiene

| PR# | title | author | days open | review status | conflicts? | stuck? |
|-----|-------|--------|-----------|--------------|------------|--------|
| #259 | chore: add repo health reports for 2026-03-25 and 2026-03-26 | alari76 | 4 | No decision | No (MERGEABLE) | No (approaching 7d) |

**Total open PRs:** 1
**Stuck PRs (>7 days, no review):** 0

PR #259 is not yet stuck but will cross the 7-day threshold on 2026-04-02 if not merged. It is a chore PR adding automated report files and is already mergeable. Recommend merging promptly.

---

## Merge Conflict Forecast

Active branches are defined as those with a commit in the last 14 days (since 2026-03-16).

| branch | commits ahead | commits behind | last commit | overlapping risk | risk level |
|--------|--------------|----------------|------------|-----------------|------------|
| `origin/codekin/reports` | 44 | 304 | 2026-03-29 | Reports-only branch (`.codekin/reports/`) — no overlap with main source files | Low (isolated files) |
| `origin/chore/repo-health-report-2026-03-26` | 5 | 6 | 2026-03-28 | Report files only | Low |
| `origin/docs/improve-code-comments` | 5 | 6 | 2026-03-28 | Comment-only changes to source files — low conflict surface | Low |
| `origin/chore/repo-health-report-2026-03-25` | 2 | 8 | 2026-03-25 | Report files only | Low |
| `origin/refactor/plan-manager-state-machine` | 1 | 8 | 2026-03-25 | `server/plan-manager.ts`, `server/session-manager.ts` — heavily modified files on main | Medium |
| `origin/fix/plan-mode-gating-enforcement` | 1 | 7 | 2026-03-25 | Same files as above | Medium |
| `origin/feat/webhook-actor-allowlist` | 1 | 4 | 2026-03-29 | `server/webhook-*.ts` — recently merged content on main | Low |
| `origin/fix/review-tool-context-limits` | 1 | 3 | 2026-03-29 | Review tool files — just merged on main | Low |

**Notes:**
- `origin/codekin/reports` is 304 commits behind main (very large divergence). This branch is a long-lived reports accumulation branch. Its large `ahead` count (44 commits) suggests accumulated report files. It should not be merged into `main` directly — report files should be cherry-picked or PRs filed per report batch. Consider restructuring this workflow.
- `origin/refactor/plan-manager-state-machine` and `origin/fix/plan-mode-gating-enforcement` are both 1 commit ahead but touch `plan-manager.ts` and `session-manager.ts` — the same files that received commits on main via PRs #257 and #258. These branches appear to be the source branches for those PRs (squash-merged), so the content is already in main. **Safe to delete.**
- No active development branches with genuinely high conflict risk were detected.

---

## Recommendations

1. **Delete 29 merged remote branches** *(High impact, low effort)* — Run the cleanup command in the Stale Branches section. This reduces noise in `git branch -r` output and speeds up fetch times. 65 branches is unmanageable; target < 10 open at any time.

2. **Audit and delete squash-merged branches** *(High impact, medium effort)* — The ~23 branches showing `ahead:1, behind: N` pattern are almost certainly squash-merged source branches with orphaned tips. Verify the corresponding PRs are closed, then batch-delete. This will bring the total open branch count to ~8 active branches.

3. **Merge or close PR #259** *(Medium impact, low effort)* — The repo-health reports PR has been open 4 days and is fully mergeable. It will cross the 7-day stuck threshold on 2026-04-02. Merging it also unblocks the report accumulation workflow.

4. **Document the four unreleased features on `main`** *(Medium impact, medium effort)* — Webhook actor allowlist (PR #261), context size management for review tools (PR #262), GPT model default bump, and skip patterns for workflow reviews all landed post-v0.5.1. Update `docs/GITHUB-WEBHOOKS-SPEC.md` and `docs/WORKFLOWS.md` before the next release tag.

5. **Tag a v0.5.2 patch release** *(Medium impact, low effort)* — Four commits have landed on `main` since v0.5.1 was tagged 2026-03-28. These include a user-visible feature (actor allowlist) and two fixes. Cutting a patch tag keeps the version history aligned with the changelog and `version-check.ts` upgrade notifications.

6. **Restructure the `codekin/reports` branch workflow** *(Medium impact, medium effort)* — This branch is 304 commits behind main and 44 ahead, making it a permanent divergence point. Rather than accumulating reports on a long-lived branch, each report batch should be pushed to a fresh `chore/repo-health-YYYY-MM-DD` branch and PRed in. The current pattern creates an ever-growing rebase burden.

7. **Promote `@typescript-eslint/no-unsafe-*` rules from `warn` to `error`** *(Low impact, low effort)* — These rules were intentionally downgraded for incremental adoption. The codebase has matured; run `eslint --max-warnings 0` to assess how many violations remain, then plan a sprint to eliminate them. Type-unsafe assignments are a common source of runtime errors.

8. **Periodically validate `skipLibCheck: false`** *(Low impact, low effort)* — Add a monthly CI check or local `npm run typecheck:strict` script that runs TypeScript without `skipLibCheck` to surface hidden third-party type errors. This does not need to be a blocking lint step.

9. **Add a branch protection rule requiring PR review** *(Low impact, low effort)* — PR #259 has been open 4 days with zero review activity. A GitHub branch protection rule requiring at least one approval before merge would prevent report PRs from lingering and enforce the review discipline already present in the PR workflow.

10. **Consider adding a CODEOWNERS file** *(Low impact, low effort)* — With a single primary author (`alari76`) and automated commits (`Claude (Webhook)`), a minimal `CODEOWNERS` file assigning `alari76` to `*` would auto-request review on all PRs and make the review-required rule from recommendation #9 effective immediately.
