# Documentation Audit: codekin

**Date**: 2026-03-25T02:20:45.068Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 1885f037-e0a6-4632-9745-748e463b61c0
**Session**: 8b4fb8e4-85a5-4264-af32-f9ac1bc8790c

---

Now I have enough data to write the comprehensive report.

```markdown
## Summary

The Codekin documentation corpus contains **14 documentation files** (root + `docs/`) plus **9 workflow prompt files** in `server/workflows/` and 2 untracked generated-report files at the repo root. Of the 14 true doc files, **8 need attention**: 4 have meaningful accuracy issues, 2 are candidates for consolidation, and 2 are spec-format planning documents describing shipped features that should be converted to reference docs or removed.

**Health rating: Needs cleanup.** The core reference docs (API, stream protocol) are in good shape. The biggest problem areas are `docs/SETUP.md` (references removed files, wrong env var names, conflicting Node.js versions), `docs/WORKFLOWS.md` (all output directories wrong, two workflows missing), `docs/FEATURES.md` (wrong REST API paths, stale product name), and `docs/ORCHESTRATOR-SPEC.md` (still labeled "Draft v0.1" despite the feature shipping in v0.5.0).

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|--------------|---------|--------|
| `README.md` | 106 | 2026-03-23 | Consumer-facing install + feature overview | Current |
| `CHANGELOG.md` | 306 | 2026-03-23 | Version history (Keep a Changelog format) | Current |
| `CLAUDE.md` | 48 | 2026-03-08 | Claude Code harness instructions for contributors | Current |
| `CONTRIBUTING.md` | 111 | 2026-03-18 | Contributor guide: dev setup, branching, PR process | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Standard community code of conduct | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting policy | Current |
| `docs/API-REFERENCE.md` | 385 | 2026-03-16 | REST API endpoint reference | Current |
| `docs/FEATURES.md` | 364 | 2026-03-18 | End-user feature reference for all UI capabilities | Stale |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 810 | 2026-03-14 | GitHub webhook integration: Phase 1 shipped, Phases 2–4 roadmap | Stale |
| `docs/INSTALL-DISTRIBUTION.md` | 181 | 2026-03-16 | npm distribution model, install script, release process | Current |
| `docs/ORCHESTRATOR-SPEC.md` | 669 | 2026-03-23 | Agent Joe spec: still labeled Draft v0.1 despite shipping | Stale |
| `docs/SETUP.md` | 437 | 2026-03-16 | Bare-metal/developer server setup (nginx, systemd, manual deploy) | Outdated |
| `docs/stream-json-protocol.md` | 586 | 2026-03-22 | Claude CLI stream-JSON protocol and hook communication reference | Current |
| `docs/WORKFLOWS.md` | 182 | 2026-03-14 | Workflow definition format and built-in workflow reference | Stale |
| `server/workflows/code-review.daily.md` | 22 | 2026-03-08 | Workflow prompt: daily code review | Current |
| `server/workflows/comment-assessment.daily.md` | 41 | 2026-03-08 | Workflow prompt: daily comment assessment | Current |
| `server/workflows/commit-review.md` | 22 | 2026-03-11 | Workflow prompt: per-commit review trigger | Current |
| `server/workflows/complexity.weekly.md` | 54 | 2026-03-08 | Workflow prompt: weekly complexity report | Current |
| `server/workflows/coverage.daily.md` | 41 | 2026-03-08 | Workflow prompt: daily test coverage assessment | Current |
| `server/workflows/dependency-health.daily.md` | 46 | 2026-03-08 | Workflow prompt: daily dependency health check | Current |
| `server/workflows/docs-audit.weekly.md` | 97 | 2026-03-14 | Workflow prompt: weekly documentation audit | Current |
| `server/workflows/repo-health.weekly.md` | 111 | 2026-03-09 | Workflow prompt: weekly repo health assessment | Current |
| `server/workflows/security-audit.weekly.md` | 66 | 2026-03-08 | Workflow prompt: weekly security audit | Current |
| `coverage-reports/2026-03-08_coverage-assessment.md` | 214 | untracked | Generated report artifact (not documentation) | Outdated |
| `review logs/2026-03-08_code-review-daily.md` | 205 | untracked | Generated report artifact (not documentation) | Outdated |

---

## Staleness Findings

### 1. `docs/WORKFLOWS.md` — All output directories are wrong; two workflows missing

Last modified 2026-03-14. The workflow `.md` files in `server/workflows/` all use `.codekin/reports/<topic>/` as their `outputDir`, but `WORKFLOWS.md` documents the old paths:

| Workflow | WORKFLOWS.md says | Actual `outputDir` |
|----------|------------------|--------------------|
| code-review.daily | `review logs/` | `.codekin/reports/code-review` |
| security-audit.weekly | `security-reports/` | `.codekin/reports/security` |
| complexity.weekly | `complexity-reports/` | `.codekin/reports/complexity` |
| coverage.daily | `coverage-reports/` | `.codekin/reports/coverage` |
| comment-assessment.daily | `comment-reports/` | `.codekin/reports/comments` |
| dependency-health.daily | `dependency-reports/` | `.codekin/reports/dependencies` |
| docs-audit.weekly | `.codekin/reports/docs-audit/` | `.codekin/reports/docs-audit` ✓ |

Additionally, `WORKFLOWS.md` claims "seven built-in workflows" and lists exactly seven — but the `server/workflows/` directory contains **nine** files: `repo-health.weekly.md` (added 2026-03-09) and `commit-review.md` (added 2026-03-11) are entirely absent from the documentation.

### 2. `docs/SETUP.md` — References removed files and obsolete env vars

Last modified 2026-03-16. Several specific references are broken:

- **`scripts/scan-repos.mjs`** (lines 139, 156): This file does not exist. The `scripts/` directory is absent from the repository. The referenced `public/data/repos.json` artifact does not exist either.
- **`public/data/`** (line 142): Directory not present in current repo.
- **`.codekin/settings.example.json` deploy settings** (lines 164–178): `settings.example.json` does exist, but its documented fields (`webRoot`, `serverDir`, `dist-deploy`) belong to the local bare-metal deploy workflow (the private deploy script) rather than the public distribution model. The `FRONTEND_WEB_ROOT` env var (line 432) does not appear in `server/config.ts`; the actual variable is `FRONTEND_DIST`.
- **`AUTH_FILE`** (line 432 key file table): The actual env var name is `AUTH_TOKEN_FILE`, not `AUTH_FILE`.
- **`nginx/codekin.example`** (line 195): This file exists but the setup guide does not note that nginx is now optional — the distribution model serves the frontend directly via `FRONTEND_DIST`, removing the nginx dependency entirely.
- **Node.js version inconsistency**: Line 31 says "Node.js v18+" in Prerequisites, then immediately says "(codekin requires v24 for its own process)". `CONTRIBUTING.md` says 20+. The installed version is v24.13.1.

### 3. `docs/FEATURES.md` — Wrong REST API path; stale product name

Last modified 2026-03-18:

- **Docs Browser REST API** (line 308): Documents `GET /api/repos/:repoId/docs` and `GET /api/repos/:repoId/docs/:filePath`, but the actual server routes (in `server/docs-routes.ts`) are `GET /api/docs?repo=...` and `GET /api/docs/file?repo=...&file=...`.
- **"cc-web" references** (lines 273, 342, 353): The product/server was renamed from `cc-web` to `codekin`. Line 273 says "cc-web token," line 342 says "cc-web server (port 32352)," and line 353's architecture table still lists "cc-web server" as the service name.

### 4. `docs/ORCHESTRATOR-SPEC.md` — Shipped feature still labeled Draft

Last modified 2026-03-23. The header on line 6 reads **"Status: Draft v0.1"** despite the Agent Joe orchestrator shipping in v0.5.0 (2026-03-23). The Phase 1 implementation checklist in §11 (lines 489–493) uses unchecked `[ ]` boxes for all items, yet all Phase 1 work is live. This creates confusion about whether the feature is implemented or planned.

### 5. `docs/GITHUB-WEBHOOKS-SPEC.md` — Planning doc masquerading as reference

Last modified 2026-03-14. The document is 810 lines and was written as a planning spec. It correctly notes "Phase 1 implemented and in production" at the top, but the body is overwhelmingly structured as future-work planning (Phases 2–4), open questions, and provisional API designs. The ratio of shipped content to roadmap content makes it hard to use as a reference for what is actually deployed.

---

## Accuracy Issues

### `docs/SETUP.md` — Mixed-model confusion and incorrect env vars

The document conflates two deployment models that now have separate homes:
- **Consumer npm install** → `README.md` + `INSTALL-DISTRIBUTION.md`
- **Bare-metal/developer** → `SETUP.md`

The confusion creates specific inaccuracies:
1. **`FRONTEND_WEB_ROOT`** is not a recognized env var in `server/config.ts`. The correct variable is `FRONTEND_DIST`.
2. **`AUTH_FILE`** does not exist. The correct variable is `AUTH_TOKEN_FILE`.
3. The setup steps instruct users to run `node scripts/scan-repos.mjs` — a script that does not exist in the repository.
4. Step 6 instructs copying `settings.example.json` with a `webRoot` field pointing to `dist-deploy`, but the current `server/config.ts` has no awareness of `webRoot` — that belongs to the local deploy script stored outside the repo.

### `docs/FEATURES.md` — Incorrect REST API path

The Docs Browser section documents the wrong endpoint shape. `GET /api/repos/:repoId/docs` (path parameter) does not exist — the actual routes use query parameters: `GET /api/docs?repo=<path>` and `GET /api/docs/file?repo=<path>&file=<path>`.

### `docs/WORKFLOWS.md` — Wrong output directories (all seven listed)

Every output directory in the built-in workflow table is inconsistent with the actual `outputDir` frontmatter in the workflow definition files. All actual paths are under `.codekin/reports/<topic>/` but the docs show legacy path names (`review logs/`, `security-reports/`, etc.). Code consuming these docs to configure report readers or CI integrations would use the wrong paths.

### `CONTRIBUTING.md` line 9 — Node.js version

States "Node.js 20+" as a prerequisite. `SETUP.md` says "Node.js v18+" and also says "codekin requires v24." The system actually runs v24.13.1. The minimum for contributors should be stated consistently across docs.

---

## Overlap & Redundancy

### Group 1: Installation guides (3 files)

| File | Coverage | More Complete On |
|------|----------|-----------------|
| `README.md` | Consumer install (one-liner, CLI commands, config vars) | End-user overview |
| `docs/INSTALL-DISTRIBUTION.md` | npm package model, install script internals, release process | Distribution and release detail |
| `docs/SETUP.md` | Bare-metal dev setup (clone, build, nginx, systemd) | Manual/advanced setup steps |

`README.md` and `INSTALL-DISTRIBUTION.md` now cover the same audience for the same model. `SETUP.md` targets a different (advanced) audience but overlaps substantially on environment variables, configuration, and directory layout with both others.

**Recommendation**: `README.md` → consumer entry point (keep as-is). `INSTALL-DISTRIBUTION.md` → authoritative distribution/release reference (keep, update). `SETUP.md` → either delete (INSTALL-DISTRIBUTION.md already has a "Bare-Metal / Advanced Setup" section at line 163) or trim to only the nginx/Authelia specifics that aren't covered elsewhere.

### Group 2: Environment variable reference (3 files)

`README.md` (Configuration table), `CONTRIBUTING.md` (env var table), and `docs/INSTALL-DISTRIBUTION.md` (Configuration Reference section) all document server environment variables. The three tables are not equivalent — `CONTRIBUTING.md` lists 7 variables, `README.md` lists 2, and `INSTALL-DISTRIBUTION.md` lists 8 — creating a triplication of truth with no single canonical source.

### Group 3: Architecture diagrams (3 files)

`docs/SETUP.md` (§Architecture), `docs/FEATURES.md` (§Architecture Overview), and `docs/INSTALL-DISTRIBUTION.md` all contain architecture ASCII diagrams. The diagrams differ slightly in scope but overlap heavily on the nginx → codekin → Claude CLI topology.

---

## Fragmentation

### `docs/SETUP.md` — Split across two audiences with no clear division

`SETUP.md` starts as a bare-metal developer guide (nginx, systemd, manual build) then pivots to "Development" and "Updating" sections that duplicate `CONTRIBUTING.md`. The two target audiences (ops/advanced deploy vs. contributor) would be better served by separate, focused documents rather than one 437-line omnibus guide.

### `docs/WORKFLOWS.md` — Underdocuments a 9-file system

As noted above, two of nine workflow files (`repo-health.weekly` and `commit-review`) have no documentation. The workflow prompt bodies are also not referenced anywhere in the doc — users authoring new workflows must read the actual `.md` files to understand what a good prompt looks like. A "Built-in Workflow Prompts" section or an example walkthrough would close this gap.

### `docs/ORCHESTRATOR-SPEC.md` and `docs/GITHUB-WEBHOOKS-SPEC.md` — Shipped features documented as planning specs

Both files were written pre-implementation as design specs and were never converted to reference documentation after the features shipped. They contain:
- Design rationale (valuable once, less valuable as ongoing reference)
- Unresolved open questions (now answered by the implementation)
- Unchecked Phase 1 checklists (now completed)
- Large roadmap sections (Phases 2–4) interleaved with implemented features

This structure makes it hard to distinguish what is live from what is planned. For shipped features, the reference form should be the canonical source; design rationale belongs in git history or ADR documents.

---

## Action Items

### Delete

| File | Reason |
|------|--------|
| `coverage-reports/2026-03-08_coverage-assessment.md` | Untracked generated report artifact; not documentation. Generated reports belong under `.codekin/reports/`, not the repo root. Safe to delete — the content is stale, not tracked in git, and will be regenerated. |
| `review logs/2026-03-08_code-review-daily.md` | Same as above — untracked generated report at the wrong location. The directory name with a space also conflicts with the new `.codekin/reports/code-review/` convention. Safe to delete. |

### Consolidate

| Source Files | Target File | What to Keep / Drop |
|---|---|---|
| `docs/SETUP.md` + the "Bare-Metal / Advanced Setup" section of `docs/INSTALL-DISTRIBUTION.md` | `docs/INSTALL-DISTRIBUTION.md` (expand) | Keep: bare-metal clone/build steps, nginx/Authelia config, systemd unit. Keep in INSTALL-DISTRIBUTION.md's existing "Bare-Metal" section, expand with the nginx detail from SETUP.md. Drop: SETUP.md's env var tables (duplicate), repo scanner steps (script removed), settings.example.json instructions (bare-metal only internal). Delete SETUP.md after merging. |
| README.md config table + CONTRIBUTING.md env var table + INSTALL-DISTRIBUTION.md config reference | `docs/INSTALL-DISTRIBUTION.md` (single canonical env var table) | Keep one comprehensive table in INSTALL-DISTRIBUTION.md. README.md keeps a minimal 2–3 row summary with a link. CONTRIBUTING.md references INSTALL-DISTRIBUTION.md instead of duplicating the table. |

### Update

| File | Sections Needing Update | What Changed in Code |
|------|------------------------|---------------------|
| `docs/WORKFLOWS.md` | "Built-in Workflows" table (outputDir column); opening paragraph count ("seven"); add repo-health.weekly and commit-review entries | All workflow `outputDir` values changed from `review logs/`, `security-reports/`, etc. to `.codekin/reports/<topic>/`. Two new workflows added: `repo-health.weekly` (2026-03-09) and `commit-review` (2026-03-11). |
| `docs/FEATURES.md` | §Docs Browser REST API paths (line 308); §Architecture Overview service names (lines 342, 353); §Settings token description (line 273) | REST API routes changed from `/api/repos/:id/docs` to `/api/docs?repo=...`. "cc-web" product name retired; server is now "codekin server." |
| `docs/ORCHESTRATOR-SPEC.md` | Header status line; §11 Phase 1 checklist; §2 "Status: Draft v0.1" | Agent Joe shipped in v0.5.0. All Phase 1 items are implemented. Status should be updated; Phase 1 boxes should be checked. |
| `docs/SETUP.md` (if not deleted) | §Prerequisites Node.js version; §5 repo scanner steps; §6 settings.example fields; §Key File Paths env var names | `scripts/scan-repos.mjs` removed. `FRONTEND_WEB_ROOT` → `FRONTEND_DIST`. `AUTH_FILE` → `AUTH_TOKEN_FILE`. Node.js minimum is 20+ (for contributors). |
| `CONTRIBUTING.md` | §Prerequisites Node.js version (line 9) | Should say "Node.js 20+" consistently with README.md and the actual runtime (v24). |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | §Status header; §Implementation Phases Phase 1 checklist; §Open Questions | Phase 1 is shipped. Open Questions section should either be answered or removed. The document should be restructured to lead with the deployed feature reference, with Phases 2–4 clearly marked as roadmap in a dedicated appendix. |

---

## Recommendations

1. **Fix `docs/WORKFLOWS.md` output directories immediately.** All seven listed paths are wrong. Any user, script, or integration reading this doc to locate report files will fail. This is a one-table fix with high impact. Also add `repo-health.weekly` and `commit-review` entries and update the count from "seven" to "nine."

2. **Fix `docs/FEATURES.md` REST API path for Docs Browser.** The documented path shape (`/api/repos/:repoId/docs`) does not exist on the server. Replace with `GET /api/docs?repo=<path>` and `GET /api/docs/file?repo=<path>&file=<path>`. Also do a search-replace on "cc-web" → "codekin" (3 occurrences).

3. **Delete or significantly trim `docs/SETUP.md`.** `docs/INSTALL-DISTRIBUTION.md` already contains a "Bare-Metal / Advanced Setup" section. SETUP.md's unique value (nginx/Authelia config, webhook nginx block) should be merged into INSTALL-DISTRIBUTION.md, and SETUP.md deleted. This removes a 437-line file with multiple broken references and a confusing audience mismatch.

4. **Update `docs/ORCHESTRATOR-SPEC.md` status.** Change the header from "Draft v0.1" to reflect that Agent Joe shipped in v0.5.0, and check the Phase 1 items in §11. The document is valuable as a design reference, but the "draft" label actively misleads readers about feature availability.

5. **Normalize the Node.js version requirement.** `CONTRIBUTING.md` says 20+, `SETUP.md` says 18+ (then 24). Pick one minimum (20+, or 24+ to match the actual runtime) and state it consistently in README.md, CONTRIBUTING.md, and SETUP.md/INSTALL-DISTRIBUTION.md.

6. **Remove stale generated report artifacts from the repo root.** Delete `coverage-reports/2026-03-08_coverage-assessment.md` and `review logs/2026-03-08_code-review-daily.md`. These are untracked generated files in the wrong location (reports should live under `.codekin/reports/`). Their presence at the root creates the impression they are current documentation.

7. **Consolidate the environment variable reference.** Three files document server env vars with three different sets. Designate `docs/INSTALL-DISTRIBUTION.md` §Configuration Reference as the single source of truth. README.md keeps a short summary table; CONTRIBUTING.md cross-references it. This prevents the tables from drifting further.

8. **Restructure `docs/GITHUB-WEBHOOKS-SPEC.md` from spec to reference.** The shipped Phase 1 content should lead the document as an operational reference (endpoint, config env vars, troubleshooting). Phases 2–4 can remain in a clearly separated "Roadmap" appendix. The "Open Questions" section should be audited and removed or answered — most questions were resolved during implementation.

9. **Add `repo-health.weekly` and `commit-review` to `docs/FEATURES.md` §Automated Workflows.** The feature list in FEATURES.md (lines 169–180) enumerates seven built-in workflow types, omitting the two newer ones. Users discover capabilities through FEATURES.md first; the gap means `repo-health` and `commit-review` are invisible.

10. **Establish a docs update checklist in `CONTRIBUTING.md`.** The recurring pattern in this audit — workflow output dirs out of sync, REST paths wrong, stale product name — suggests there is no prompt to update docs when code changes. Adding a one-sentence reminder to the PR Guidelines (e.g., "If your change adds a workflow, API endpoint, env var, or renames a component, update the corresponding doc in `docs/`") would prevent future drift with minimal overhead.
```Committed and pushed. 23 files updated: 2 new reports added (code-review and dependency-health for 2026-03-24), the 2026-03-24 repo-health report updated, and 20 stale reports from March 8–14 removed.