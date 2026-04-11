/**
 * GitHub API helpers for pull request webhook processing.
 *
 * All functions delegate to the `gh` CLI and degrade gracefully — errors are
 * logged as warnings and an empty result is returned so callers can proceed
 * with partial data.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const GH_TIMEOUT_MS = 30_000

/** Maximum diff size in bytes before truncation (~100KB). */
const MAX_DIFF_BYTES = 100_000

type GhRunner = (args: string[]) => Promise<string>

let ghRunner: GhRunner = async (args) => {
  const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
  return stdout
}

/** @internal Test-only: override the gh CLI runner */
export function _setGhRunner(runner: GhRunner): void {
  ghRunner = runner
}

/** @internal Test-only: reset to default gh CLI runner */
export function _resetGhRunner(): void {
  ghRunner = async (args) => {
    const { stdout } = await execFileAsync('gh', args, { timeout: GH_TIMEOUT_MS })
    return stdout
  }
}

/**
 * Fetch the unified diff for a pull request.
 * Truncates to ~100KB with a note if larger.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns The diff text, or empty string on error.
 */
export async function fetchPrDiff(repo: string, prNumber: number): Promise<{ diff: string; truncated: boolean }> {
  try {
    const output = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}`,
      '-H', 'Accept: application/vnd.github.diff',
    ])

    if (output.length > MAX_DIFF_BYTES) {
      const truncated = output.slice(0, MAX_DIFF_BYTES)
      // Cut at last newline to avoid splitting a line
      const lastNewline = truncated.lastIndexOf('\n')
      return {
        diff: (lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated) +
          `\n\n... (diff truncated — full diff is ${Math.round(output.length / 1024)}KB, showing first ~${Math.round(MAX_DIFF_BYTES / 1024)}KB)`,
        truncated: true,
      }
    }

    return { diff: output, truncated: false }
  } catch (err) {
    console.warn(`fetchPrDiff: failed for ${repo} PR #${prNumber}:`, err)
    return { diff: '', truncated: false }
  }
}

/**
 * Fetch the list of changed files for a pull request with stats.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted file list, or empty string on error.
 */
export async function fetchPrFiles(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/files`,
      '--paginate',
    ])
    const files = JSON.parse(raw) as Array<{
      filename: string
      status: string
      additions: number
      deletions: number
    }>

    if (!Array.isArray(files) || files.length === 0) return ''

    return files
      .map(f => `${f.filename} (${f.status}, +${f.additions}/-${f.deletions})`)
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrFiles: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}

/**
 * Fetch commit messages for a pull request.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted commit list, or empty string on error.
 */
/**
 * Fetch existing review comments (inline code comments) for a pull request.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted comment list, or empty string on error.
 */
export async function fetchPrReviewComments(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/comments`,
      '--paginate',
    ])
    const comments = JSON.parse(raw) as Array<{
      path: string
      line: number | null
      body: string
      user: { login: string }
    }>

    if (!Array.isArray(comments) || comments.length === 0) return ''

    return comments
      .map(c => {
        const location = c.line ? `${c.path}:${c.line}` : c.path
        return `- ${c.user.login} on ${location}: ${c.body}`
      })
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrReviewComments: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}

/**
 * Fetch review summaries (approve/request changes/comment) for a pull request.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns Formatted review list, or empty string on error.
 */
export async function fetchPrReviews(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/reviews`,
      '--paginate',
    ])
    const reviews = JSON.parse(raw) as Array<{
      state: string
      body: string | null
      user: { login: string }
    }>

    if (!Array.isArray(reviews) || reviews.length === 0) return ''

    return reviews
      .filter(r => r.state !== 'PENDING')
      .map(r => `- ${r.user.login} (${r.state}): ${r.body || '(no summary)'}`)
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrReviews: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}

/** HTML marker embedded in Codekin review comments for identification. */
export const REVIEW_COMMENT_MARKER = '<!-- codekin-review -->'

/**
 * Find an existing Codekin review summary comment on a PR.
 * Searches issue comments (top-level conversation comments) for the marker.
 *
 * @param repo     - GitHub repo in `owner/name` format.
 * @param prNumber - Pull request number.
 * @returns The comment ID if found, or undefined.
 */
export async function fetchExistingReviewComment(repo: string, prNumber: number): Promise<number | undefined> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/issues/${prNumber}/comments`,
      '--paginate',
    ])
    const comments = JSON.parse(raw) as Array<{
      id: number
      body: string
    }>

    if (!Array.isArray(comments) || comments.length === 0) return undefined

    // Search in reverse to find the most recent matching comment
    for (let i = comments.length - 1; i >= 0; i--) {
      if (comments[i].body.includes(REVIEW_COMMENT_MARKER)) {
        return comments[i].id
      }
    }
    return undefined
  } catch (err) {
    console.warn(`fetchExistingReviewComment: failed for ${repo} PR #${prNumber}:`, err)
    return undefined
  }
}

/**
 * Check whether a pull request is still open on GitHub.
 * Used by the backlog retry worker to skip entries whose PRs have been
 * closed or merged while they were waiting.
 *
 * Returns `'open'` / `'closed'` / `undefined` on any failure (treat
 * undefined as "don't know — retry next tick").
 */
export async function fetchPrState(repo: string, prNumber: number): Promise<'open' | 'closed' | undefined> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}`,
      '--jq', '.state',
    ])
    const state = raw.trim()
    if (state === 'open' || state === 'closed') return state
    return undefined
  } catch (err) {
    console.warn(`fetchPrState: failed for ${repo} PR #${prNumber}:`, err)
    return undefined
  }
}

/**
 * Post or update the Codekin review comment on a PR with a "provider
 * unavailable" status message. Used when a review session fails due to
 * rate limits or auth failures — the comment tells the PR author that
 * a retry is scheduled.
 *
 * If an existing `<!-- codekin-review -->` comment exists it gets PATCHed;
 * otherwise a new one is created. Failures are logged but don't throw —
 * the backlog + health state are the source of truth for retries, the
 * comment is just user-facing signal.
 */
export async function postProviderUnavailableComment(params: {
  repo: string
  prNumber: number
  reason: 'rate_limit' | 'auth_failure'
  providerDisplay: string           // e.g. 'Claude (sonnet)'
  errorText: string                 // truncated before passing in
  retryAfter: string                // ISO timestamp
}): Promise<void> {
  const body = buildProviderUnavailableBody(params)

  try {
    const existingId = await fetchExistingReviewComment(params.repo, params.prNumber)

    if (existingId) {
      // Update existing marker comment via PATCH.
      await ghRunner([
        'api',
        `/repos/${params.repo}/issues/comments/${existingId}`,
        '-X', 'PATCH',
        '-f', `body=${body}`,
      ])
    } else {
      // Create a new marker comment.
      await ghRunner([
        'api',
        `/repos/${params.repo}/issues/${params.prNumber}/comments`,
        '-f', `body=${body}`,
      ])
    }
  } catch (err) {
    console.warn(`postProviderUnavailableComment: failed for ${params.repo} PR #${params.prNumber}:`, err)
  }
}

/** Internal: render the comment body for a provider-unavailable notice. */
function buildProviderUnavailableBody(params: {
  reason: 'rate_limit' | 'auth_failure'
  providerDisplay: string
  errorText: string
  retryAfter: string
}): string {
  const { reason, providerDisplay, errorText, retryAfter } = params
  const title = reason === 'rate_limit'
    ? '## ⏳ Codekin review deferred — usage limit reached'
    : '## 🔑 Codekin review deferred — provider auth failed'

  const reasonLine = reason === 'rate_limit'
    ? '**Reason:** Rate limit / usage limit hit'
    : '**Reason:** Authentication failure (invalid / expired credentials)'

  const guidance = reason === 'rate_limit'
    ? 'Codekin will automatically retry this review once the provider recovers. The PR needs to remain open for the retry to happen.'
    : 'Codekin will keep retrying hourly until this PR closes. Check provider credentials on the codekin server if this persists.'

  return [
    REVIEW_COMMENT_MARKER,
    title,
    '',
    `**Provider:** ${providerDisplay}`,
    reasonLine,
    `**Next retry:** \`${retryAfter}\``,
    '',
    guidance,
    '',
    `*Error detail (for operator):* \`${sanitizeForMarkdown(errorText)}\``,
  ].join('\n')
}

/** Strip backticks + truncate so the error text is safe to inline in a markdown code span. */
function sanitizeForMarkdown(text: string): string {
  const stripped = text.replace(/`/g, "'")
  return stripped.length > 300 ? stripped.slice(0, 300) + '…' : stripped
}

export async function fetchPrCommits(repo: string, prNumber: number): Promise<string> {
  try {
    const raw = await ghRunner([
      'api',
      `/repos/${repo}/pulls/${prNumber}/commits`,
      '--paginate',
    ])
    const commits = JSON.parse(raw) as Array<{
      sha: string
      commit: { message: string }
    }>

    if (!Array.isArray(commits) || commits.length === 0) return ''

    return commits
      .map(c => `- ${c.sha.slice(0, 7)}: ${c.commit.message.split('\n')[0]}`)
      .join('\n')
  } catch (err) {
    console.warn(`fetchPrCommits: failed for ${repo} PR #${prNumber}:`, err)
    return ''
  }
}
