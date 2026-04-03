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

const CUSTOM_PROMPT_FILENAME = 'pr-review-prompt.md'

/**
 * Attempt to load a custom review prompt from disk.
 * Returns the file contents if found, or undefined.
 */
function loadCustomPrompt(workspacePath: string): string | undefined {
  // 1. Repo-level
  const repoPromptPath = join(workspacePath, '.codekin', CUSTOM_PROMPT_FILENAME)
  if (existsSync(repoPromptPath)) {
    try {
      const content = readFileSync(repoPromptPath, 'utf-8').trim()
      if (content) {
        console.log(`[pr-prompt] Using repo-level custom prompt: ${repoPromptPath}`)
        return content
      }
    } catch (err) {
      console.warn(`[pr-prompt] Failed to read repo-level prompt:`, err)
    }
  }

  // 2. Global
  const globalPromptPath = join(homedir(), '.codekin', CUSTOM_PROMPT_FILENAME)
  if (existsSync(globalPromptPath)) {
    try {
      const content = readFileSync(globalPromptPath, 'utf-8').trim()
      if (content) {
        console.log(`[pr-prompt] Using global custom prompt: ${globalPromptPath}`)
        return content
      }
    } catch (err) {
      console.warn(`[pr-prompt] Failed to read global prompt:`, err)
    }
  }

  return undefined
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

/**
 * Builds the full prompt for PR review, combining PR context with review instructions.
 *
 * @param ctx           - Pull request context with metadata and diff.
 * @param workspacePath - Path to the cloned workspace (for repo-level prompt lookup).
 */
export function buildPrReviewPrompt(ctx: PullRequestContext, workspacePath: string): string {
  const lines: string[] = []

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

  const customPrompt = loadCustomPrompt(workspacePath)
  if (customPrompt) {
    lines.push(customPrompt)
  } else {
    lines.push(buildDefaultInstructions(ctx))
  }

  // Always append the Phase 1 constraint
  lines.push('')
  lines.push('**IMPORTANT: DO NOT post comments, reviews, or any content to GitHub. Produce the review report here only.**')

  return lines.join('\n')
}
