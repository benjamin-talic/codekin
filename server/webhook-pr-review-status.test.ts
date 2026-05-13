import { describe, expect, it, vi } from 'vitest'
import { buildAlreadyReviewedStatus, REVIEW_STATUS_IN_PROGRESS, ReviewStatusCommentService } from './webhook-pr-review-status.js'

describe('ReviewStatusCommentService', () => {
  it('marks review start with a transient progress message', async () => {
    const client = { upsert: vi.fn(async () => 123), delete: vi.fn(async () => undefined) }
    const service = new ReviewStatusCommentService(client)

    await service.markReviewStarted('owner/repo', 42)

    expect(client.upsert).toHaveBeenCalledWith({
      repo: 'owner/repo',
      prNumber: 42,
      body: REVIEW_STATUS_IN_PROGRESS,
    })
  })

  it('leaves an already-reviewed informational message', async () => {
    const client = { upsert: vi.fn(async () => 123), delete: vi.fn(async () => undefined) }
    const service = new ReviewStatusCommentService(client)

    await service.markAlreadyReviewed('owner/repo', 42, 'abc1234567890')

    expect(client.upsert).toHaveBeenCalledWith({
      repo: 'owner/repo',
      prNumber: 42,
      body: "I've already reviewed the latest changes on commit abc12345.",
    })
  })

  it('clears the transient comment', async () => {
    const client = { upsert: vi.fn(async () => 123), delete: vi.fn(async () => undefined) }
    const service = new ReviewStatusCommentService(client)

    await service.clear('owner/repo', 42)

    expect(client.delete).toHaveBeenCalledWith({ repo: 'owner/repo', prNumber: 42 })
  })
})

describe('buildAlreadyReviewedStatus', () => {
  it('uses a short SHA', () => {
    expect(buildAlreadyReviewedStatus('abc1234567890')).toBe("I've already reviewed the latest changes on commit abc12345.")
  })
})
