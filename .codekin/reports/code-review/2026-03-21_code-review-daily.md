# Daily Code Review: codekin

**Date**: 2026-03-21T05:03:40.863Z
**Repository**: /srv/repos/codekin
**Branch**: chore/repo-health-report-2026-03-20
**Workflow Run**: 58a403c5-2116-4e7a-a070-62f162c2162e
**Session**: 8f355d39-f394-4232-a763-f54e9d1b8728

---

Now let me look at the most recently changed files around the allowedTools hook bypass fix and session persistence:Now I have enough data for a thorough review. Let me write the report.Here is the review summary:

---

## Daily Code Review — 2026-03-21

High-activity week (30+ commits). Two security findings, one logic bug, three code quality warnings.

### Critical

**1. Path traversal in `/api/shepherd/reports/read`** (`shepherd-routes.ts:119`, `shepherd-reports.ts:114`)
The `?path=` query param is passed directly to `readFileSync()` with no validation. Any caller holding a shepherd token (including a prompt-injected Agent Joe process) can read arbitrary files — `sessions.json`, `repo-approvals.json`, or anything readable on the host.
Fix: validate that the resolved path is inside a known repo's `.codekin/reports/` directory before reading.

**2. `Bash(prefix:*)` prefix-extension bypass** (`session-manager.ts:1262`)
`cmd.startsWith('curl')` matches `curlscript.sh`, `curlhook`, etc. — not just `curl <args>`. An agent session running under `allowedTools: ['Bash(curl:*)']` could have `curlattack` auto-approved.
Fix: change to `cmd === prefix || cmd.startsWith(prefix + ' ') || cmd.startsWith(prefix + '\t')`.

### Warning

**3. Agent sessions silently hang on unapproved tools** (`session-manager.ts:1238`)
The `headless` auto-approval path covers `webhook/workflow/stepflow` but not `agent`. Shepherd child sessions (source: `agent`) that call a tool not in `allowedTools` will wait 60 seconds then silently deny, with no structured feedback to the orchestrator.

**4. `_nudged` flag added via type cast** (`shepherd-children.ts:271`)
Property is attached to `ChildSession` at runtime using a type cast rather than being declared in the interface. Fragile under object copying/reconstruction.

**5. `outputHistory.splice` during monitoring** (`shepherd-children.ts:298-299`)
`ensureFinalStep` removes the result message from the shared `outputHistory` buffer. A client joining during a nudge cycle will receive incomplete replay history.

### Info

- `restoreFromDisk` casts `permissionMode` without validating against `VALID_PERMISSION_MODES`
- `resolveAutoApproval` called twice per hook request path (harmless, but worth a comment)
- Debug-level task tool inputs logged to stdout
- `DAY_PATTERNS` dead export still present (carry-over from 2026-03-20)
- `/api/shepherd/` namespace missing from `docs/API-REFERENCE.md` (carry-over)

Report saved to `.codekin/reports/code-review/2026-03-21_code-review-daily.md`.