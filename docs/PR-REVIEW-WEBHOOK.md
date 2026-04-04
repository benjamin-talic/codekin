# PR Review Webhook

Automated pull request code review via GitHub webhooks. When a PR is opened, updated, or reopened, Codekin spawns a Claude session that reviews the changes and posts findings directly to GitHub.

## Overview

GitHub sends `pull_request` webhook events to Codekin. The handler filters by action, deduplicates, manages concurrency, creates an isolated workspace, and spawns a Claude session with the PR context and a review prompt.

## Architecture

### Event Flow

1. GitHub sends `pull_request` event (actions: `opened`, `synchronize`, `reopened`)
2. `webhook-handler.ts` validates signature, filters by action/draft/allowlist
3. Dedup check (`webhook-dedup.ts`) — rejects already-processed events
4. Supersede any active session for the same PR (new push kills old review)
5. Concurrency cap check (configurable, default 3, set to 10 via `~/.codekin/webhook-config.json`)
6. Record in dedup only after passing all gates (not before — so rejected events can be retried)
7. Create isolated workspace via `webhook-workspace.ts` (bare mirror + worktree)
8. Fetch PR context in parallel: diff, changed files, commits, existing review comments, existing reviews, prior review cache, existing Codekin summary comment
9. Resolve review prompt: repo-level `.codekin/pr-review-prompt.md` > global `~/.codekin/pr-review-prompt.md` > built-in default
10. Spawn Claude session with model `sonnet` and restricted `allowedTools` (includes `Write` for cache persistence)
11. Send assembled prompt (PR metadata + diff + existing reviews + prior cache context + comment update/create instructions + cache-writing instructions)

### Key Files

| File | Purpose |
|------|---------|
| `server/webhook-handler.ts` | Core dispatcher — `handlePullRequestEvent()` and `processPullRequestAsync()` |
| `server/webhook-pr-github.ts` | GitHub data fetching — diff, files, commits, review comments, reviews, existing Codekin comment |
| `server/webhook-pr-prompt.ts` | 3-tier prompt resolution and assembly, cache/comment instructions |
| `server/webhook-pr-cache.ts` | Per-PR context cache — `loadPrCache()`, `getCachePath()`, `PrCacheData` interface |
| `server/webhook-workspace.ts` | Bare mirror cloning + worktree creation with git auth |
| `server/webhook-dedup.ts` | Idempotency — split into `isDuplicate()` (check) and `recordProcessed()` (record) |
| `server/webhook-types.ts` | `PullRequestPayload`, `PullRequestContext`, `WebhookEventStatus` types |
| `server/webhook-config.ts` | Config loading from file + env vars |

### Session Lifecycle

- **Model**: Sonnet (configured in handler, not Opus — cost/speed tradeoff for reviews)
- **allowedTools**: `Bash(gh:*)`, `Write`, context7 MCP tools, `WebFetch`, `WebSearch` (plus pre-approved file ops from `acceptEdits` mode)
- **No auto-restore**: Webhook sessions are one-shot. They are NOT restored on server restart (unlike user sessions). This prevents finished reviews from consuming concurrency slots.
- **Superseding**: When a new push arrives for the same PR, any active review session is marked `superseded` and deleted before the new one starts. Race condition guards check superseded status before workspace creation and session creation.

### Git Authentication

Workspace creation uses `gh repo clone` (handles auth internally), but subsequent `git fetch` commands need explicit credential configuration. Solved with per-process environment variables:

```typescript
const GIT_AUTH_ENV = {
  ...process.env,
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '!/usr/bin/gh auth git-credential',
}
```

Applied to bare mirror fetch and workspace fetch commands. Does NOT use `gh auth setup-git` (breaks other operations) or SSH (changes Codekin's design).

## Configuration

### Environment Variables

Set in `~/.config/codekin/env` (loaded by systemd service, or source manually):

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_WEBHOOK_ENABLED` | Yes | Set to `true` to enable |
| `GITHUB_WEBHOOK_SECRET` | Yes | Shared secret for signature verification |

### Config File

`~/.codekin/webhook-config.json`:

```json
{
  "maxConcurrentSessions": 10
}
```

### Review Prompt

3-tier resolution:
1. **Repo-level**: `.codekin/pr-review-prompt.md` in the PR's repository
2. **Global**: `~/.codekin/pr-review-prompt.md`
3. **Built-in default**: Hardcoded fallback

The global prompt (`~/.codekin/pr-review-prompt.md`) is configured with:
- Expert council pattern (2-4 reviewers selected by tech stack)
- Mandatory Codex cross-review step before posting
- Practical impact filter — findings must pass "would this actually cause a problem?"
- Signal over noise — no manufactured issues, no academic observations, no premature optimizations
- Security and scalability as first-class concerns alongside correctness
- Existing review comment awareness — no duplicate findings
- Never approve, only COMMENT or REQUEST_CHANGES

## PR Context Cache

Subsequent reviews of the same PR reuse prior context instead of starting from scratch.

### How It Works

Cache location: `~/.codekin/pr-cache/{owner}/{repo}/pr-{number}.json`

```json
{
  "prNumber": 42,
  "repo": "owner/repo",
  "lastReviewedSha": "abc1234",
  "timestamp": "2026-04-03T12:00:00.000Z",
  "priorReviewSummary": "PR adds SSO authentication...",
  "codebaseContext": "Auth module at src/auth/, uses JWT tokens...",
  "reviewFindings": "Found null check issue in auth.ts line 42..."
}
```

**What gets re-fetched every time:** diff, files, commits, GitHub comments/reviews (cheap, change between pushes).

**What gets cached:** Claude's prior review summary, codebase familiarity notes, and specific findings.

### Cache Lifecycle

1. On first review: no cache exists, prompt has no "Prior Review Context" section.
2. At end of review: Claude writes the cache JSON via the `Write` tool (instructed in the prompt).
3. On subsequent reviews (`synchronize`/`reopened`): cache is loaded and included as a "Prior Review Context" section in the prompt, with a note that the current diff and comments are fresh.
4. Claude uses prior context for faster, more informed review while still reviewing the full current diff.

### Resilience

- Missing cache: silently skipped (first review, or Claude failed to write it).
- Malformed/incomplete JSON: logged as warning, treated as no cache.
- Stale cache after force-push: `lastReviewedSha` won't match, but cache is supplementary — the fresh diff is authoritative.
- Concurrent reviews: last writer wins (acceptable since it's the most recent review).

## Update Existing Summary Comment

Instead of posting a new summary comment for every review, Codekin finds and updates its existing comment. Inline code comments are still posted fresh.

### Marker

Every Codekin review summary comment starts with a hidden HTML marker:

```html
<!-- codekin-review -->
```

GitHub preserves HTML comments in issue comment bodies, so the marker is invisible to readers but detectable via API.

### How It Works

1. Before the review session starts, `fetchExistingReviewComment()` searches the PR's issue comments (via `gh api /repos/{repo}/issues/{prNumber}/comments --paginate`) for the marker.
2. If found: the comment ID is passed to Claude with PATCH instructions to update it.
3. If not found: Claude receives POST instructions to create a new comment.
4. Both paths include the marker requirement so future reviews can find the comment.

### Shell Escaping

To avoid shell escaping issues with review body content, Claude is instructed to write the comment body to a temporary file and use `gh api --input /tmp/review-body.md` rather than passing the body inline via `-f body='...'`.

## Dedup Fix

The original `isDuplicate()` was check-and-record in one call. This meant events rejected by the concurrency cap were still recorded as "seen," making redelivery impossible. Now split into:

- `isDuplicate(deliveryId, idempotencyKey)` — check only, no side effects
- `recordProcessed(deliveryId, idempotencyKey)` — called after the event passes all gates

## Testing

- `server/webhook-handler.test.ts` — 54+ tests including PR events, superseding, cache/comment integration
- `server/webhook-pr-github.test.ts` — Tests for all fetch functions (diff, files, commits, review comments, reviews, existing review comment detection)
- `server/webhook-pr-prompt.test.ts` — 24+ tests including prompt resolution, prior context rendering, cache-writing instructions, comment update/create instructions
- `server/webhook-pr-cache.test.ts` — 7 tests for cache loading, path generation, validation, and error handling
- `server/webhook-dedup.test.ts` — 26 tests for dedup check/record split, TTL eviction, max entries, disk persistence

Run: `npm test`

## Operational Notes

### Starting the Server

```bash
cd ~/repos/codekin
npm run build
set -a; source ~/.config/codekin/env; set +a
stdbuf -oL -eL node server/dist/ws-server.js > /tmp/codekin.log 2>&1 &
```

### Clearing Dedup

Stop the server first (it flushes on shutdown), then:

```bash
echo '{"byDeliveryId":{},"byIdempotencyKey":{}}' > ~/.codekin/webhook-dedup.json
```

### Monitoring

```bash
tail -f /tmp/codekin.log | grep webhook
```

## Known Limitations

- **Codekin permission delegation**: The Claude CLI rejects tools not in `--allowedTools` before any hook fires. Codekin can't show approval prompts for these tools. Workaround: add needed tools to `allowedTools` at spawn time.
- **MCP tools in webhook sessions**: context7 tools must be in `allowedTools` to work. Added explicitly.
- **Codex cross-review**: Requires `codex` CLI installed. Uses input redirection (`< file`) not pipes (Codekin's bash doesn't support pipes).
