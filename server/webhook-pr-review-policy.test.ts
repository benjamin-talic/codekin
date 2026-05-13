import { describe, expect, it } from 'vitest'
import { decidePrReview, PR_REVIEW_ACTIONS } from './webhook-pr-review-policy.js'
import type { PullRequestPayload } from './webhook-types.js'
import type { PrCacheData } from './webhook-pr-cache.js'

function payload(overrides: Partial<PullRequestPayload> = {}): PullRequestPayload {
  return {
    action: 'opened',
    number: 42,
    pull_request: {
      number: 42,
      title: 'Test PR',
      body: null,
      state: 'open',
      draft: false,
      merged: false,
      user: { login: 'author' },
      head: { ref: 'feature', sha: 'abc1234567890', repo: { clone_url: 'https://github.com/owner/repo.git' } },
      base: { ref: 'main', sha: 'def1234567890' },
      html_url: 'https://github.com/owner/repo/pull/42',
      changed_files: 1,
      additions: 2,
      deletions: 3,
    },
    repository: { full_name: 'owner/repo', name: 'repo', clone_url: 'https://github.com/owner/repo.git' },
    sender: { login: 'reviewer1' },
    ...overrides,
  }
}

const cache: PrCacheData = {
  prNumber: 42,
  repo: 'owner/repo',
  lastReviewedSha: 'abc1234567890',
  timestamp: '2026-05-13T00:00:00.000Z',
  priorReviewSummary: 'Reviewed',
  codebaseContext: 'Context',
  reviewFindings: 'None',
}

describe('decidePrReview', () => {
  it('accepts the intended pull_request actions', () => {
    expect(PR_REVIEW_ACTIONS).toEqual(['opened', 'reopened', 'ready_for_review', 'review_requested'])
  })

  it('ignores synchronize events', () => {
    expect(decidePrReview({ payload: payload({ action: 'synchronize' }) }).kind).toBe('ignore')
  })

  it('starts automatic review for opened PRs', () => {
    expect(decidePrReview({ payload: payload({ action: 'opened' }) }).kind).toBe('start_review')
  })

  it('ignores reopened unchanged SHAs that were already reviewed', () => {
    const decision = decidePrReview({ payload: payload({ action: 'reopened' }), priorCache: cache })
    expect(decision.kind).toBe('ignore')
    expect(decision.reason).toContain('Already reviewed')
  })

  it('answers explicit review requests for an already reviewed SHA', () => {
    const decision = decidePrReview({
      payload: payload({ action: 'review_requested', requested_reviewer: { login: 'codekin-bot' } }),
      agentLogin: 'codekin-bot',
      priorCache: cache,
    })
    expect(decision.kind).toBe('already_reviewed')
  })

  it('accepts explicit review requests targeted at the authenticated gh user', () => {
    const decision = decidePrReview({
      payload: payload({ action: 'review_requested', requested_reviewer: { login: 'codekin-bot' } }),
      agentLogin: 'codekin-bot',
    })
    expect(decision).toEqual({ kind: 'start_review', requestedBy: 'reviewer1' })
  })

  it('ignores team review requests', () => {
    const decision = decidePrReview({
      payload: payload({ action: 'review_requested', requested_team: { slug: 'maintainers' } }),
      agentLogin: 'codekin-bot',
    })
    expect(decision.kind).toBe('ignore')
    expect(decision.reason).toContain('Team review request')
  })

  it('ignores explicit requests for another user', () => {
    const decision = decidePrReview({
      payload: payload({ action: 'review_requested', requested_reviewer: { login: 'someone-else' } }),
      agentLogin: 'codekin-bot',
    })
    expect(decision.kind).toBe('ignore')
    expect(decision.reason).toContain('not authenticated Codekin user')
  })

  it('reuses an in-flight review for the same SHA', () => {
    const decision = decidePrReview({
      payload: payload({ action: 'review_requested', requested_reviewer: { login: 'codekin-bot' } }),
      agentLogin: 'codekin-bot',
      inFlightForSha: true,
    })
    expect(decision).toEqual({ kind: 'reuse_in_flight', requestedBy: 'reviewer1' })
  })
})
