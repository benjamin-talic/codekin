# Diff Viewer Sidebar — Specification

A right-hand sidebar panel that shows all file changes made by Claude during the current session, with inline unified diffs and file-level navigation.

---

## Motivation

When Claude edits files during a session, the changes are visible only as tool activity chips in the chat stream. Once the conversation grows, it's hard to get a consolidated view of *what actually changed*. The diff viewer gives the user a persistent, browsable summary of all file modifications — similar to VS Code's Source Control panel or GitHub's "Files changed" tab.

---

## User Experience

### Opening / Closing

- **Toggle button** in the top-right area of the main chat panel (icon: `<>` or a split-diff icon).
- **Keyboard shortcut**: `Ctrl+Shift+D` / `Cmd+Shift+D`.
- The panel opens as a **right sidebar**, alongside the chat. It does NOT replace the chat — both are visible side by side.
- On mobile, it opens as a **full-screen overlay** (slide-in from right) with a close button.

### Layout

```
┌────────────┐ ┌──────────────────────┐ ┌─────────────────┐
│  Left      │ │   Chat Area          │ │  Diff Viewer    │
│  Sidebar   │ │                      │ │                 │
│            │ │                      │ │  file-tree      │
│            │ │                      │ │  ────────────── │
│            │ │                      │ │  unified diff   │
│            │ │                      │ │  (scrollable)   │
│            │ │                      │ │                 │
└────────────┘ └──────────────────────┘ └─────────────────┘
```

- Default width: **400px**, resizable (drag left edge), min 280px, max 600px.
- The chat area shrinks to accommodate the diff panel (flexbox).
- Width preference persisted in `localStorage` (`codekin-diff-panel-width`).

### File Tree (top section)

A compact list of changed files, grouped by status:

| Icon | Status | Color | Meaning |
|------|--------|-------|---------|
| `M`  | Modified | yellow | File was edited (Edit tool) |
| `A`  | Added | green | File was created (Write tool to new path) |
| `D`  | Deleted | red | File was removed (Bash `rm` detected) |
| `R`  | Renamed | blue | File was moved/renamed; displayed as `old → new` |

Each row shows:
- Status badge (M/A/D/R) with color per table above
- Relative file path (relative to session `workingDir`)
- Additions / deletions count (`+12 −3`)

Click a file to scroll the diff section to that file. The active file is highlighted.

### Diff Section (bottom / scrollable)

- **Unified diff** format, one file after another, scrollable.
- Syntax-highlighted with the same theme as code blocks in chat.
- **Two-gutter line numbers**: old line number on the left, new on the right. Added lines show a blank old gutter; deleted lines show a blank new gutter. Context lines show both.
- Added lines highlighted green, removed lines highlighted red, context lines neutral.
- **Collapsed by default** for files with >300 changed lines (additions + deletions), click to expand.
- Each file section has a header bar with the file path and expand/collapse toggle.

### Summary Bar (sticky top)

- Total files changed, total insertions, total deletions.
- Example: `5 files changed  +87 −23`
- "Refresh" button to re-fetch the current diff state.

---

## Data Flow

### Source of Truth: `git diff`

The diff data comes from running `git diff` in the session's working directory on the server. This captures the *actual* filesystem state vs the last commit — which is exactly what Claude changed.

We do **not** try to reconstruct diffs from tool events (too fragile — Bash commands can also modify files). Instead, we ask the server for the real git diff.

### New WebSocket Messages

#### Client → Server

```typescript
| { type: 'get_diff'; scope?: 'staged' | 'unstaged' | 'all' }
```

- `scope` determines which git command runs:
  - `'unstaged'` → `git diff --no-color --unified=3` (working tree vs index)
  - `'staged'` → `git diff --cached --no-color --unified=3` (index vs HEAD)
  - `'all'` (default) → `git diff HEAD --no-color --unified=3` (working tree vs HEAD, combines staged + unstaged)
- Requests the current diff for the active session's working directory.

#### Server → Client

```typescript
| { type: 'diff_result'; files: DiffFile[]; summary: DiffSummary; truncated?: boolean }
| { type: 'diff_error'; message: string }
```

```typescript
interface DiffFile {
  path: string                     // relative to workingDir
  status: 'modified' | 'added' | 'deleted' | 'renamed'
  oldPath?: string                 // set when status is 'renamed'
  isBinary: boolean                // true for binary files (no hunks emitted)
  additions: number                // 0 for binary files
  deletions: number                // 0 for binary files
  hunks: DiffHunk[]                // empty for binary files
}

interface DiffHunk {
  header: string                   // e.g. "@@ -10,7 +10,8 @@"
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string                  // line text WITHOUT the leading +/-/space prefix, no trailing newline
  oldLineNo?: number               // undefined for 'add' lines
  newLineNo?: number               // undefined for 'delete' lines
}

interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
  truncated: boolean               // true if output exceeded size limits
  truncationReason?: string        // e.g. "Diff output exceeded 2 MB limit"
}
```

### Server Implementation

On receiving `get_diff`, the session manager:

1. Validates the requesting client is joined to a session.
2. Resolves the `workingDir` from the server-side session record (never from client input).
3. Runs `git diff` (per scope, see above) with `--find-renames --no-color --unified=3` as a fixed argv array (no shell interpolation). Also runs `git ls-files --others --exclude-standard` to discover untracked files.
4. For each untracked file, generates a synthetic "added" diff by diffing `/dev/null` against the file content (does **not** mutate the index with `git add -N`).
5. Parses the combined output into `DiffFile[]`. If raw output exceeds **2 MB**, parsing stops, `truncated` is set to `true`, and files parsed so far are returned.
6. Sends `diff_result` back to the requesting client only (not broadcast). On error (e.g. not a git repo, git not found), sends `diff_error` instead.

**Constraints:**
- Git commands run with a **10-second timeout** and **2 MB stdout cap** (`maxBuffer`).
- `workingDir` must match a known session — no arbitrary path execution.
- Binary files are detected via `Binary files ... differ` or `GIT binary patch` markers; the parser sets `isBinary: true` and emits no hunks.

A `parseDiff(raw: string): { files: DiffFile[]; truncated: boolean }` utility handles the parsing. This is a new server module: `server/diff-parser.ts`.

### Auto-Refresh

The diff panel auto-refreshes after:
- A `tool_done` event where `toolName` is `Edit` or `Write` (always, debounced 500ms).
- A `tool_done` event where `toolName` is `Bash` **only if** the tool summary suggests a file-mutating command (heuristic: summary does not start with common read-only commands like `ls`, `cat`, `echo`, `grep`, `git log`, `git status`, `pwd`, `which`, `node -e`). When in doubt, refresh — false positives are cheap, missed updates are confusing.
- The user clicks the manual "Refresh" button.

The panel does **not** poll on an interval. It refreshes reactively.

---

## Frontend Components

### New Components

| Component | File | Description |
|-----------|------|-------------|
| `DiffPanel` | `src/components/DiffPanel.tsx` | Top-level right sidebar container. Manages open/close state, width, resize handle. |
| `DiffFileTree` | `src/components/diff/DiffFileTree.tsx` | Compact file list with status badges and change counts. |
| `DiffFileView` | `src/components/diff/DiffFileView.tsx` | Single file's diff display: header + hunks. |
| `DiffHunkView` | `src/components/diff/DiffHunkView.tsx` | Renders one hunk with line numbers and syntax highlighting. |
| `DiffSummaryBar` | `src/components/diff/DiffSummaryBar.tsx` | Sticky top bar with aggregate stats and refresh button. |

### New Hook

| Hook | File | Description |
|------|------|-------------|
| `useDiff` | `src/hooks/useDiff.ts` | Sends `get_diff`, receives `diff_result`, manages diff state. Exposes `refresh()`, `files`, `summary`, `loading`. Auto-refreshes on relevant `tool_done` events. |

### Integration Points

- **`App.tsx`**: Add `DiffPanel` to the right side of the flex layout, conditionally rendered.
- **`types.ts`**: Add `get_diff` to `WsClientMessage`, `diff_result` to `WsServerMessage`, plus `DiffFile`, `DiffHunk`, `DiffLine`, `DiffSummary` interfaces.
- **`useChatSocket.ts`**: Route incoming `diff_result` messages to the `useDiff` hook. Emit auto-refresh signals on `tool_done` for file-mutating tools.
- **`LeftSidebar.tsx`** or top bar: Add the toggle button for the diff panel.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+Shift+D` | Toggle diff panel |
| `Escape` (when panel focused) | Close diff panel |
| `↑` / `↓` (in file tree) | Navigate files |
| `Enter` (in file tree) | Scroll to file diff |

---

## Edge Cases

- **No git repo**: If the session's `workingDir` is not inside a git repository, the diff panel shows an info message: "Not a git repository — diff view unavailable."
- **No changes**: Shows "No changes detected" with a subtle icon.
- **Binary files**: Listed in the file tree with a "binary" badge (`isBinary: true`); no inline diff shown, additions/deletions reported as 0.
- **Large diffs**: Files with >300 changed lines (additions + deletions) are collapsed by default with a note: "Large diff (N lines) — click to expand." If the entire diff payload was truncated (>2 MB), a banner reads: "Diff truncated — showing partial results."
- **Uncommitted new files**: Untracked files are discovered via `git ls-files --others --exclude-standard` and diffed as synthetic additions (compare `/dev/null` to file content). The server does **not** run `git add -N` or otherwise mutate the index.
- **Renamed files**: Detected via `git diff --find-renames` and displayed in the file tree as `R old → new` with a blue badge.
- **Session without active Claude process**: Diff is still available — it reads the filesystem, not the process.

---

## Styling

- Follows the existing Codekin theme (neutral backgrounds, accent colors from `src/index.css`).
- Diff colors:
  - Added lines: `bg-success-950/30` (dark) / `bg-success-100` (light), text `text-success-400`
  - Deleted lines: `bg-error-950/30` (dark) / `bg-error-100` (light), text `text-error-400`
  - Context lines: default background
  - File headers: `bg-neutral-800` (dark) / `bg-neutral-100` (light)
- Line numbers: `text-neutral-500`, monospace (Inconsolata).
- Resize handle: Same treatment as the left sidebar resize handle.
- Transition: Slide-in from right, 150ms ease-out.

---

## Non-Goals (v1)

These are explicitly out of scope for the initial implementation:

- **Side-by-side diff view** — unified only for v1.
- **Inline commenting / review** — this is a viewer, not a review tool.
- **Commit / stage from the UI** — the user does this through Claude or the terminal.
- **Diff between arbitrary commits** — always diffs working tree vs HEAD.
- **File editing from the diff panel** — read-only.

---

## Implementation Order

1. **Server**: `diff-parser.ts` + `get_diff` message handler in session-manager.
2. **Types**: Add new message types and interfaces to `src/types.ts` and `server/types.ts`.
3. **Hook**: `useDiff.ts` — WebSocket integration + auto-refresh logic.
4. **Components**: `DiffPanel` → `DiffSummaryBar` → `DiffFileTree` → `DiffFileView` → `DiffHunkView`.
5. **App integration**: Layout changes in `App.tsx`, toggle button, keyboard shortcut.
6. **Polish**: Resize persistence, mobile overlay, collapsed large files, syntax highlighting.
