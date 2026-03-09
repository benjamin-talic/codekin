# Dependency Health Report: codekin

**Date**: 2026-03-09T03:01:35.550Z
**Repository**: /home/dev/repos/codekin
**Branch**: feat/workflow-list-larger-fonts
**Workflow Run**: 34583913-3983-44aa-89fe-a10fb08d7bd0
**Session**: 122cf455-3273-4fc0-87f2-e0447ffda304

---

Now I have all the data I need. Let me compile the report.

# Dependency Health Report — Codekin

**Date:** 2026-03-09
**Repository:** Multiplier-Labs/codekin
**Branch:** feat/workflow-list-larger-fonts

---

## Summary

| Package Manager | Location | Total Deps | Outdated | Vulnerabilities | Risk Level |
|-----------------|----------|-----------|----------|-----------------|------------|
| npm | `/` (frontend) | 536 (229 prod / 227 dev) | 11 | 0 | **Low** |
| npm | `/server` | 244 (137 prod / 107 dev) | 3 | 0 | **Low** |

---

## Security Vulnerabilities

**No known vulnerabilities detected.** Both `npm audit` runs (root and server) returned zero findings across all severity levels.

| Package | Severity | CVE | Description | Fixed In |
|---------|----------|-----|-------------|----------|
| *(none)* | — | — | — | — |

---

## Outdated Dependencies

### Root (`/`)

| Package | Current | Wanted | Latest | Type |
|---------|---------|--------|--------|------|
| `@eslint/js` | 9.39.3 | 9.39.4 | **10.0.1** | dev |
| `eslint` | 9.39.3 | 9.39.4 | **10.0.3** | dev |
| `globals` | 16.5.0 | 16.5.0 | **17.4.0** | dev |
| `eslint-plugin-react-refresh` | 0.4.26 | 0.4.26 | **0.5.2** | dev |
| `@types/node` | 24.10.13 | 24.12.0 | **25.3.5** | dev |
| `@tabler/icons-react` | 3.37.1 | 3.40.0 | 3.40.0 | prod |
| `tailwindcss` | 4.2.0 | 4.2.1 | 4.2.1 | prod |
| `@tailwindcss/vite` | 4.2.0 | 4.2.1 | 4.2.1 | prod |
| `react-syntax-highlighter` | 16.1.0 | 16.1.1 | 16.1.1 | prod |
| `typescript-eslint` | 8.56.0 | 8.56.1 | 8.56.1 | dev |

### Server (`/server`)

| Package | Current | Wanted | Latest | Type |
|---------|---------|--------|--------|------|
| `express` | 4.22.1 | 4.22.1 | **5.2.1** | prod |
| `multer` | 1.4.5-lts.2 | 1.4.5-lts.2 | **2.1.1** | prod |

---

## Abandoned / Unmaintained Packages

No packages with 2+ years of inactivity were detected. All direct dependencies have recent releases:

| Package | Last Release | Status |
|---------|-------------|--------|
| `react-syntax-highlighter` | 2026-02-26 | Active (recently patched) |
| `cmdk` | 2025-08-27 | Low activity (~7 months) |
| `remark-gfm` | 2025-02-10 | Low activity (~13 months, but stable/mature) |
| `tsx` | 2025-11-30 | Low activity (~4 months, dev-only) |

---

## Recommendations

1. **Update in-range patches immediately.** Run `npm update` in both root and server directories to pick up `tailwindcss@4.2.1`, `@tailwindcss/vite@4.2.1`, `@tabler/icons-react@3.40.0`, `react-syntax-highlighter@16.1.1`, `typescript-eslint@8.56.1`, and `@eslint/js@9.39.4`. These are all semver-compatible and low-risk.

2. **Plan Express 5 migration (server).** Express 4.x is in maintenance mode; Express 5.2.1 is the current major. Review the [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5.html) for breaking changes (removed `app.del()`, `req.param()`, updated path matching). This is the highest-impact upgrade in the project.

3. **Upgrade Multer to 2.x (server).** The current `1.4.5-lts.2` is a long-term-support patch of a legacy version. Multer 2.x is a full rewrite with improved streaming and security. Should be coordinated with the Express 5 migration.

4. **Evaluate ESLint 10 upgrade.** ESLint 10.x is available (`10.0.3`). Since the project already uses flat config (`eslint.config.*`), the migration should be straightforward but verify plugin compatibility (`eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`, `typescript-eslint`).

5. **Upgrade `globals` to 17.x** when upgrading ESLint, as they are typically updated together.

6. **Keep `@types/node` aligned with your Node.js runtime.** Currently on `24.x` with `25.x` available — only upgrade if you're running Node 25+.

7. **Monitor `cmdk` and `remark-gfm`.** Both have lower release cadence. Neither is abandoned, but if issues arise, consider alternatives (`remark-gfm` is from the unified ecosystem and very stable; `cmdk` is a popular command palette with no direct replacement).

8. **Run `npm audit` in CI.** Both workspaces currently show zero vulnerabilities — add `npm audit --audit-level=high` to your CI pipeline to catch regressions early.

9. **Consider consolidating duplicate dependencies.** Both root and server declare `@ai-sdk/groq`, `ai`, and `better-sqlite3`. If the frontend doesn't directly use these at runtime (they may be server-only), removing them from the root `package.json` would reduce the install footprint and avoid version drift.

10. **Pin `typescript` more tightly.** The root uses `~5.9.3` (good) but the server uses `^5.6.0` which could drift significantly. Consider aligning both to `~5.9.3` for consistent compiler behavior.