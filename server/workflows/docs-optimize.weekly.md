---
kind: docs-optimize.weekly
name: Documentation Optimization
sessionPrefix: docs-optimize
outputDir: .codekin/reports/docs-optimize
filenameSuffix: _docs-optimize.md
commitMessage: chore: documentation optimization report
---
You are performing an automated documentation optimization. Your goal is to make the repo's documentation **agent-friendly**: lean CLAUDE.md files that load fast into every session, detailed reference docs in `/docs` for when agents need them, and accurate architecture documentation derived from the actual code.

This workflow **modifies files and opens a PR**. You are not just reporting — you are making the changes.

## Part 1 — Audit CLAUDE.md

1. **Read the current CLAUDE.md** (root and any nested ones in subdirectories).

2. **Evaluate every line** against these criteria — CLAUDE.md is loaded into every single Claude session, so every line costs context window space:
   - **KEEP** in CLAUDE.md: project identity (name, one-line description), branching/release policy, critical "never do X" rules, environment setup (dev commands), key conventions that can't be inferred from code.
   - **MOVE** to `/docs`: detailed how-to instructions (testing procedures, deployment steps, commit conventions with examples), architecture descriptions, coding style guides longer than 3 lines, tool-specific setup guides.
   - **DELETE**: information that is obvious from the code (e.g., "this is a TypeScript project"), duplicated from README.md, outdated references to removed features, verbose explanations of things an AI agent can infer.

3. **Rewrite CLAUDE.md** to be minimal:
   - Target: under 60 lines for the root CLAUDE.md.
   - Use terse bullet points, not paragraphs.
   - For moved content, add a one-line reference: `See docs/testing.md for test procedures.`
   - Keep the file self-contained for the most common operations (build, test, lint, commit).

## Part 2 — Create/Update Reference Docs

4. **Move extracted content** from CLAUDE.md into well-named docs:
   - `docs/testing.md` — how to run tests, test conventions, coverage expectations
   - `docs/contributing.md` — commit conventions, PR process, branch naming
   - `docs/architecture.md` — see Part 3 below
   - Use whatever file names make sense for the content. Don't create empty docs.

5. **Clean up existing `/docs`**:
   - Delete docs that describe completed proposals or plans that have been implemented.
   - Merge docs that cover overlapping topics into a single file.
   - Remove docs that duplicate information available in CLAUDE.md or README.md.
   - Update any stale references (wrong file paths, renamed functions, removed features).

## Part 3 — Generate Architecture Documentation

6. **Analyze the codebase** and produce `docs/architecture.md`:
   - **Module map**: list each top-level directory and its responsibility (one line each).
   - **Data flow**: how data moves through the system (e.g., request → handler → service → database).
   - **Key abstractions**: the 5-10 most important classes/types/interfaces and what they represent.
   - **Entry points**: where execution starts (server bootstrap, CLI entry, main functions).
   - **External dependencies**: what external services/APIs the code talks to and where.
   - Keep it factual and derived from code — no aspirational content.
   - Target: 100-200 lines. This is a reference for agents, not a textbook.

7. **Extract best practices from the code** into `docs/conventions.md`:
   - Look at actual patterns in the codebase: error handling style, naming conventions, file organization, test patterns.
   - Document what the code *does*, not what it *should* do.
   - Only include patterns that are consistent across the codebase (not one-off styles).
   - Keep it under 80 lines.

## Part 4 — Commit and Open PR

8. **Create a branch and PR**:
   - Branch name: `chore/docs-optimize-YYYY-MM-DD` (use today's date)
   - Commit all documentation changes in a single commit with message: `chore: optimize documentation for agent efficiency`
   - Push the branch and open a PR with:
     - Title: `chore: optimize documentation for agent efficiency`
     - Body summarizing what was changed: what was trimmed from CLAUDE.md, what was moved to docs, what new docs were created, what was deleted.
   - Use `gh pr create` to open the PR.

## Important Rules

- **DO modify files.** This is not a read-only audit.
- **DO NOT touch source code.** Only documentation files (`.md` files, CLAUDE.md).
- **DO NOT invent conventions.** Only document patterns that actually exist in the code.
- **DO NOT add aspirational content** ("we should...", "ideally..."). Document what is, not what should be.
- **Preserve critical safety rules** in CLAUDE.md (e.g., "never push to main", security policies).
- If CLAUDE.md is already well-optimized (under 60 lines, no verbose content), say so and focus on docs/ cleanup and architecture docs instead.

---

Produce a structured Markdown report summarizing what you changed. Your entire response will be saved as the report file, so write valid Markdown only — no conversational preamble.

Report structure:

## Summary
(What was done: lines removed from CLAUDE.md, docs created/updated/deleted, PR link)

## CLAUDE.md Changes
(Before/after line count. List of items removed, moved, or reworded. Rationale for each.)

## Docs Created
(Table: file, purpose, line count)

## Docs Updated
(Table: file, what changed)

## Docs Deleted
(Table: file, reason for deletion)

## Architecture Highlights
(Key findings from the architecture analysis — module boundaries, data flow, notable patterns)

## PR
(Link to the opened PR)
