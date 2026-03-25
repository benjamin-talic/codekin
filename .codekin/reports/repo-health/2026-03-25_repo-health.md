# Repo Health Report — 2026-03-25

## Summary

**Branch reviewed:** `chore/repo-health-report-2026-03-25`
**Test suite:** 1105 tests / 41 files — all passing (1.05s)
**Version:** 0.5.0 (bumped 2026-03-23)
**Activity:** High — 38 commits in 7 days, dominated by orchestrator feature work

---

## Critical

_None identified._

---

## Warning

### W1 — `model` parameter not validated in orchestrator child-spawn endpoint
**File:** `server/orchestrator-routes.ts:147`

The `POST /api/orchestrator/children` route accepts an optional `model` field from the request body and passes it directly to `ChildSessionRequest` without checking it against `VALID_MODELS`. This is inconsistent with the WebSocket path (`ws-message-handler.ts:156`) which rejects unrecognised model IDs before creating a session. A malformed model string propagates to `ClaudeProcess.start()` as a `--model` CLI argument, causing a silent or hard-to-diagnose failure in the child session.

**Risk:** Low in practice (auth-gated endpoint), but the discrepancy means the orchestrator itself could pass a garbage model string that causes a child session to fail silently.

**Recommendation:** Add the same guard used in `ws-message-handler.ts`:
```ts
if (model && !VALID_MODELS.has(model)) {
  return res.status(400).json({ error: `Invalid model: ${model}` })
}
```

---

### W2 — `since` date not validated in reports query endpoint
**File:** `server/orchestrator-routes.ts:103-116`

The `GET /api/orchestrator/reports?since=<date>` endpoint passes the raw `since` query string directly to `getReportsSince()`, which uses it in a lexicographic string comparison (`r.date >= sinceDate`). There is no format validation. An invalid value (empty string, arbitrary text, out-of-range date) silently returns wrong results — all reports or no reports — with no error to the caller.

**Recommendation:**
```ts
if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
  return res.status(400).json({ error: 'Invalid since: expected YYYY-MM-DD' })
}
```

---

### W3 — Completion detection in `ensureFinalStep` relies on fragile prose matching
**File:** `server/orchestrator-children.ts:346-369`

Whether a child session completed its final step is determined by substring search over raw assistant output text:

- **PR check:** `lowerText.includes('pull request') || lowerText.includes('created a pr') || lowerText.includes('gh pr create')`
- **Push check:** `lowerText.includes('git push') || lowerText.includes('pushed')`

**False positives:** Claude frequently mentions these terms while describing what it *plans* to do ("I'll create a pull request next"). This can suppress the nudge for a session that hasn't actually pushed yet.

**False negatives:** Claude may describe success in unmatched terms ("opened a PR", "submitted the PR", "published the branch") and receive an unnecessary nudge.

The single-nudge-per-child guard prevents infinite loops, but false positives allow premature `completed` status.

**Recommendation:** Match on structured output signals — e.g. the GitHub URL pattern `https://github\.com/.+/pull/\d+` from `gh pr create` output — rather than prose. Alternatively, surface this as a known limitation in comments so future reviewers don't mistake it for robust detection.

---

## Info

### I1 — `onSessionPrompt` lacks an unsubscribe return value
**File:** `server/session-manager.ts:381`

`onSessionResult` and `onSessionExit` both return `() => void` unsubscribe closures (fixed in #253). `onSessionPrompt` still returns `void`:

```ts
// These return unsubscribers:
onSessionResult(...): () => void
onSessionExit(...):   () => void
// This does not:
onSessionPrompt(...): void          // inconsistent
```

There is no active leak today because `onSessionPrompt` is only called once at startup (`ws-server.ts:489`). However, any future per-spawn usage (e.g. an orchestrator monitor registering per-child prompt listeners) would accumulate listeners permanently — the exact bug fixed for the other two types.

**Recommendation:** Make the return type consistent with `onSessionResult`/`onSessionExit`.

---

### I2 — `readReport` uses unresolved path for metadata extraction
**File:** `server/orchestrator-reports.ts:127-133`

The security-validated `resolved` path is correctly used for `existsSync` and `statSync` (the latter was fixed in #253). However, the metadata extraction below the security block still operates on the original unresolved `filePath`:

```ts
const resolved = resolve(filePath)
// ...security checks on resolved...
const parts = filePath.split('/')          // should be resolved.split('/')
const codekinIdx = filePath.indexOf(...)   // should be resolved.indexOf(...)
```

If `filePath` contains unnormalized segments that still satisfy the security bounds check, `category` and `repoPath` fields in the returned metadata will be parsed incorrectly.

**Recommendation:** Use `resolved` for both the stat call (done) and the metadata parsing below it.

---

### I3 — Escaped backticks in CLAUDE.md template produce rendering artifacts
**File:** `server/orchestrator-manager.ts:180-200`

The curl examples in the "pending-prompts" and "approvals" sections of `CLAUDE_MD_TEMPLATE` use triple-backslash escaping (`\\\`\\\`\\\``) which, when written to disk, renders as literal `\`\`\`` rather than proper fenced code blocks. This makes those sections unreadable in the orchestrator's CLAUDE.md workspace file.

**Recommendation:** Use a tagged template or a helper to emit literal backtick triples cleanly, or restructure those sections to avoid the escaping problem.

---

### I4 — Seven-day activity is high-velocity with good discipline

38 commits landed this week. Notable:

- Orchestrator child spawning with worktree isolation (feat, #235)
- Session lifecycle hooks with prompt/result/exit event bus (feat, #235)
- ExitPlanMode hook workaround: deny-with-message pattern (#244, #245, #255)
- AskUserQuestion handled via PreToolUse hook (#228–#231)
- Listener leak fixed (result/exit listeners now return unsubscribers, #253)
- Stall warning de-duplicated (#252, #256)

No regressions. All 1105 tests pass. PR discipline (feature branches → squash merge) is maintained throughout.

---

### I5 — Prior report findings still open

The previous report (2026-03-24) noted `docs/API-REFERENCE.md` as stale (missing lifecycle hook and approval endpoints from #235). This remains open — the doc has not been updated.

---

_Generated by automated repo health review on 2026-03-25._
