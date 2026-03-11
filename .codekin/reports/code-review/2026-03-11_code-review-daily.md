# Daily Code Review: codekin

**Date**: 2026-03-11T05:06:13.898Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 6e3a5970-6d79-4334-abbe-439883359009
**Session**: 604d42d4-c7d8-4c35-8bab-4cb534b48029

---

Now I have enough data to write the full review. Let me also verify one key finding:Now I have all the information I need. Here's the full review:

---

## Daily Code Review — 2026-03-11

**Branch:** `main` | **Version:** 0.3.6 | **Period:** last 7 days

### Recent Changes Summary

7 PRs merged this week, mostly quality-of-life and reliability fixes:
- `#92` — version bump to 0.3.6
- `#91/#90` — Remove GitHub org prompt from setup; auto-detect orgs via `gh api user/orgs`
- `#89` — GitHub org config wizard addition (immediately superseded by #90/#91)
- `#87` — Inject `PATH`/`HOME` into launchd plist for macOS service
- `#85` — Better UX when `gh` CLI is missing
- `#84/#83` — `uninstall` command + GitHub auth check in installer

---

## Findings

### WARNING

**1. XML injection in launchd plist — `bin/codekin.mjs:225`**

Env var values from the `.env` file are interpolated directly into the plist XML without escaping:

```javascript
.map(([k, v]) => `\t\t<key>${k}</key>\n\t\t<string>${v}</string>`)
```

A value containing `<`, `>`, `&`, or `"` (e.g. `API_KEY=foo&bar`) will produce malformed XML, preventing the launchd service from loading. While this is a developer-controlled file (not user input), values like `PATH` can contain `&`-delimited segments on some systems.

**Fix:** Escape XML special characters in values before interpolation:
```javascript
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
.map(([k, v]) => `\t\t<key>${esc(k)}</key>\n\t\t<string>${esc(v)}</string>`)
```

---

**2. Incomplete URL sanitization — `src/components/ChatView.tsx:138`**

The link sanitizer only blocks `javascript:` URIs:

```typescript
const safeHref = href && /^javascript:/i.test(href) ? '#' : href
```

`data:text/html,<script>alert(1)</script>` and `vbscript:` are not blocked. While React's JSX serialization provides some defense, an explicit allowlist is more robust:

```typescript
const safeHref = href && /^(https?:|mailto:|\/|#)/.test(href) ? href : '#'
```

---

**3. No test coverage for `server/upload-routes.ts`**

This file handles file uploads, path construction, and `gh repo clone` execution — all security-sensitive. It has **zero tests**. The recent `#90` change (org auto-detection) added newline-split parsing of `gh api` output with no validation:

```typescript
orgs = orgsJson.trim().split('\n').filter(Boolean)
```

Missing test scenarios: path traversal via `owner`/`name`, oversized uploads, MIME type bypass, org detection failure modes.

---

**4. MIME type validation only — `server/upload-routes.ts:155–166`**

File uploads validate MIME type (client-supplied) and extension sanitization but not magic bytes. A file named `shell.php` is renamed to `shell_php` correctly, but content type is trusted from the client. If the uploads directory is ever served with permissive headers, this matters.

**Fix:** Add magic byte validation using a library like `file-type` or check the first 8 bytes against known signatures for allowed types.

---

**5. `JSON.parse` without error handling — `server/session-archive.ts` (around line 163)**

The session archive deserializes `output_history` from SQLite without a try-catch:

```typescript
outputHistory: JSON.parse(row.output_history),
```

A corrupted row (power loss during write, manual edit) will throw and crash the entire archive retrieval call. Wrap with a try-catch and return an empty array as fallback.

---

**6. Rate limiting gap on WebSocket messages — `server/ws-server.ts:353–375`**

The WebSocket connection-level rate limiter fires before the `auth` message but has no per-message limit after authentication. An authenticated client can flood `handleWsMessage()` indefinitely. There's no per-session throttle on `input` messages either.

---

### INFO

**7. Token timing side-channel — `server/ws-server.ts:75`**

```typescript
if (a.length !== b.length) return false  // exits before constant-time compare
```

Returning early on length mismatch leaks token length information through timing differences. Low-severity since this requires many probes to exploit and the token space is large, but a hardened implementation would hash both sides to a fixed length first.

---

**8. `data:` image src from tool output — `src/components/ChatView.tsx:271`**

```typescript
const src = `data:${msg.mediaType};base64,${msg.base64}`
return <img src={src} ... />
```

`msg.mediaType` comes from the server-parsed tool output. If a malicious tool output set `mediaType` to `text/html`, the browser would render it as an HTML document in the data URL. Tool outputs are from Claude CLI (trusted), so the practical risk is low — but clamping to allowed media types (`image/png`, `image/jpeg`, etc.) is a cheap defense.

---

**9. Test coverage gaps across server modules**

The following server files have **no test coverage** at all:

| File | Size | Risk Level |
|---|---|---|
| `server/upload-routes.ts` | 9 KB | High (file I/O + shell exec) |
| `server/auth-routes.ts` | 1.8 KB | Medium (auth boundary) |
| `server/approval-manager.ts` | 10 KB | Medium (command approval logic) |
| `server/session-routes.ts` | 11 KB | Medium (REST API) |
| `server/workflow-routes.ts` | 9.5 KB | Medium |
| `server/webhook-routes.ts` | 2.4 KB | Low-Medium |
| `server/ws-server.ts` | ~400 lines | Medium |
| `server/session-persistence.ts` | 3.6 KB | Low |

The most coverage-critical is `upload-routes.ts` given its input surface.

---

**10. No message virtualization — `src/components/ChatView.tsx:395–456`**

All messages up to `MAX_BROWSER_MESSAGES` are rendered in a single pass on every state change with no memoization or windowing. On long sessions this will cause noticeable jank. Consider `react-virtual` or memoizing individual message rows.

---

**11. Webhook branch validation — `server/webhook-workspace.ts:99–107`**

Confirmed correct: `cloneUrl` is validated at line 100 and `branch` at line 105, both before they're used in git commands (lines 110 and 118 respectively). No issue here.

---

**12. Org name parsing from `gh api` — `server/upload-routes.ts:209`**

`orgs = orgsJson.trim().split('\n').filter(Boolean)` — the `--jq` filter returns one login per line. This is safe in practice since `gh` normalizes output, but if a future API change returns JSON-escaped newlines the split would produce garbage. Explicit JSON parsing (`JSON.parse(`[${orgsJson.split('\n').map(JSON.stringify).join(',')}]`)`) would be more robust.

---

## Priority Actions

| Priority | Action | File |
|---|---|---|
| High | Add tests for upload/clone/MIME validation | `upload-routes.ts` |
| High | Fix XML injection in plist builder | `codekin.mjs:225` |
| Medium | Expand link href allowlist | `ChatView.tsx:138` |
| Medium | Add try-catch on `JSON.parse` in archive | `session-archive.ts` |
| Medium | Clamp `mediaType` for data: image URIs | `ChatView.tsx:271` |
| Low | Add post-auth WebSocket message rate limiting | `ws-server.ts` |
| Low | Add message virtualization for long sessions | `ChatView.tsx` |