# OpenCode Integration

How Codekin spawns and communicates with OpenCode sessions via its HTTP REST + SSE protocol. OpenCode implements the same `CodingProcess` interface as `ClaudeProcess`, so `SessionManager` is provider-agnostic — both providers emit identical `ClaudeProcessEvents`.

For the Claude CLI protocol, see [stream-json-protocol.md](./stream-json-protocol.md).

## Architecture

Unlike Claude CLI (one subprocess per session), OpenCode uses a **shared server** model:

```
SessionManager
     │
     ├── ClaudeProcess (session A) ──► claude CLI (subprocess, NDJSON stdin/stdout)
     ├── ClaudeProcess (session B) ──► claude CLI (subprocess, NDJSON stdin/stdout)
     │
     └── OpenCodeProcess (session C) ─┐
         OpenCodeProcess (session D) ─┤──► opencode serve (shared HTTP server, SSE events)
         OpenCodeProcess (session E) ─┘
```

One `opencode serve` process handles all OpenCode sessions. Each `OpenCodeProcess` instance routes requests to its own session via the `x-opencode-directory` header and filters the shared SSE stream by `sessionID`.

### Key files

| File | Purpose |
|------|---------|
| `server/opencode-process.ts` | `OpenCodeProcess` class — session lifecycle, SSE parsing, event mapping |
| `server/coding-process.ts` | `CodingProcess` interface + `CodingProvider` type + capability declarations |
| `server/session-lifecycle.ts` | Provider dispatch (`startClaude()` creates either `ClaudeProcess` or `OpenCodeProcess`) |
| `server/session-manager.ts` | Provider-agnostic session CRUD, listener registration |

## Server Lifecycle

### Starting the server

`ensureOpenCodeServer(workingDir)` is called lazily on the first OpenCode session start. It:

1. Picks an ephemeral port (14096–15095)
2. Generates a random UUID password (`OPENCODE_SERVER_PASSWORD` env var)
3. Spawns `opencode serve --port <port>`
4. Polls `GET /health` every second for up to 30 seconds
5. Returns the base URL (`http://localhost:<port>`) once healthy

The server is a **singleton** — subsequent calls return immediately if the process is alive. If the server dies, the next `ensureOpenCodeServer()` call restarts it.

### Authentication

All API calls use HTTP Basic Auth:

```
Authorization: Basic base64("opencode:<password>")
```

The password is generated at server start and never leaves the process. It's stored in the module-level `serverState` object.

### Stopping the server

`stopOpenCodeServer()` sends SIGTERM. Called during Codekin shutdown.

## Session Creation

### Manual sessions (UI)

When a user creates a session with `provider: 'opencode'`, `SessionLifecycle.startClaude()` dispatches to:

```typescript
new OpenCodeProcess(session.workingDir, {
  sessionId: codekinSessionId,           // internal tracking
  opencodeSessionId: previousSessionId,  // for resume (if session ran before)
  model: 'anthropic/claude-sonnet-4',    // provider/model format
  extraEnv: { CODEKIN_SESSION_ID, CODEKIN_PORT, CODEKIN_AUTH_TOKEN, ... },
  permissionMode: session.permissionMode,
})
```

### Webhook review sessions

`webhook-handler.ts` sets additional options for sandboxed reviews:

```typescript
const sessionOptions: CreateSessionOptions = {
  source: 'webhook',
  id: sessionId,
  groupDir: `${REPOS_ROOT}/${repoName}`,
  provider: 'opencode',
  model: config.prReviewOpencodeModel,   // e.g. 'openai/gpt-5.4'
  permissionMode: 'bypassPermissions',   // auto-approve "ask" prompts
}
```

An `opencode.json` config file is written to the workspace root before session creation — see [Permissions](#permissions) below.

### `CreateSessionOptions` reference

| Option | Type | Effect on OpenCode |
|--------|------|-------------------|
| `provider` | `'opencode'` | Dispatches to `OpenCodeProcess` instead of `ClaudeProcess` |
| `model` | `string` | Format: `providerID/modelID` (e.g. `anthropic/claude-sonnet-4`, `openai/gpt-5.4`) |
| `permissionMode` | `PermissionMode` | Mapped to auto-approve behavior for `permission.asked` SSE events |
| `id` | `string` | Codekin session ID (used for internal tracking, not passed to OpenCode) |
| `groupDir` | `string` | Original repo path (used for `CLAUDE_PROJECT_DIR` env var) |
| `source` | `string` | Labels the origin (`manual`, `webhook`, `workflow`, etc.) |
| `allowedTools` | `string[]` | **Ignored by OpenCode** — use `opencode.json` instead |
| `addDirs` | `string[]` | **Ignored by OpenCode** — use `opencode.json` `external_directory` instead |
| `skipDefaultBashGit` | `boolean` | **Ignored by OpenCode** — no default `Bash(git:*)` prepended |

## SSE Protocol

### Connecting

`OpenCodeProcess` subscribes to the shared SSE stream immediately after creating the session:

```
GET /event
Accept: text/event-stream
Authorization: Basic <credentials>
x-opencode-directory: <workingDir>
```

The stream is shared across all sessions. Each event carries a `properties.sessionID` field — `OpenCodeProcess` filters events using `isOwnSession()` to prevent cross-session leakage.

### Reconnection

If the SSE connection drops (server restart, proxy timeout, network error):

- Exponential backoff: 1s, 2s, 4s, ... up to 30s
- Max 20 reconnect attempts before emitting an error
- Backoff resets on successful reconnection

### Event types

| SSE Event | Mapped CodingProcess Event | Notes |
|-----------|---------------------------|-------|
| `message.part.delta` | `text` | Streaming text content (`field === 'text'`) |
| `message.part.updated` (text) | — | Text arrives via delta, not here |
| `message.part.updated` (reasoning) | `thinking` | First sentence or 80-char prefix as summary |
| `message.part.updated` (tool, running) | `tool_active` | Tool name + summarized input |
| `message.part.updated` (tool, completed) | `tool_done` + `tool_output` | Output truncated to 2000 chars |
| `message.part.updated` (tool, error) | `tool_done` + `tool_output(isError)` | Error message from tool |
| `session.status` (idle) | `result` | Turn completed, ready for input |
| `session.updated` (idle) | `result` | Alternate idle signal (version-dependent) |
| `message.completed` | `result` | Model finished response |
| `session.error` | `error` | Session-level error |
| `permission.asked` | `control_request` | Permission prompt (or auto-approved if `bypassPermissions`) |
| `heartbeat` | — | Ignored (connection keepalive) |
| `server.connected` | — | Ignored |
| `message.part.added` | — | Ignored (redundant with delta/updated) |

### Turn completion detection

OpenCode signals turn completion through multiple event types depending on version:

1. `session.status` with `status === 'idle'` (or `status.type === 'idle'`)
2. `message.completed`
3. `session.updated` with `session.status === 'idle'`

A `turnComplete` latch prevents duplicate `result` emissions. It resets on `sendMessage()`.

### Session ID filtering

The shared SSE stream carries events from ALL sessions. `isOwnSession()` guards every event handler:

- If `opencodeSessionId` is not yet set (during init), **all events are rejected** to prevent cross-session leakage
- If the event has no `sessionID` property, it's accepted (server-level event)
- Otherwise, must match `this.opencodeSessionId`

## Sending Messages

Messages are sent via HTTP POST (not stdin):

```
POST /session/<opencodeSessionId>/prompt_async
Content-Type: application/json
Authorization: Basic <credentials>
x-opencode-directory: <workingDir>

{
  "parts": [{ "type": "text", "text": "Review this code..." }],
  "model": {                    // optional, only if model is set
    "providerID": "anthropic",
    "modelID": "claude-sonnet-4"
  }
}
```

The `prompt_async` endpoint is fire-and-forget — the response only confirms the message was accepted. All output arrives via SSE events.

### Model format

OpenCode uses `providerID/modelID` format. Examples:
- `anthropic/claude-sonnet-4`
- `openai/gpt-5.4`
- `openrouter/meta-llama/llama-3.1-8b` (nested slash preserved — split at first `/` only)

The model can be overridden per-message via the `model` field in the prompt request.

## Permissions

OpenCode handles permissions fundamentally differently from Claude CLI:

| Aspect | Claude CLI | OpenCode |
|--------|-----------|----------|
| Tool scoping | `--allowedTools` flag at spawn | `opencode.json` in workspace root |
| Directory access | `--add-dir` flag at spawn | `permission.external_directory` in config |
| Bash restrictions | `Bash(pattern:*)` tool patterns | `permission.bash` glob patterns |
| Permission prompts | `control_request` on stdout → `control_response` on stdin | `permission.asked` SSE event → `POST /permission/<id>/reply` |
| Auto-approval | `--permission-mode bypassPermissions` flag | `bypassPermissions` mode + server-side deny enforcement |
| Deny enforcement | CLI-side (rejects tools not in `--allowedTools`) | Server-side (deny rules enforced BEFORE `permission.asked` fires) |

### `opencode.json`

Written to the workspace root before session creation. Evaluated in order — **last match wins**, so the catch-all `"*": "deny"` must come first.

```json
{
  "$schema": "https://opencode.ai/config.json",
  "permission": {
    "bash": {
      "*": "deny",
      "git status": "allow",
      "git status *": "allow",
      "git diff": "allow",
      "git diff *": "allow",
      "gh pr view *": "allow",
      "gh api repos/*/pulls/*/comments": "allow"
    },
    "read": "allow",
    "edit": "allow",
    "write": "allow",
    "grep": "allow",
    "webfetch": "deny",
    "external_directory": {
      "*": "deny",
      "/home/user/.codekin/pr-cache/**": "allow"
    },
    "doom_loop": "deny"
  }
}
```

### Permission values

| Value | Meaning |
|-------|---------|
| `"allow"` | Always permitted, no prompt |
| `"deny"` | Always blocked, server-side enforcement (cannot be overridden by `bypassPermissions`) |
| `"ask"` | Prompts the user (or auto-approved if `bypassPermissions` is set) |

### `bypassPermissions` interaction

When `permissionMode: 'bypassPermissions'`:

1. OpenCode server evaluates `opencode.json` rules first
2. `"deny"` rules are enforced server-side — `bypassPermissions` **cannot override them**
3. `"ask"` rules emit `permission.asked` SSE events, which `OpenCodeProcess` auto-approves via `POST /permission/<id>/reply` with `type: "always"`
4. `"allow"` rules pass through silently

This means deny rules in `opencode.json` are the hard security boundary. `bypassPermissions` only auto-approves the `"ask"` prompts that would otherwise block headless sessions.

### Permission reply endpoint

```
POST /permission/<requestId>/reply
Content-Type: application/json
Authorization: Basic <credentials>
x-opencode-directory: <workingDir>

{ "type": "once" | "always" | "reject" }
```

Codekin maps its `allow` / `deny` to OpenCode's vocabulary:
- `allow` → `"once"` (approve this instance)
- `deny` → `"reject"` (deny this instance)
- Auto-approve (bypassPermissions) → `"always"` (approve permanently for this session)

## Process Lifecycle

### Start

1. `start()` sets a 60-second startup timeout
2. `initialize()` calls `ensureOpenCodeServer()` to start/verify the shared server
3. Creates a session via `POST /session` (or reuses `opencodeSessionId` for resume)
4. Subscribes to SSE event stream
5. Emits `system_init` with the model name (portion after first `/`)

### Stop

1. Sets `alive = false`
2. Clears startup timeout
3. Aborts SSE connection via `AbortController`
4. Emits `exit(0, null)` to match `ClaudeProcess` exit behavior

Note: `stop()` does NOT kill the shared OpenCode server — only the SSE subscription. The server stays alive for other sessions.

### Resume

When a session has a stored `claudeSessionId` (which is actually the OpenCode session ID):

- `ClaudeProcess`: uses `--resume` flag to continue the JSONL conversation
- `OpenCodeProcess`: passes `opencodeSessionId` to skip the `POST /session` creation call and reconnects to the existing session's SSE stream

### Error handling

| Failure | Behavior |
|---------|----------|
| Server won't start | Throws after 30s health-check timeout |
| Session creation fails | Emits `error` event, calls `stop()` |
| SSE connection drops | Exponential backoff reconnection (max 20 attempts) |
| SSE max retries exceeded | Emits `error` event |
| Message send fails | Emits `error` event with HTTP status |
| 60s startup timeout | Emits `error` event, calls `stop()` |

## Task Tracking

Both providers support task tools (`TodoWrite`, `TaskCreate`, `TaskUpdate`). OpenCode tool names may vary in casing (`todowrite`, `TodoWrite`, `todo_write`), so `handleTaskTool()` normalizes via `toLowerCase().replace(/_/g, '')`.

Task state is tracked per-process in a `Map<string, TaskItem>`. On any change, a `todo_update` event is emitted with the full task array, which `SessionLifecycle` broadcasts as a WebSocket message.

## Tool Summary Generation

`summarizeToolInput()` mirrors `ClaudeProcess` behavior for UI display:

| Tool | Summary |
|------|---------|
| `bash` | `$ <first line of command>` |
| `read` / `view` | File path |
| `write` / `edit` / `multiedit` | File path |
| `glob` | Pattern |
| `grep` | Pattern |
| `task` | Description |

Note: OpenCode uses lowercase tool names (`bash`, `read`, `write`) while Claude CLI uses PascalCase (`Bash`, `Read`, `Write`).

## Model Discovery

`fetchOpenCodeModels(workingDir)` queries the running server for available models:

```
GET /config/providers
Authorization: Basic <credentials>
x-opencode-directory: <workingDir>
```

Returns all configured providers and their models. Used by the UI to populate the model selector dropdown when provider is set to `opencode`.

## Provider Capabilities

Declared in `coding-process.ts`:

```typescript
const OPENCODE_CAPABILITIES = {
  streaming: true,        // real-time text via SSE
  multiTurn: true,        // conversational sessions
  permissionControl: true, // permission.asked + reply
  toolEvents: true,       // tool_active / tool_done / tool_output
  thinkingDisplay: true,  // reasoning blocks → thinking summaries
  multiProvider: true,    // supports multiple AI providers (unique to OpenCode)
  planMode: true,         // plan mode state machine
}
```

The `multiProvider: true` capability is unique to OpenCode — it can route to different AI providers (Anthropic, OpenAI, OpenRouter, etc.) within a single server instance. Claude CLI always uses Anthropic's API.

## Differences from Claude CLI

| Aspect | Claude CLI (`ClaudeProcess`) | OpenCode (`OpenCodeProcess`) |
|--------|------------------------------|------------------------------|
| Process model | One subprocess per session | Shared HTTP server, all sessions |
| Communication | stdin/stdout NDJSON pipes | HTTP REST + SSE |
| Session creation | CLI flag (`--session-id` or `--resume`) | `POST /session` |
| Message sending | Write JSON to stdin | `POST /session/<id>/prompt_async` |
| Event receiving | Parse NDJSON from stdout | Parse SSE from `GET /event` |
| Permission handling | `control_request`/`control_response` on stdin/stdout | `permission.asked` SSE + `POST /permission/<id>/reply` |
| Tool scoping | `--allowedTools` flag | `opencode.json` in workspace |
| Directory scoping | `--add-dir` flag | `external_directory` in `opencode.json` |
| Model format | Model name directly (e.g. `claude-sonnet-4-6`) | `providerID/modelID` (e.g. `anthropic/claude-sonnet-4`) |
| Tool name casing | PascalCase (`Bash`, `Read`, `Write`) | lowercase (`bash`, `read`, `write`) |
| Multi-provider | No (Anthropic only) | Yes (Anthropic, OpenAI, OpenRouter, etc.) |
| Server management | N/A (subprocess dies with session) | Singleton server persists across sessions |
| Env var stripping | Strips `ANTHROPIC_API_KEY`, `GIT_*` | No stripping (server manages its own env) |
| Auto-restart | Built-in (max 3 retries, 5-min cooldown) | Handled by `SessionLifecycle` (same logic, different stop/start) |
| Startup timeout | 60s (no JSON output → kill) | 60s (`system_init` not emitted → stop) |

## Known Limitations

- **No `--allowedTools` equivalent at the CLI level.** Tool restrictions rely entirely on `opencode.json`. If no config is written, all tools are available.
- **Shared SSE stream can be noisy.** With many concurrent sessions, `isOwnSession()` filtering discards most events. This is a bandwidth concern at scale but hasn't been an issue in practice.
- **No stall detection.** Claude CLI has a 5-minute activity timer. OpenCode sessions can stall silently if the model stops producing events without emitting `session.status: idle`. Follow-up: add a stall timeout to `OpenCodeProcess`.
- **`stop()` emits `exit(0, null)` unconditionally.** There's no way to distinguish a clean stop from a forced stop. The exit code is always 0 because there's no subprocess to observe — the shared server stays running.
- **Resume is reconnect-only.** Claude's `--resume` replays the conversation from the JSONL file. OpenCode resume just reconnects to the SSE stream for an existing session — the conversation context lives server-side.
