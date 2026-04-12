# Codekin

Web-based terminal UI for Claude Code sessions with multi-session support, WebSocket streaming, and slash-command skills.

## Development

```bash
npm install          # install dependencies
npm run dev          # start Vite dev server
npm run build        # typecheck + production build
npm test             # run tests once
npm run test:watch   # watch mode
npm run lint         # eslint
```

## Branching & Release Policy

- **NEVER commit or push directly to `main`.** Always create a feature/fix branch and open a PR.
- Branch naming: `feat/description` or `fix/description`.
- All changes go through PRs with review and passing CI.

## Bash Tool Conventions (Skills & Subagents)

- **One command per Bash call** — do NOT chain with `;`, `&&`, `||`, or pipes
- **Do NOT use `echo` to inspect exit codes** — the Bash tool returns them automatically
- **Do NOT use `cat` to read files** — use the Read tool instead
- These rules prevent multi-operation approval prompts in the Codekin terminal UI

## Audit & Report Output

When generating audit reports, health checks, or any recurring assessment:

1. **Always write the report to a file** — never just print it as conversation text.
2. **Location**: `.codekin/reports/<category>/YYYY-MM-DD_<type>.md` (e.g., `.codekin/reports/security/2026-04-10_security-audit.md`).
3. **Existing categories**: `code-review`, `comments`, `complexity`, `dependencies`, `docs-audit`, `repo-health`, `security`, `test-coverage`. Create new subdirectories if needed.
4. **Clean output only** — do not include internal reasoning, chain-of-thought, or status messages (e.g., "Now I have the data...") in the report file. The file should contain only the finished report.
5. **Commit the report** on a branch and open a PR so it is visible in the repo history.

## Output Conventions

- Always use fenced code blocks (` ```language `) for code/config snippets
- Never rely on tool output alone to show file contents — paste in a code block if the user needs to see it

## Key Conventions

- TypeScript strict mode for server code
- WebSocket message types defined in `src/types.ts` and `server/types.ts`

## References

- `docs/architecture.md` — module map, data flow, key abstractions
- `docs/conventions.md` — coding patterns and file organization
- `docs/WORKFLOWS.md` — automated workflow system
- `docs/API-REFERENCE.md` — REST and WebSocket API
- `docs/stream-json-protocol.md` — Claude CLI integration protocol
- `docs/FEATURES.md` — comprehensive feature reference
- `docs/PR-REVIEW-WEBHOOK.md` — PR review webhook flow and configuration
- `docs/PROVIDER-HEALTH-BACKLOG.md` — provider health tracking + retry backlog for webhook reviews
