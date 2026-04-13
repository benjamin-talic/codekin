# Provider Health & Webhook Backlog

Observational health tracking and a persistent retry backlog for webhook-driven PR reviews. When a review session fails because the configured provider (Claude or OpenCode) hit a usage limit or an auth failure, Codekin classifies the error, updates a health snapshot, enqueues the PR for retry, and posts a user-visible comment on the PR explaining what happened.

This feature solves a specific failure mode: GitHub has already received a 202 for the webhook when the review session starts, so any failure during review silently drops the event. Before this feature, rate-limit and auth failures would leave a PR unreviewed with no explanation.

## Overview

Three new modules plus an integration layer in `webhook-handler.ts`:

| Module | Purpose |
|--------|---------|
| `server/webhook-error-classifier.ts` | Pure function classifying an error string as `rate_limit` / `auth_failure` / `other` |
| `server/webhook-provider-health.ts` | Persistent per-provider health snapshot |
| `server/webhook-backlog.ts` | Persistent retry queue with `getReady(now)` semantics |
| `server/webhook-handler.ts` | Wires the three together via `onSessionError` / `onSessionExit` / `onSessionResult` listeners and runs the retry worker |

The design is observational, not defensive. Provider health NEVER short-circuits routing — every new webhook still tries the configured provider. Health flips back to healthy automatically on the next successful review. This means recoveries happen naturally without time-based TTLs.

## Error Classification

`classifyProviderError(text)` returns one of:

- **`rate_limit`** — a 429, quota exhausted, usage limit, or overloaded response. Examples:
  - `API Error: 429 Too Many Requests`
  - `You've hit your daily token limit`
  - `overloaded_error: Anthropic is experiencing high load`
  - `Your balance is too low`

- **`auth_failure`** — a 401/403, invalid API key, expired OAuth token, forbidden response. Examples:
  - `401 Unauthorized`
  - `invalid_api_key: authentication failed`
  - `The token is invalid or expired`
  - `oauth token expired`

- **`other`** — anything that doesn't match. Network errors, JSON parse failures, disk full, process crashes. These get marked as `error` events but do NOT flip provider health and are NOT backlogged — a retry probably won't help.

Rate limit takes precedence when a string matches both categories (e.g. "401 rate limited" → `rate_limit`). Patterns live in `server/webhook-error-classifier.ts` as `RATE_LIMIT_PATTERNS` and `AUTH_FAILURE_PATTERNS` and are tuned conservatively — when in doubt, classify as `rate_limit` so events get backlogged rather than dropped.

### Tuning the Classifier

When a real-world error surfaces as `other` but should have been classified, add a regex to the appropriate pattern array in `webhook-error-classifier.ts` and add a test case in `webhook-error-classifier.test.ts`. Start conservative — it's better to backlog an event that shouldn't retry than to drop one that should.

## State Files

Both files live under `~/.codekin/` with mode `0o600`. They use the same atomic write pattern as `webhook-dedup.json` (tmp file + rename).

### `~/.codekin/provider-health.json`

```json
{
  "claude": {
    "status": "healthy",
    "lastSuccessAt": "2026-04-12T09:00:00.000Z"
  },
  "opencode": {
    "status": "unhealthy",
    "reason": "rate_limit",
    "detectedAt": "2026-04-12T09:30:00.000Z",
    "lastError": "API Error: 429 rate limit exceeded",
    "lastSuccessAt": "2026-04-12T08:45:00.000Z"
  }
}
```

- `status` — `'healthy'` or `'unhealthy'`
- `reason` — present only when unhealthy; one of `'rate_limit'` / `'auth_failure'`
- `detectedAt` — ISO timestamp of when the provider was marked unhealthy
- `lastError` — truncated to 500 characters
- `lastSuccessAt` — preserved across unhealthy/healthy transitions so operators can see how long ago the last successful review was

Managed by `ProviderHealthManager` in `server/webhook-provider-health.ts`.

### `~/.codekin/webhook-backlog.json`

```json
[
  {
    "id": "3a2e4f6b-...",
    "repo": "owner/repo",
    "prNumber": 42,
    "headSha": "deadbeef...",
    "payload": { "...": "full PullRequestPayload needed to re-fire the webhook" },
    "reason": "rate_limit",
    "failedProvider": "claude",
    "queuedAt": "2026-04-12T09:30:00.000Z",
    "retryAfter": "2026-04-12T10:30:00.000Z",
    "retryCount": 0
  }
]
```

- `failedProvider` — `'claude'` / `'opencode'` / `'both'` (both = split-mode fallback also failed)
- `retryAfter` — ISO timestamp, set to `queuedAt + 1 hour`
- `retryCount` — incremented on each retry attempt (observational only — there is no max retry count)

Managed by `BacklogManager` in `server/webhook-backlog.ts`.

## Flow Diagram

```
webhook arrives
     │
     ▼
handlePullRequestEvent → processPullRequestAsync → sessions.create(...)
     │                                                    │
     │                                                    ▼
     │                                             ┌──────────────┐
     │                                             │   session    │
     │                                             │   running    │
     │                                             └──────┬───────┘
     │                                                    │
     │                                         ┌──────────┴──────────┐
     │                                         ▼                     ▼
     │                                    exit code 0           exit code ≠ 0
     │                                         │                     │
     │                                         ▼                     ▼
     │                                  markHealthy         classify(errorText)
     │                                                               │
     │                                                ┌──────────────┼──────────────┐
     │                                                ▼              ▼              ▼
     │                                          'other'        'rate_limit' / 'auth_failure'
     │                                                │              │
     │                                                ▼              ▼
     │                                          event='error'   markUnhealthy
     │                                                               │
     │                                              split mode, not yet fallback?
     │                                                               │
     │                                                     ┌─────────┴─────────┐
     │                                                     ▼                   ▼
     │                                                    yes                 no
     │                                                     │                   │
     │                                                     ▼                   ▼
     │                                            supersede + fire       backlog.enqueue
     │                                            fallback session       post PR comment
     │                                            with OTHER provider    event='error'
     │                                                                         │
     │                                                                         ▼
     │                                                              retryAfter = now + 1h
     │
     │   retry worker (60s tick)
     │        │
     │        ▼
     │   backlog.getReady(now) → for each entry:
     │        │                    fetchPrState(repo, pr)
     │        │                    ├── closed → backlog.remove (PR gone, give up)
     │        │                    └── open   → processPullRequestAsync (re-fire)
     │        │                                 (on failure: new backlog entry)
     ▼
```

## Split-Mode Fallback

When `prReviewProvider = 'split'` and the selected provider fails with `rate_limit` or `auth_failure`, the handler automatically spins up a new session with the **other** provider. Rules:

- Only applies to `split` mode. Fixed `claude` / `opencode` modes NEVER fall back — if a specific provider is configured, the user wants only that provider.
- Only triggers on `rate_limit` / `auth_failure`. Generic `other` errors do not fall back.
- Only happens once per event. If the fallback session also fails, the event is backlogged with `failedProvider: 'both'`.
- The original webhook event is marked `superseded` with a descriptive reason; the fallback runs as a fresh event + session so the lifecycle events don't get tangled.

## Retry Worker

A `setInterval` in `WebhookHandler` (60 second tick, `unref`'d so it doesn't block shutdown) scans the backlog for ready entries. For each:

1. Call `fetchPrState(repo, prNumber)` via `gh api`.
2. If the PR is `closed` → remove the entry (PR is gone, no point retrying).
3. If `gh` fails → leave the entry in place, try again next tick.
4. If `open` → remove the entry, build a fresh `WebhookEvent`, and call `processPullRequestAsync` to re-run the full review flow. On failure, `handleReviewFailure` creates a brand-new backlog entry.

No max retry count. Retries continue indefinitely at 1-hour intervals until the PR closes or the review succeeds. Rate limits reset eventually and operators can fix auth issues at any time — we shouldn't give up while the PR is still open.

## `GET /api/webhooks/health`

Auth-gated (identical token check to `/api/webhooks/events`). Returns:

```json
{
  "claude": {
    "status": "healthy",
    "lastSuccessAt": "2026-04-12T09:00:00.000Z"
  },
  "opencode": {
    "status": "unhealthy",
    "reason": "rate_limit",
    "detectedAt": "2026-04-12T09:30:00.000Z",
    "lastError": "API Error: 429 ..."
  },
  "backlog": 3
}
```

Example:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/webhooks/health
```

Use this endpoint for external monitoring (alert if `unhealthy` for more than N minutes, or `backlog > 0`).

## PR Comment Content

When an event gets backlogged, `postProviderUnavailableComment` creates or updates the `<!-- codekin-review -->` marker comment on the PR. Two templates:

**Rate limit:**

```markdown
<!-- codekin-review -->
## ⏳ Codekin review deferred — usage limit reached

**Provider:** Claude (sonnet)
**Reason:** Rate limit / usage limit hit
**Next retry:** `2026-04-12T10:30:00Z`

Codekin will automatically retry this review once the provider recovers.
The PR needs to remain open for the retry to happen.

*Error detail (for operator):* `API Error: 429 ...`
```

**Auth failure:**

```markdown
<!-- codekin-review -->
## 🔑 Codekin review deferred — provider auth failed

**Provider:** OpenCode (openai/gpt-5.4)
**Reason:** Authentication failure (invalid / expired credentials)
**Next retry:** `2026-04-12T10:30:00Z`

Codekin will keep retrying hourly until this PR closes. Check provider
credentials on the codekin server if this persists.

*Error detail (for operator):* `401 Unauthorized`
```

If a prior codekin review comment exists on the PR (marker match), it's updated via PATCH so the PR doesn't accumulate stale summary comments. Otherwise a new comment is created. Failures to post are logged as warnings but never throw — the backlog + health state are the source of truth for retries; the comment is just user-facing signal.

## Testing

- `server/webhook-error-classifier.test.ts` — 41 tests covering rate_limit / auth_failure / other patterns and precedence
- `server/webhook-provider-health.test.ts` — 13 tests for persistence round-trip, mark healthy/unhealthy, lastSuccessAt preservation
- `server/webhook-backlog.test.ts` — 18 tests for enqueue / getReady / remove / bumpRetry / persistence / corrupt file recovery
- `server/webhook-pr-github.test.ts` — 5 new tests for `fetchPrState` and 9 new tests for `postProviderUnavailableComment`
- `server/webhook-handler.test.ts` — 6 integration tests covering: rate_limit backlog, auth_failure backlog, `other` no-backlog, split-mode fallback, split double-failure, success-heals

## Design Decisions

These were settled during planning and are worth recording:

1. **Always try the configured provider, regardless of stored health.** Health is diagnostic, not routing. This lets recoveries happen naturally — the next webhook that lands tries claude again, and if claude has recovered the health flips to healthy on the successful result.

2. **Fixed mode never falls back.** `claude` mode will never try opencode as a plan-B and vice versa. If a user picks a specific provider, that's what they want.

3. **Healing requires a successful review.** No time-based TTL that auto-flips state. The state flips only when a review actually completes cleanly with that provider.

4. **Retry forever until the PR closes.** No max retry count, no exponential backoff. 1 hour between retries. Rate limits reset eventually; we shouldn't give up while the PR is still open.

5. **Storage is JSON files**, matching existing patterns (`webhook-dedup.json`, `webhook-pending-debounce.json`). Simple, inspectable, easy to back up, easy to clear manually.

## Known Limitations

- **Classifier patterns are a best guess.** The first deployment is conservative — when real-world errors surface unclassified, patterns need tuning. Monitor `getEvents()` for events marked `'error'` with `category=other` in the log line and add patterns as needed.
- **OpenCode may not emit a distinct error event for stalled sessions.** If OpenCode silently stalls without emitting an error message, the classifier never runs. Follow-up: add a stall-detection timeout to `OpenCodeProcess` that synthesizes an error string.
- **Concurrent retry worker + new webhook.** The retry worker re-fires events through `processPullRequestAsync`, which hits the same concurrency cap as normal webhook processing. Under heavy load, retries can be rejected as "at concurrency cap" — they'll try again next tick.
