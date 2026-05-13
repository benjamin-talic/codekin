import type { PullRequestPayload } from './webhook-types.js'
import type { PrCacheData } from './webhook-pr-cache.js'

export const PR_REVIEW_ACTIONS = ['opened', 'reopened', 'ready_for_review', 'review_requested'] as const
export type PrReviewAction = typeof PR_REVIEW_ACTIONS[number]

export interface ReviewRequestActor {
  login: string
}

export type ReviewPolicyDecision =
  | { kind: 'ignore'; reason: string }
  | { kind: 'already_reviewed'; reason: string }
  | { kind: 'start_review'; requestedBy?: string }
  | { kind: 'reuse_in_flight'; requestedBy?: string }

export interface ReviewPolicyInput {
  payload: PullRequestPayload
  agentLogin?: string
  priorCache?: PrCacheData | null
  inFlightForSha?: boolean
}

export function isPrReviewAction(action: string): action is PrReviewAction {
  return (PR_REVIEW_ACTIONS as readonly string[]).includes(action)
}

export function getRequestedReviewerLogin(payload: PullRequestPayload): string | undefined {
  return payload.requested_reviewer?.login
}

export function decidePrReview(input: ReviewPolicyInput): ReviewPolicyDecision {
  const { payload, agentLogin, priorCache, inFlightForSha } = input
  const action = payload.action
  const headSha = payload.pull_request.head?.sha ?? ''

  if (!isPrReviewAction(action)) {
    return { kind: 'ignore', reason: `PR action '${action}' not supported (only ${PR_REVIEW_ACTIONS.join(', ')})` }
  }

  if (action === 'review_requested') {
    if (payload.requested_team) {
      return { kind: 'ignore', reason: 'Team review request — skipping Codekin review' }
    }

    const requestedReviewer = getRequestedReviewerLogin(payload)
    if (!requestedReviewer) {
      return { kind: 'ignore', reason: 'Review request has no requested_reviewer user' }
    }

    if (!agentLogin) {
      return { kind: 'ignore', reason: 'Unable to determine authenticated gh user for review request routing' }
    }

    if (requestedReviewer.toLowerCase() !== agentLogin.toLowerCase()) {
      return { kind: 'ignore', reason: `Review requested from '${requestedReviewer}', not authenticated Codekin user '${agentLogin}'` }
    }

    const requestedBy = payload.sender?.login
    if (inFlightForSha) return { kind: 'reuse_in_flight', requestedBy }
    if (priorCache?.lastReviewedSha === headSha) {
      return { kind: 'already_reviewed', reason: `Already reviewed at SHA ${headSha.slice(0, 8)}` }
    }
    return { kind: 'start_review', requestedBy }
  }

  if ((action === 'reopened' || action === 'ready_for_review') && priorCache?.lastReviewedSha === headSha) {
    return { kind: 'ignore', reason: `Already reviewed at SHA ${headSha.slice(0, 8)} (action=${action}, no code change)` }
  }

  if (inFlightForSha) return { kind: 'reuse_in_flight' }
  return { kind: 'start_review' }
}
