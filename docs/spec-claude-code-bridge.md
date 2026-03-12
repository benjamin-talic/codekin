# Claude Code Bridge — High-Level Spec

## Overview

The Claude Code Bridge enables developers to connect their local Claude Code CLI sessions to a remote Codekin instance. This turns Codekin from a single-machine tool into a team collaboration platform where multiple developers share visibility into each other's AI-assisted coding sessions.

The bridge is a lightweight agent that runs on the developer's machine alongside Claude Code. It relays the existing stream-JSON protocol over a secure WebSocket connection to the Codekin server in the cloud.

```
┌──────────────────────────────────────────┐
│  Developer's Machine                     │
│                                          │
│  ┌────────────┐                          │
│  │ Claude CLI │◄──stdio──┐               │
│  │ (session 1)│          │               │
│  └────────────┘          │               │
│                     ┌────┴───────────┐   │
│  ┌────────────┐     │ Bridge Agent   │   │
│  │ Claude CLI │◄────┤ (codekin-bridge│   │   single WebSocket
│  │ (session 2)│     │  npm package)  ├───┼──── wss://codekin.example.com
│  └────────────┘     │                │   │
│                     │ multiplexes    │   │
│  ┌────────────┐     │ sessions over  │   │
│  │ Claude CLI │◄────┤ one connection │   │
│  │ (session N)│     └────────────────┘   │
│  └────────────┘                          │
│                                          │
└──────────────────────────────────────────┘

         ┌──────────────────────────────────┐
         │  Codekin Server (cloud)          │
         │                                  │
         │  BridgeManager                   │
         │  ┌──────────────────────────┐    │
         │  │ Bridge (Alice)           │    │
         │  │  ├─ Session 1 (bridged)  │    │     ┌──────────┐
         │  │  ├─ Session 2 (bridged)  │◄───┼────►│ Browser  │
         │  │  └─ Session N (bridged)  │    │     │ (team)   │
         │  └──────────────────────────┘    │     └──────────┘
         │                                  │
         │  SessionManager                  │
         │  ┌──────────────────────────┐    │     ┌──────────┐
         │  │ Session (local)          │◄───┼────►│ Browser  │
         │  │  source: 'manual'        │    │     └──────────┘
         │  │  claudeProcess: ...      │    │
         │  └──────────────────────────┘    │
         │                                  │
         └──────────────────────────────────┘
```

---

## Motivation

Currently, Codekin spawns Claude Code as a child process on the same machine. This works for solo use but limits team scenarios:

- Developers can't share their sessions with teammates
- Sessions are tied to one server's filesystem
- No visibility into what AI work is happening across the team
- Claude Code must run on the same machine as Codekin

The bridge solves this by separating "where Claude Code runs" from "where the UI lives."

---

## Core Concepts

### Bridge Agent

A small Node.js CLI tool (`codekin-bridge`) installed on the developer's machine. It:

1. Authenticates with a remote Codekin server
2. Spawns (or attaches to) a Claude Code CLI process
3. Relays stream-JSON messages bidirectionally between Claude CLI ↔ Codekin server
4. Handles reconnection and message buffering on network interruption
5. Reports its own status (online, working dir, active repo)

### Bridged Session

A new session source type (`source: 'bridge'`) in Codekin. Unlike `manual` sessions where the server owns the Claude process, bridged sessions are owned by the remote bridge. The server acts as a message router between the bridge and browser clients.

### Session Ownership

Every session has exactly one **owner** — the entity that controls the Claude CLI process:

| Session type | Owner | Claude process location |
|---|---|---|
| `manual` | Codekin server | Server (child process) |
| `bridge` | Bridge agent | Developer's machine |
| `webhook` | Codekin server | Server (child process) |

---

## Bridge Agent Design

### Installation & Usage

```bash
# Install globally
npm install -g @codekin/bridge

# Connect to a Codekin instance (starts the bridge daemon)
codekin-bridge connect \
  --server wss://codekin.example.com \
  --token <personal-access-token>

# Open a session on a specific repo (can be run multiple times)
codekin-bridge open /path/to/repo
codekin-bridge open /path/to/another-repo

# List active sessions
codekin-bridge sessions

# Close a session
codekin-bridge close <sessionId>

# Or with a config file
codekin-bridge connect --config ~/.codekin-bridge.json
```

### Config File

```json
{
  "server": "wss://codekin.example.com",
  "token": "ck_pat_...",
  "name": "Alice's Workstation",
  "reconnect": {
    "maxRetries": 10,
    "backoffMs": 1000,
    "maxBackoffMs": 30000
  },
  "offlineLogDir": "~/.codekin-bridge/offline-logs"
}
```

### Bridge Lifecycle

```
1. Start
   ├── Read config / CLI args
   ├── Validate Claude CLI is installed and accessible
   └── Connect WebSocket to Codekin server

2. Authenticate
   ├── Send { type: 'bridge_auth', token, bridgeInfo }
   ├── Server validates token, checks version compatibility
   ├── Receive { type: 'bridge_accepted', bridgeId, userId, serverVersion, minBridgeVersion }
   ├── If bridge version < minBridgeVersion: log error with upgrade instructions, disconnect
   └── If bridge version < serverVersion: log warning suggesting upgrade, continue

3. Open Sessions (can open multiple)
   ├── Send { type: 'bridge_session_open', workingDir, repoName }
   ├── Server creates a bridged session
   ├── Receive { type: 'bridge_session_created', sessionId }
   ├── Spawn Claude CLI: claude --output-format stream-json ...
   └── Track sessionId ↔ Claude process mapping locally

4. Relay Loop (per session, multiplexed over single WebSocket)
   ├── Claude stdout line → parse JSON → send { type: 'bridge_relay', sessionId, payload }
   ├── Server routes bridge_input by sessionId → bridge writes to correct Claude stdin
   └── Handle control_request / tool approvals bidirectionally (routed by sessionId)

5. Close Session
   ├── Bridge sends { type: 'bridge_session_close', sessionId }
   ├── Server marks session as closed
   └── Bridge kills the corresponding Claude CLI process

6. Disconnect (network loss)
   ├── All sessions transition to 'disconnected' on server
   ├── Bridge buffers output per session; falls back to offline log files if buffer fills
   ├── Bridge attempts reconnection with exponential backoff
   ├── On reconnect: re-authenticate, then send bridge_session_resume per active session
   └── Flush buffers or upload offline logs per session
```

### Bridge → Server Messages

```typescript
// Authentication
{ type: 'bridge_auth', token: string, bridgeInfo: BridgeInfo }

// Session lifecycle
{ type: 'bridge_session_open', workingDir: string, repoName?: string }
{ type: 'bridge_session_resume', sessionId: string }
{ type: 'bridge_session_suspend' }
{ type: 'bridge_session_close' }

// Claude output relay (wraps existing message types)
{ type: 'bridge_relay', payload: ClaudeOutputEvent }

// Status
{ type: 'bridge_heartbeat', ts: number }
{ type: 'bridge_status', status: 'idle' | 'working' }
```

### Server → Bridge Messages

```typescript
// Auth response
{ type: 'bridge_accepted', bridgeId: string, userId: string }
{ type: 'bridge_rejected', reason: string }

// Session
{ type: 'bridge_session_created', sessionId: string }
{ type: 'bridge_session_resumed', sessionId: string }

// User input from web UI (relay to Claude stdin)
{ type: 'bridge_input', data: string }

// Tool approval response from web UI
{ type: 'bridge_prompt_response', value: string, requestId: string }

// Heartbeat ack
{ type: 'bridge_heartbeat_ack', ts: number }
```

### Reconnection & Buffering

When the WebSocket connection drops:

1. Bridge continues running; all Claude CLI processes stay alive
2. Bridge buffers output per session in memory (bounded: max 5000 messages or 10MB per session)
3. If a session's buffer fills, bridge spills to an offline log file on disk (`~/.codekin-bridge/offline-logs/<sessionId>-<timestamp>.ndjson`) and sends a `bridge_gap` marker on reconnect
4. Bridge attempts reconnection with exponential backoff (1s → 2s → 4s → ... → 30s max)
5. On reconnect: re-authenticates, then sends `bridge_session_resume` for each active session
6. Server transitions each session from `disconnected` → `connected`
7. For sessions with in-memory buffers: bridge flushes buffered messages directly
8. For sessions with offline logs: bridge uploads log files via `POST /api/bridge/logs/:sessionId` and notifies via `bridge_offline_log` message. Server indexes the log into the session's output history.

---

## Server-Side Changes

### New Session Source

Add `'bridge'` to the session source union type:

```typescript
interface Session {
  // ... existing fields
  source: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'bridge'

  // Existing — used for manual/webhook/workflow sessions
  claudeProcess: ClaudeProcess | null

  // New — used for bridge sessions
  bridge: BridgeConnection | null
}
```

### BridgeConnection

A single bridge can own multiple sessions. The server tracks bridges separately from sessions:

```typescript
interface BridgeConnection {
  bridgeId: string
  userId: string          // Who owns this bridge
  ws: WebSocket           // The bridge's single WebSocket
  status: 'connected' | 'disconnected'
  connectedAt: Date
  lastHeartbeat: Date
  bridgeInfo: BridgeInfo  // Machine name, OS, etc.
  sessionIds: Set<string> // All sessions owned by this bridge
}

interface BridgeInfo {
  name: string            // e.g. "Alice's MacBook"
  platform: string        // e.g. "darwin", "linux"
  claudeVersion: string   // Claude CLI version
  nodeVersion: string
  bridgeVersion: string   // Bridge package version
}
```

Each bridged session references its parent bridge:

```typescript
interface Session {
  // ... existing fields
  bridge: {
    bridgeId: string      // Which bridge owns this session
    connection: BridgeConnection | null  // null when disconnected
  } | null
}
```

### Message Routing Changes

The `SessionManager` needs a routing abstraction that handles both local processes and remote bridges:

```
Input from browser:
  if session.source === 'manual':
    session.claudeProcess.sendMessage(data)     // existing: write to stdin
  if session.source === 'bridge':
    session.bridge.ws.send({ type: 'bridge_input', data })  // new: relay to bridge

Output handling:
  if session.source === 'manual':
    // existing: ClaudeProcess events → broadcast to clients
  if session.source === 'bridge':
    // new: bridge_relay messages → broadcast to clients (same format)
```

The key insight: **browser clients don't need to know whether a session is local or bridged.** The server normalizes everything into the existing `WsServerMessage` types before broadcasting.

### Bridge WebSocket Endpoint

A new WebSocket path or a new auth type on the existing endpoint:

```
ws://codekin.example.com/bridge   (dedicated path)
  — or —
ws://codekin.example.com/         (existing, distinguished by auth message type)
```

Recommendation: **dedicated path** (`/bridge`). This keeps bridge traffic separate from browser traffic and allows independent rate limiting, monitoring, and access control.

### Session Persistence

Bridged sessions are persisted the same way as other sessions in `sessions.json`. On server restart:
- Bridged sessions are restored in `disconnected` state
- When the bridge reconnects and sends `bridge_session_resume`, the session transitions back to `connected`

---

## Authentication & Identity

### Personal Access Tokens (PATs)

Bridges authenticate using personal access tokens rather than the shared master token:

```
ck_pat_<userId>_<random>
```

This allows:
- Associating bridge sessions with a specific user
- Revoking individual bridge access without affecting others
- Different permission levels per user

### Token Management

```
POST /api/tokens          — create a new PAT (requires master auth)
DELETE /api/tokens/:id    — revoke a PAT
GET /api/tokens           — list active PATs (admin)
```

Tokens are stored hashed (SHA-256) in `~/.codekin/bridge-tokens.json`.

### User Identity

Each PAT is associated with a user record:

```typescript
interface CodekinUser {
  id: string
  name: string        // Display name (e.g. "Alice")
  createdAt: Date
  lastSeen: Date
}
```

Users are lightweight — no password, no email. They exist solely to associate bridge sessions with a human identity for team visibility.

---

## Team Visibility

### Session List Enhancements

The session list in the UI gains new metadata for bridged sessions:

```typescript
interface SessionListItem {
  // ... existing fields
  source: 'manual' | 'bridge' | 'webhook' | ...
  owner?: {
    userId: string
    name: string          // "Alice"
  }
  bridge?: {
    status: 'connected' | 'disconnected'
    machineName: string   // "Alice's MacBook"
    disconnectedAt?: Date // When bridge last disconnected
  }
}
```

### UI States for Bridged Sessions

| Bridge status | Session state | UI presentation |
|---|---|---|
| Connected + idle | Active | Green dot, "Alice — idle" |
| Connected + working | Active | Pulsing dot, "Alice — working" |
| Disconnected | Suspended | Gray dot, "Alice — disconnected 5m ago" |
| Disconnected > 24h | Stale | Dimmed, "Alice — offline since Mar 11" |

### Watching Sessions

Any authenticated browser client can join a bridged session as a **spectator**:

- Spectators see the full output stream in real-time
- Spectators see the output history buffer when joining mid-session
- Spectators can see tool approvals and their resolutions
- Spectators **cannot** send input or respond to prompts (read-only)

The session owner (the person whose bridge it is) retains full control.

### Who Can Send Input?

For bridged sessions, input can come from two places:

1. **The developer's local terminal** — if they're also interacting with Claude CLI directly (the bridge is transparent; it doesn't block local stdin)
2. **The Codekin web UI** — the session owner can send input from the browser

To prevent conflicts:

- **Local input** always wins (it goes directly to Claude's stdin; the bridge sees the echo in stdout and relays it)
- **Web UI input** is relayed through the bridge to Claude's stdin
- Both inputs appear in the output stream, attributed to their source
- No locking — this is analogous to two people typing in a shared terminal. Trust the team.

### Team Dashboard (Future)

A dedicated view showing:
- All online bridges and their sessions
- Team activity feed (who started a session, who's actively coding)
- Aggregate stats (sessions today, cost across team)

This is out of scope for v1 but the data model supports it.

---

## Security Considerations

### Threat Model

The bridge grants remote control of Claude Code on a developer's machine through the Codekin server. This is a significant trust boundary.

| Threat | Mitigation |
|---|---|
| Unauthorized bridge connections | PAT authentication; tokens are hashed at rest |
| Man-in-the-middle | TLS required (wss://); bridge refuses non-TLS connections |
| Stolen PAT | Token revocation endpoint; tokens scoped to a single user |
| Malicious input from web UI | The developer's own Claude Code permission settings still apply — tool approvals, permission mode, etc. are enforced locally by Claude CLI |
| Server compromise → remote code execution | Bridge should support a `--read-only` mode that blocks inbound input relay |
| Data exfiltration via output stream | Output contains code, file contents, terminal output. TLS protects in transit; access control on Codekin server limits who can watch |

### Bridge Read-Only Mode

```bash
codekin-bridge connect --read-only ...
```

In read-only mode:
- Bridge relays Claude output to the server (team can watch)
- Bridge **ignores** any inbound input or prompt responses from the server
- The developer retains full local control
- Useful for broadcasting work without granting remote control

---

## Protocol Summary

### New Message Types (Bridge ↔ Server)

```typescript
// === Bridge → Server ===

interface BridgeAuthMessage {
  type: 'bridge_auth'
  token: string
  bridgeVersion: string     // semver, e.g. "0.1.0"
  bridgeInfo: BridgeInfo
}

interface BridgeSessionOpenMessage {
  type: 'bridge_session_open'
  workingDir: string
  repoName?: string
  sessionName?: string
}

interface BridgeSessionResumeMessage {
  type: 'bridge_session_resume'
  sessionId: string
}

interface BridgeSessionCloseMessage {
  type: 'bridge_session_close'
  sessionId: string
}

// Claude output relay — sessionId routes to the correct server-side session
interface BridgeRelayMessage {
  type: 'bridge_relay'
  sessionId: string
  payload: ClaudeOutputEvent   // Any parsed stdout event
}

interface BridgeHeartbeatMessage {
  type: 'bridge_heartbeat'
  ts: number
  activeSessions: string[]    // sessionIds with running Claude processes
}

// Sent after reconnect if messages were lost during disconnect
interface BridgeGapMessage {
  type: 'bridge_gap'
  sessionId: string
  droppedCount: number
  fromTs: number
  toTs: number
}

// Sent after reconnect if offline logs need uploading
// (actual upload happens via REST endpoint, this is a notification)
interface BridgeOfflineLogMessage {
  type: 'bridge_offline_log'
  sessionId: string
  logFile: string             // filename, uploaded via POST /api/bridge/logs
  messageCount: number
  fromTs: number
  toTs: number
}

// === Server → Bridge ===

interface BridgeAcceptedMessage {
  type: 'bridge_accepted'
  bridgeId: string
  userId: string
  serverVersion: string       // server protocol version
  minBridgeVersion: string    // minimum compatible bridge version
}

interface BridgeRejectedMessage {
  type: 'bridge_rejected'
  reason: string
}

interface BridgeSessionCreatedMessage {
  type: 'bridge_session_created'
  sessionId: string
}

interface BridgeSessionResumedMessage {
  type: 'bridge_session_resumed'
  sessionId: string
}

// User input from web UI — sessionId tells bridge which Claude stdin to write to
interface BridgeInputMessage {
  type: 'bridge_input'
  sessionId: string
  data: string
  fromUser?: string   // Who sent it from the web UI
}

// Tool approval response from web UI
interface BridgePromptResponseMessage {
  type: 'bridge_prompt_response'
  sessionId: string
  value: string
  requestId: string
  fromUser?: string
}

interface BridgeHeartbeatAckMessage {
  type: 'bridge_heartbeat_ack'
  ts: number
}
```

### Existing Messages (Unchanged)

All existing `WsServerMessage` and `WsClientMessage` types remain unchanged. Browser clients interact with bridged sessions using the same message types they use for local sessions. The server handles the translation.

---

## Implementation Phases

### Phase 1: Core Bridge

- Bridge agent CLI tool (spawn Claude, relay messages, reconnect)
- Server-side bridged session support (new source type, routing)
- `/bridge` WebSocket endpoint with PAT auth
- Basic UI: bridged sessions appear in session list with owner name and status

### Phase 2: Team Experience

- Spectator mode (read-only watching of others' sessions)
- Session status indicators (connected/disconnected/working)
- Bridge info in session details (machine name, uptime)
- Token management UI

### Phase 3: Polish & Security

- Bridge `--read-only` mode
- Connection quality indicators (latency, message rate)
- Output gap handling (reconnection with buffer flush)
- Session archival for bridged sessions
- Rate limiting per bridge

### Phase 4: Team Dashboard (Future)

- Team activity overview
- Aggregate cost tracking
- Session search/filter by user
- Notifications (e.g. "Alice's session needs approval")

---

## Design Decisions

1. **Multi-session bridge** — One bridge process manages multiple concurrent Claude sessions. Codekin encourages working on multiple sessions at a time, so the bridge should mirror that. The bridge multiplexes sessions over a single WebSocket connection, using `sessionId` to route messages.

2. **No session transfer** — Bridged sessions cannot be detached and continued as local server sessions (or vice versa). The two modes are distinct. If needed, users can start a new local session and reference the bridged session's history.

3. **Offline log upload** — If the bridge is disconnected for an extended period, it writes output to a local log file (`~/.codekin-bridge/offline-logs/<sessionId>-<timestamp>.ndjson`). On reconnect, instead of replaying thousands of messages, the bridge uploads the log file via a REST endpoint. The server indexes it into the session's output history. For short disconnects (< buffer capacity), in-memory buffering and replay is used.

4. **Version handshake** — The bridge sends its version in `bridge_auth`. The server responds with `bridge_accepted` including a `serverVersion` and `minBridgeVersion`. If the bridge version is below `minBridgeVersion`, the bridge logs a warning with upgrade instructions (`npm update -g @codekin/bridge`) and refuses to connect. If it's above `minBridgeVersion` but below `serverVersion`, the bridge logs a non-blocking warning suggesting an upgrade.

5. **Single server** — One bridge connects to one Codekin server. Config is a flat file. Multi-server support is deferred.
