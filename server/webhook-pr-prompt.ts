/**
 * Builds the structured prompt sent to Claude for pull request code review.
 *
 * Supports a 3-tier custom prompt resolution for the review instructions:
 *   1. Repo-level: {workspacePath}/.codekin/pr-review-prompt.md
 *   2. Global:     ~/.codekin/pr-review-prompt.md
 *   3. Built-in default (hardcoded below)
 *
 * The PR metadata and diff context are always prepended — custom prompts
 * only replace the review instructions section.
 */

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PullRequestContext } from './webhook-types.js'
import type { PrCacheData } from './webhook-pr-cache.js'
import { REVIEW_COMMENT_MARKER } from './webhook-pr-github.js'

/** Options for prompt assembly — cache context and comment management. */
export interface PrPromptOptions {
  priorCache?: PrCacheData
  cachePath?: string
  existingCommentId?: number
}

const CUSTOM_PROMPT_FILENAME = 'pr-review-prompt.md'

/** Try to read a prompt file, returning its trimmed contents or undefined. */
function tryReadPrompt(filePath: string): string | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    const content = readFileSync(filePath, 'utf-8').trim()
    if (content) {
      console.log(`[pr-prompt] Using custom prompt: ${filePath}`)
      return content
    }
  } catch (err) {
    console.warn(`[pr-prompt] Failed to read prompt:`, err)
  }
  return undefined
}

/**
 * Attempt to load a custom review prompt from disk.
 *
 * Resolution order (first match wins):
 *   1. {repo}/.codekin/pr-review-prompt.{provider}.md  (repo-level, provider-specific)
 *   2. {repo}/.codekin/pr-review-prompt.md              (repo-level, generic)
 *   3. ~/.codekin/pr-review-prompt.{provider}.md        (global, provider-specific)
 *   4. ~/.codekin/pr-review-prompt.md                   (global, generic)
 *
 * @param provider - 'claude' or 'opencode'; when undefined, provider-specific files are skipped.
 */
function loadCustomPrompt(workspacePath: string, provider?: string): string | undefined {
  const repoDir = join(workspacePath, '.codekin')
  const globalDir = join(homedir(), '.codekin')

  // 1. Repo-level, provider-specific
  if (provider) {
    const result = tryReadPrompt(join(repoDir, `pr-review-prompt.${provider}.md`))
    if (result) return result
  }

  // 2. Repo-level, generic
  const repoGeneric = tryReadPrompt(join(repoDir, CUSTOM_PROMPT_FILENAME))
  if (repoGeneric) return repoGeneric

  // 3. Global, provider-specific
  if (provider) {
    const result = tryReadPrompt(join(globalDir, `pr-review-prompt.${provider}.md`))
    if (result) return result
  }

  // 4. Global, generic
  return tryReadPrompt(join(globalDir, CUSTOM_PROMPT_FILENAME))
}

/**
 * Build the default review instructions (used when no custom prompt is found).
 */
function buildDefaultInstructions(ctx: PullRequestContext): string {
  const lines: string[] = []

  if (ctx.action === 'synchronize' && ctx.beforeSha) {
    lines.push(`This PR has been updated with new commits. The previous head was \`${ctx.beforeSha.slice(0, 7)}\`, the new head is \`${ctx.headSha.slice(0, 7)}\`. Review the full PR diff but pay particular attention to changes since the previous head.`)
  } else if (ctx.action === 'reopened') {
    lines.push('This PR has been reopened. Provide a fresh comprehensive code review.')
  } else {
    lines.push('Provide a comprehensive code review of this pull request.')
  }

  lines.push('')
  lines.push('Focus on:')
  lines.push('1. Code correctness and logic errors')
  lines.push('2. Security vulnerabilities (injection, auth issues, data exposure)')
  lines.push('3. Performance implications')
  lines.push('4. Code style, readability, and maintainability')
  lines.push('5. Test coverage for new or changed code')
  lines.push('')
  lines.push('Produce a structured review report with:')
  lines.push('- **Summary**: 1-2 sentence overview of the PR')
  lines.push('- **Findings**: Grouped by severity (Critical / Warning / Suggestion / Nitpick)')
  lines.push('  - For each finding: file path, line number(s), description, and suggested fix')
  lines.push('- **Overall Assessment**: Approve / Request Changes / Comment')

  return lines.join('\n')
}

function formatReviewerDisplay(provider: 'claude' | 'opencode', model: string): string {
  return provider === 'opencode' ? `OpenCode (${model})` : `Claude (${model})`
}

/**
 * Builds the full prompt for PR review, combining PR context with review instructions.
 *
 * @param ctx           - Pull request context with metadata and diff.
 * @param workspacePath - Path to the cloned workspace (for repo-level prompt lookup).
 * @param options       - Optional cache context and comment management settings.
 */
export function buildPrReviewPrompt(ctx: PullRequestContext, workspacePath: string, options?: PrPromptOptions): string {
  const lines: string[] = []
  const reviewBodyPath = `${workspacePath}/pr-${ctx.prNumber}-review-body.md`
  const reviewerDisplay = (ctx.reviewProvider && ctx.reviewModel)
    ? formatReviewerDisplay(ctx.reviewProvider, ctx.reviewModel)
    : undefined

  // --- PR metadata (always included) ---
  lines.push('A pull request needs code review.')
  lines.push('')
  lines.push('## PR Details')
  lines.push(`- **Repository**: ${ctx.repo}`)
  lines.push(`- **PR**: #${ctx.prNumber} — ${ctx.prTitle}`)
  lines.push(`- **Author**: ${ctx.author}`)
  lines.push(`- **Branch**: ${ctx.headBranch} → ${ctx.baseBranch}`)
  lines.push(`- **Stats**: ${ctx.changedFiles} files changed, +${ctx.additions}/-${ctx.deletions}`)

  const shortHead = ctx.headSha.slice(0, 7)
  lines.push(`- **Head**: ${shortHead}`)
  if (reviewerDisplay) {
    lines.push(`- **Reviewer**: ${reviewerDisplay}`)
  }

  if (ctx.prUrl) {
    lines.push(`- **URL**: ${ctx.prUrl}`)
  }

  // PR description
  if (ctx.prBody) {
    lines.push('')
    lines.push('## PR Description')
    lines.push(ctx.prBody)
  }

  // Changed files
  if (ctx.fileList) {
    lines.push('')
    lines.push('## Changed Files')
    lines.push(ctx.fileList)
  }

  // Commit messages
  if (ctx.commitMessages) {
    lines.push('')
    lines.push('## Commits')
    lines.push(ctx.commitMessages)
  }

  // Existing review comments
  if (ctx.reviews || ctx.reviewComments) {
    lines.push('')
    lines.push('## Existing Reviews')
    if (ctx.reviews) {
      lines.push('### Review Summaries')
      lines.push(ctx.reviews)
    }
    if (ctx.reviewComments) {
      lines.push('### Inline Comments')
      lines.push(ctx.reviewComments)
    }
  }

  // Prior review context (from cache)
  if (options?.priorCache) {
    const cache = options.priorCache
    lines.push('')
    lines.push('## Prior Review Context')
    lines.push(`(from review at commit ${cache.lastReviewedSha} on ${cache.timestamp})`)
    lines.push('')
    lines.push('### Codebase Familiarity')
    lines.push(cache.codebaseContext)
    lines.push('')
    lines.push('### Previous Review Findings')
    lines.push(cache.reviewFindings)
    lines.push('')
    lines.push('### Previous Review Summary')
    lines.push(cache.priorReviewSummary)
    lines.push('')
    lines.push('Note: The above is from a previous review. The diff and comments below are fresh. Review the full current diff but leverage your prior context for faster, more informed review.')
  }

  // Diff
  lines.push('')
  lines.push('## Diff')
  if (ctx.diff) {
    lines.push('```diff')
    lines.push(ctx.diff)
    lines.push('```')
  } else {
    lines.push('No diff available.')
  }

  // --- Review instructions (custom or default) ---
  lines.push('')
  lines.push('## Instructions')

  const customPrompt = loadCustomPrompt(workspacePath, ctx.reviewProvider)
  if (customPrompt) {
    lines.push(customPrompt)
  } else {
    lines.push(buildDefaultInstructions(ctx))
  }

  // Override any hardcoded intermediate review file paths from custom prompts
  // so concurrent reviews don't collide or write into tracked repo files.
  // Only include Codex paths for Claude — OpenCode doesn't use Codex cross-review.
  lines.push('')
  lines.push('## File Paths for This Review')
  if (ctx.reviewProvider === 'opencode') {
    lines.push('Do NOT write intermediate draft files. Write the review body directly to the file specified in "Posting Your Review Summary" below.')
    lines.push('Do NOT write review files to the `docs/` directory or any other git-tracked location.')
  } else {
    lines.push('When writing intermediate files during the review process, use these paths:')
    lines.push(`- Draft review: \`${workspacePath}/pr-${ctx.prNumber}-draft-review.md\``)
    lines.push(`- Codex cross-review output: \`${workspacePath}/pr-${ctx.prNumber}-codex-review.md\``)
    lines.push(`- Codex command: \`codex exec - --skip-git-repo-check -o ${workspacePath}/pr-${ctx.prNumber}-codex-review.md < ${workspacePath}/pr-${ctx.prNumber}-draft-review.md\``)
    lines.push('These paths override any file paths mentioned in the review instructions above.')
    lines.push('Do NOT write review files to the `docs/` directory or any other git-tracked location.')
  }

  // --- Sandbox tool rules (always injected, tied to actual runtime permissions) ---
  // These override anything in the custom prompt. They reflect the real sandbox
  // enforced by code (Claude allowedTools or OpenCode opencode.json), so keeping
  // them in the injected prompt ensures they never drift out of sync.
  lines.push('')
  lines.push('## Sandbox Tool Rules (enforced)')
  if (ctx.reviewProvider === 'opencode') {
    lines.push('Your session runs inside an OpenCode sandbox with scoped permissions. The following rules are enforced by `opencode.json` in the workspace:')
    lines.push('')
    lines.push('**Use built-in tools for file operations — NOT bash equivalents:**')
    lines.push('- Use the **read** tool to read files (not `cat`, `head`, `tail`)')
    lines.push('- Use the **grep** tool to search file contents (not bash `grep`, `rg`, `awk`)')
    lines.push('- Use the **edit** or **write** tool to create/modify files (not `echo >` or heredocs)')
    lines.push('')
    lines.push('Built-in tools are pre-authorized and path-scoped to the workspace. Bash `grep`/`rg`/`find`/`sed`/`awk` are DENIED and will fail.')
    lines.push('')
    lines.push('**Bash is restricted to:** `git` subcommands (`status`, `diff`, `log`, `show`, `blame`), `gh` subcommands for PR interaction, and a small set of read-only helpers (`cat`, `ls`, `head`, `tail`, `wc`, `mkdir`, `echo`).')
    lines.push('')
    lines.push('**Stay within the workspace.** Access to files outside the cloned repo is blocked by `external_directory: deny`. The only exception is the PR cache directory, which is allow-listed.')
  } else {
    // Claude
    lines.push('Your session runs with Claude `--allowedTools` restricting which tools are available.')
    lines.push('')
    lines.push('**Use built-in tools for codebase exploration — NOT bash equivalents:**')
    lines.push('- Use **Read** to read files (not `cat`, `head`, `tail`)')
    lines.push('- Use **Grep** to search file contents (not bash `grep`, `rg`, `awk`)')
    lines.push('- Use **Glob** to find files by pattern (not `find`, `ls`)')
    lines.push('')
    lines.push('These tools are pre-approved and work without permission prompts. Bash commands for file reading will be blocked.')
    lines.push('')
    lines.push('**Only use Bash for:** `git` commands and `gh` commands.')
    lines.push('')
    lines.push('**Stay within the workspace directory.** Do not access files outside the cloned repo.')
  }

  // --- Comment posting instructions ---
  lines.push('')
  if (options?.existingCommentId) {
    lines.push('## Posting Your Review Summary')
    lines.push(`An existing Codekin review comment was found on this PR (comment ID: ${options.existingCommentId}).`)
    lines.push('**Update it** instead of creating a new comment. This comment is the SINGLE source of truth for review findings — put ALL detailed findings here.')
    lines.push('')
    lines.push(`1. Write your full review to \`${reviewBodyPath}\``)
    lines.push(`2. Ensure the file starts with \`${REVIEW_COMMENT_MARKER}\` on its own line`)
    lines.push(`3. Run: \`gh api repos/${ctx.repo}/issues/comments/${options.existingCommentId} -X PATCH -F body=@${reviewBodyPath}\``)
    if (reviewerDisplay) {
      lines.push(`4. Include this footer at the end of the review body: \`*Reviewed by ${reviewerDisplay}*\``)
    }
    lines.push('')
    lines.push(`IMPORTANT: Always include \`${REVIEW_COMMENT_MARKER}\` at the very beginning of the comment body.`)
    lines.push('')
    lines.push('**Do NOT duplicate the full review in the `gh pr review` verdict.** The verdict body should be one sentence only (e.g., "Approved — see Codekin review comment for details."). Verdict reviews stack up and cannot be updated.')
  } else {
    lines.push('## Posting Your Review Summary')
    lines.push('Post your review summary as a **new comment** on the PR. This comment is the SINGLE source of truth for review findings — put ALL detailed findings here.')
    lines.push('')
    lines.push(`1. Write your full review to \`${reviewBodyPath}\``)
    lines.push(`2. Ensure the file starts with \`${REVIEW_COMMENT_MARKER}\` on its own line`)
    lines.push(`3. Run: \`gh api repos/${ctx.repo}/issues/${ctx.prNumber}/comments -F body=@${reviewBodyPath}\``)
    if (reviewerDisplay) {
      lines.push(`4. Include this footer at the end of the review body: \`*Reviewed by ${reviewerDisplay}*\``)
    }
    lines.push('')
    lines.push(`IMPORTANT: Always include \`${REVIEW_COMMENT_MARKER}\` at the very beginning of the comment body. This marker allows future reviews to update this comment instead of creating a new one.`)
    lines.push('')
    lines.push('**Do NOT duplicate the full review in the `gh pr review` verdict.** The verdict body should be one sentence only (e.g., "Approved — see Codekin review comment for details."). Verdict reviews stack up and cannot be updated.')
  }

  // --- Cache-writing instructions ---
  if (options?.cachePath) {
    lines.push('')
    lines.push('## Post-Review: Save Context')
    lines.push('After completing your review, write a JSON file to preserve your context for future reviews of this PR.')
    lines.push('')
    lines.push(`Path: ${options.cachePath}`)
    lines.push('')
    lines.push('The file must be valid JSON with this exact structure:')
    lines.push('```json')
    lines.push('{')
    lines.push(`  "prNumber": ${ctx.prNumber},`)
    lines.push(`  "repo": "${ctx.repo}",`)
    lines.push(`  "lastReviewedSha": "${ctx.headSha}",`)
    lines.push('  "timestamp": "<current ISO timestamp>",')
    lines.push('  "priorReviewSummary": "<1-3 sentence summary of your review findings>",')
    lines.push('  "codebaseContext": "<key architectural observations, module structure, patterns you noticed>",')
    lines.push('  "reviewFindings": "<specific issues found, their locations, and whether they were fixed>",')
    lines.push('  "verdict": "<approve | request_changes | comment>",')
    lines.push('  "structuredFindings": [')
    lines.push('    {')
    lines.push('      "severity": "<critical | must-fix | suggestion | minor | nitpick>",')
    lines.push('      "file": "<path/to/file.ts>",')
    lines.push('      "line": <line number or null>,')
    lines.push('      "description": "<short description of the finding>",')
    lines.push('      "status": "<new | open | fixed>"')
    lines.push('    }')
    lines.push('  ],')
    lines.push(`  "author": ${JSON.stringify(ctx.author)},`)
    lines.push(`  "prTitle": ${JSON.stringify(ctx.prTitle)},`)
    lines.push(`  "changedFiles": ${ctx.changedFiles},`)
    lines.push(`  "additions": ${ctx.additions},`)
    lines.push(`  "deletions": ${ctx.deletions}`)
    lines.push('}')
    lines.push('```')
    lines.push('')
    lines.push('IMPORTANT: The `structuredFindings` array must include every finding from your review.')
    lines.push('Use an empty array `[]` if there are no findings. The `verdict` must be exactly one of: approve, request_changes, comment.')
    lines.push('')
    if (ctx.reviewProvider === 'opencode') {
      lines.push('Save this file using bash: `cat > ' + options.cachePath + ' << \'CACHE_EOF\'` followed by the JSON content and `CACHE_EOF`. This helps future reviews of this PR be more efficient.')
    } else {
      lines.push('Use the Write tool to save this file. This helps future reviews of this PR be more efficient.')
    }
  }

  return lines.join('\n')
}
