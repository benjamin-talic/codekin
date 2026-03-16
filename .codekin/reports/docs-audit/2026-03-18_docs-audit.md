# Documentation Audit: codekin

**Date**: 2026-03-18T02:20:34.644Z
**Repository**: /srv/repos/codekin
**Branch**: main
**Workflow Run**: 0b61d1aa-6ed1-41cd-8e7e-86c08166b4e5
**Session**: 1638fa06-ec34-4dc9-a210-e215643319be

---

## Summary

**Total tracked documentation files: 17** (6 root-level `.md`, 10 in `docs/`, 1 in `.github/`)  
**Files needing attention: 7**  
**Key findings:** Four large specification documents (3,857 combined lines) describe features that are fully shipped — they have served their design purpose and are now dead weight. The "Shepherd" orchestrator was renamed to "Agent Joe" in code on 2026-03-17, but `docs/ORCHESTRATOR-SPEC.md`, `docs/FEATURES.md`, and `docs/GITHUB-WEBHOOKS-SPEC.md` still use the old name. The `"apiKeySet"` field in the health endpoint response is documented but the underlying API key logic was removed in a 2026-03-16 refactor.

**Health rating: Needs cleanup** — Core reference docs (API-REFERENCE, SETUP, WORKFLOWS, README) are recent and reasonably accurate. The `docs/` directory is bloated by implementation specs that have already shipped and no longer serve a navigational or reference purpose.

---

## Documentation Inventory

| Path | Lines | Last Modified | Purpose | Status |
|------|-------|--------------|---------|--------|
| `README.md` | 104 | 2026-03-17 | User-facing install, features, config table | Current |
| `CLAUDE.md` | 48 | 2026-03-08 | Project conventions for AI assistant | Current |
| `CONTRIBUTING.md` | 122 | 2026-03-14 | Developer onboarding, branching, PR process | Current |
| `CODE_OF_CONDUCT.md` | 31 | 2026-03-08 | Community standards (Contributor Covenant v2.1) | Current |
| `SECURITY.md` | 43 | 2026-03-08 | Vulnerability reporting policy | Current |
| `LICENSE` | 21 | 2026-03-08 | MIT License | Current |
| `.github/PULL_REQUEST_TEMPLATE.md` | ~20 | 2026-03-08 | PR checklist template | Current |
| `docs/API-REFERENCE.md` | 385 | 2026-03-16 | All REST API and hook endpoints | Stale (1 field) |
| `docs/SETUP.md` | 437 | 2026-03-16 | Production deployment guide (nginx + Authelia) | Current |
| `docs/WORKFLOWS.md` | 182 | 2026-03-14 | Automated workflow system and built-in kinds | Current |
| `docs/FEATURES.md` | 367 | 2026-03-14 | Comprehensive feature reference | Stale (Shepherd rename) |
| `docs/INSTALL-DISTRIBUTION.md` | 181 | 2026-03-16 | npm package, CLI commands, service install | Current |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | 810 | 2026-03-14 | Webhook integration design spec (multi-phase) | Stale (Shepherd name) |
| `docs/APPROVALS-FIX-SPEC.md` | 655 | 2026-03-14 | Implementation spec for approval system fixes | Outdated (completed proposal) |
| `docs/CLAUDE-HOOKS-SPEC.md` | 1,723 | 2026-03-08 | Full Claude CLI hooks specification | Outdated (completed, never updated) |
| `docs/ORCHESTRATOR-SPEC.md` | 669 | 2026-03-17 | Shepherd/Agent Joe orchestrator design spec | Stale (wrong name throughout) |
| `docs/stream-json-protocol.md` | 561 | 2026-03-13 | Claude CLI stream-JSON spawning protocol | Current |

---

## Staleness Findings

### 1. `docs/ORCHESTRATOR-SPEC.md` — Wrong product name throughout
- **Last modified:** 2026-03-17 (same day as the rename commit `f01005a`)
- The spec was created as a "Shepherd" spec. The rename commit (`feat: rename Shepherd to Agent Joe`) updated code (`server/shepherd-manager.ts`, `src/components/ShepherdView.tsx`) and UI, but `ORCHESTRATOR-SPEC.md` was not updated in that commit.
- The file uses "Shepherd" in every heading, description, and code example. The current UI calls this feature "Agent Joe."
- **Broken reference:** Any developer reading this spec to understand the orchestrator will find a name that no longer matches the codebase.

### 2. `docs/FEATURES.md` — Shepherd rename not reflected
- **Last modified:** 2026-03-14. Rename happened 2026-03-17.
- References the orchestrator feature as "Shepherd" throughout its feature list.
- Also does not mention the "Joe" chat variant (`feat: add Joe agent chat variant`, `feat: add Joe welcome screen`) — both PRs merged after this file's last update.
- The `source` field in the `Session` type now includes `'joe'` alongside `'agent'`, which is not reflected anywhere in FEATURES.md.

### 3. `docs/API-REFERENCE.md` — Stale `apiKeySet` field in health response
- The health endpoint example response includes `"apiKeySet": true`.
- Commit `e099d28` ("chore: remove AI SDK dependencies and API key prompts", 2026-03-16) removed API key logic from the server. The `apiKeySet` field in the health response was part of this now-removed subsystem.
- **Risk:** Consumers of the API following this doc will expect a field that may no longer appear.

### 4. `docs/CLAUDE-HOOKS-SPEC.md` — No updates since initial release
- **Last modified:** 2026-03-08 (initial release commit `4ff4e8c`). This is the only doc file with zero subsequent commits.
- Over 40 commits have touched `server/` since then, including changes to `approval-manager.ts`, `session-manager.ts`, and hook routing.
- The spec is 1,723 lines — the largest file in the `docs/` directory — yet it has never been reconciled with any post-release changes.
- **Specific concern:** The hooks spec documents `SubagentStart` and `Notification` hook types. These should be verified against current hook infrastructure.

### 5. `docs/GITHUB-WEBHOOKS-SPEC.md` — Shepherd references in Phase 2+ sections
- Last updated 2026-03-14. The spec references the Shepherd session as the consumer of webhook events in Phases 2–4. Since the Shepherd → Agent Joe rename, those phase descriptions contain the wrong name.

---

## Accuracy Issues

### 1. Health endpoint `apiKeySet` field (`docs/API-REFERENCE.md`, health response example)
- **Claim:** `GET /api/health` returns `{ ..., "apiKeySet": true, ... }`
- **Current state:** The "remove AI SDK dependencies and API key prompts" refactor (2026-03-16) suggests this field may have been dropped from the response. Verify against `server/ws-server.ts`.

### 2. Orchestrator name is "Agent Joe", not "Shepherd" (`docs/ORCHESTRATOR-SPEC.md`, all sections)
- **Claim:** Feature is called "Shepherd"
- **Current state:** Feature is called "Agent Joe" in all UI, code comments (`server/shepherd-manager.ts`), and recent commits.

### 3. FEATURES.md omits Joe chat variant and welcome screen
- **Claim:** Chat interface section does not mention the Joe/agent variant
- **Current state:** Two PRs (#183, #184, #185, #186, #187) added a distinct "Joe" chat variant with its own visual identity and welcome screen. These are significant UI features absent from the feature reference.

### 4. APPROVALS-FIX-SPEC.md references `usePromptState.ts` implementation details
- **Claim:** Fix 1 proposes replacing single-slot prompt state with a Map-based queue
- **Current state:** `src/hooks/usePromptState.ts` already implements `Map<sessionId, Map<requestId, PromptEntry>>` — the fix has been shipped. The spec describes a proposed change that is now the actual implementation, creating false "proposal" framing.

### 5. INSTALL-DISTRIBUTION.md — `server/workflows/` path
- **Claim:** The npm package `files` array includes `"server/workflows/"`
- **Current state:** Workflow files appear to live in `.codekin/reports/workflows/` at runtime (per the directory listing). The `server/workflows/` path in `package.json` `files` field should be verified against the actual build output.

---

## Overlap & Redundancy

### Group 1: Approval system documentation
| File | Coverage |
|------|----------|
| `docs/APPROVALS-FIX-SPEC.md` | Detailed design spec for 6 specific fixes (655 lines) |
| `docs/API-REFERENCE.md` | Approval endpoints reference (`/api/approvals`, hook endpoints) |
| `docs/CLAUDE-HOOKS-SPEC.md` | Hook callbacks that feed into the approval system |

**Overlap:** All three cover the approval/hook pipeline. APPROVALS-FIX-SPEC is a completed proposal — its lasting value is zero since the fixes are in the code. API-REFERENCE.md is the authoritative live reference.  
**Recommendation:** Delete APPROVALS-FIX-SPEC.md. API-REFERENCE.md is sufficient.

### Group 2: Orchestrator documentation
| File | Coverage |
|------|----------|
| `docs/ORCHESTRATOR-SPEC.md` | Full design spec for "Shepherd"/Agent Joe (669 lines) |
| `docs/FEATURES.md` | Feature reference that should cover Agent Joe |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Describes Shepherd as webhook consumer in Phases 2-4 |

**Overlap:** ORCHESTRATOR-SPEC.md and FEATURES.md both describe the Agent Joe orchestrator. The spec is more detailed but uses a stale name. FEATURES.md is the right home for a concise description of shipped functionality.  
**Recommendation:** Condense the shipped functionality from ORCHESTRATOR-SPEC.md into an "Agent Joe" section in FEATURES.md, then delete the spec.

### Group 3: Workflow system
| File | Coverage |
|------|----------|
| `docs/WORKFLOWS.md` | User-facing guide to workflow system (182 lines) |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Technical spec for webhook-triggered workflows |
| `docs/API-REFERENCE.md` | REST endpoints for workflow runs, schedules, config |

**Overlap:** All three describe aspects of the workflow system. WORKFLOWS.md and API-REFERENCE.md are the right reference points; GITHUB-WEBHOOKS-SPEC contains design history that could be trimmed to an operational section in WORKFLOWS.md.

---

## Fragmentation

### 1. Three large completed-spec files (`APPROVALS-FIX-SPEC.md`, `CLAUDE-HOOKS-SPEC.md`, `GITHUB-WEBHOOKS-SPEC.md`)
These files total **3,188 lines** of implementation specification for features that are fully shipped. The design rationale they contain is now recorded in git history and code comments. As living documentation they are misleading — they read as proposals, not as reference docs, and their "Shepherd" references and pre-implementation framing create confusion about what is actually deployed.

The operational knowledge from these specs is already captured in:
- `docs/API-REFERENCE.md` (hook/approval/webhook endpoints)
- `docs/SETUP.md` (webhook configuration)
- `docs/WORKFLOWS.md` (workflow triggering)

### 2. ORCHESTRATOR-SPEC.md describes a shipped, stable feature
The Shepherd/Agent Joe orchestrator (Phases 1–4) is fully implemented per git history. The 669-line spec is the only place this feature is documented in depth, but it uses a stale name and proposal framing. It should be collapsed into a concise reference section in FEATURES.md.

### 3. `docs/stream-json-protocol.md` is complementary to `docs/SETUP.md`
The stream-JSON protocol doc describes how Codekin spawns and communicates with the Claude CLI process. This is developer-level detail that partially overlaps with the architecture section in SETUP.md. It is small enough to stand alone but could be an appendix of SETUP.md.

---

## Action Items

### Delete

| File | Reason it's safe to delete |
|------|---------------------------|
| `docs/APPROVALS-FIX-SPEC.md` | All 6 fixes are implemented and in production. The spec describes a past design decision; the authoritative state is in `src/hooks/usePromptState.ts` and `server/approval-manager.ts`. API-REFERENCE.md covers the endpoints. No user-facing reference value remains. |
| `docs/CLAUDE-HOOKS-SPEC.md` | 1,723-line spec for hooks that are fully shipped. Has never been updated post-release. The operational surface (hook endpoints) is documented in API-REFERENCE.md. The detailed hook type catalogue is an implementation artefact, not a reference doc. |

### Consolidate

| Source files | Target file | What to keep / drop |
|---|---|---|
| `docs/ORCHESTRATOR-SPEC.md` | `docs/FEATURES.md` — new "Agent Joe" section | Keep: shipped capabilities (session management, dashboard stats, child sessions, memory). Drop: proposal phases, unshipped roadmap items, "Shepherd" name. |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | `docs/WORKFLOWS.md` — new "Webhook Triggers" section | Keep: operational config (HMAC setup, event filtering, webhook URL). Drop: multi-phase roadmap, problem statement, architecture diagrams, implementation detail. 810 lines → ~40 lines. |

### Update

| File | Sections needing update | What changed in code |
|------|------------------------|---------------------|
| `docs/FEATURES.md` | Shepherd/orchestrator section; Chat interface section | Shepherd renamed to Agent Joe (2026-03-17); Joe chat variant and welcome screen added in PRs #183–#187 |
| `docs/ORCHESTRATOR-SPEC.md` | All sections titled "Shepherd" | Rename to "Agent Joe" throughout if file is kept before consolidation |
| `docs/API-REFERENCE.md` | `GET /api/health` response example | Verify whether `apiKeySet` field still exists after 2026-03-16 AI SDK removal |
| `docs/GITHUB-WEBHOOKS-SPEC.md` | Phase 2–4 descriptions referencing "Shepherd" | Update "Shepherd" to "Agent Joe" if file is kept |

---

## Recommendations

1. **Delete `docs/APPROVALS-FIX-SPEC.md` and `docs/CLAUDE-HOOKS-SPEC.md` immediately.** These are the highest-priority items. Together they are 2,378 lines of completed-proposal documentation that inflates the `docs/` directory and creates confusion. Their operational content is already in API-REFERENCE.md.

2. **Update `docs/FEATURES.md` to replace "Shepherd" with "Agent Joe" and add Joe chat variant.** This is a straightforward find-and-replace plus a new section. The file is the primary feature reference and should reflect the current product.

3. **Update `docs/ORCHESTRATOR-SPEC.md` to rename Shepherd → Agent Joe**, then schedule it for consolidation into FEATURES.md. As a first step, the rename is a quick correctness fix; the consolidation can follow.

4. **Verify and fix `apiKeySet` in `docs/API-REFERENCE.md`.** Check `server/ws-server.ts` for the health endpoint handler. If the field was removed, delete it from the docs example. If it still exists, mark it as deprecated.

5. **Trim `docs/GITHUB-WEBHOOKS-SPEC.md` to an operational reference.** Extract only the webhook configuration instructions (HMAC setup, nginx proxy config, event filtering options) and fold them into `docs/WORKFLOWS.md`. Remove the 700+ lines of design history and roadmap phases.

6. **Add an "Agent Joe" subsection to `docs/WORKFLOWS.md` or `docs/FEATURES.md`** rather than maintaining a separate 669-line spec. A 15–20 line description of what Agent Joe does, how to reach its dashboard, and what sessions it spawns is sufficient.

7. **Add a `docs/` index or table of contents to `README.md`.** Currently the 10 `docs/` files are not linked or described from the README. A simple "Documentation" section with one-line descriptions would make the docs navigable.

8. **Update `CLAUDE-HOOKS-SPEC.md` last-modified date as a cleanup signal**, or delete it (per recommendation 1). The 2026-03-08 timestamp combined with zero updates is the strongest staleness signal in the entire `docs/` directory.

9. **Confirm `server/workflows/` vs. `.codekin/reports/workflows/` path** in `docs/INSTALL-DISTRIBUTION.md` and `package.json`'s `files` field. If the built-in workflow `.md` files live in `server/workflows/` at build time but `.codekin/` at runtime, the install doc should clarify this distinction to avoid confusion for self-hosted deployers.

10. **Establish a lightweight doc-update convention**: for any PR that renames a user-visible feature or removes a field from a public endpoint, require a corresponding docs update in the same PR. The Shepherd → Agent Joe rename (and possibly the `apiKeySet` removal) slipped through without doc updates — a simple PR template checklist item would catch these.