import {
  deleteTransientReviewStatusComment,
  upsertTransientReviewStatusComment,
} from './webhook-pr-github.js'

export const REVIEW_STATUS_IN_PROGRESS = 'Reviewing. Hang tight'

export function buildAlreadyReviewedStatus(headSha: string): string {
  return `I've already reviewed the latest changes on commit ${headSha.slice(0, 8)}.`
}

export interface ReviewStatusCommentClient {
  upsert(params: { repo: string; prNumber: number; body: string }): Promise<number | undefined>
  delete(params: { repo: string; prNumber: number }): Promise<void>
}

export const githubReviewStatusCommentClient: ReviewStatusCommentClient = {
  upsert: upsertTransientReviewStatusComment,
  delete: deleteTransientReviewStatusComment,
}

export class ReviewStatusCommentService {
  constructor(private readonly client: ReviewStatusCommentClient = githubReviewStatusCommentClient) {}

  markReviewStarted(repo: string, prNumber: number): Promise<number | undefined> {
    return this.client.upsert({ repo, prNumber, body: REVIEW_STATUS_IN_PROGRESS })
  }

  markAlreadyReviewed(repo: string, prNumber: number, headSha: string): Promise<number | undefined> {
    return this.client.upsert({ repo, prNumber, body: buildAlreadyReviewedStatus(headSha) })
  }

  clear(repo: string, prNumber: number): Promise<void> {
    return this.client.delete({ repo, prNumber })
  }
}
