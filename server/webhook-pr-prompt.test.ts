/** Tests for buildPrReviewPrompt — verifies PR context rendering and custom prompt resolution. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  }
})

import { buildPrReviewPrompt } from './webhook-pr-prompt.js'
import { existsSync, readFileSync } from 'fs'
import type { PullRequestContext } from './webhook-types.js'

function makeContext(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    repo: 'owner/repo',
    prNumber: 42,
    prTitle: 'Fix authentication bug',
    prBody: 'This PR fixes the login flow when using SSO.',
    prUrl: 'https://github.com/owner/repo/pull/42',
    author: 'octocat',
    headBranch: 'fix-auth',
    baseBranch: 'main',
    headSha: 'abc1234567890',
    baseSha: 'def5678901234',
    action: 'opened',
    changedFiles: 3,
    additions: 25,
    deletions: 10,
    diff: 'diff --git a/src/auth.ts\n+fixed line\n-broken line',
    fileList: 'src/auth.ts (modified, +20/-8)\nsrc/auth.test.ts (modified, +5/-2)',
    commitMessages: '- abc1234: fix: resolve auth bug',
    ...overrides,
  }
}

describe('buildPrReviewPrompt', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('full context produces all sections', () => {
    const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')

    expect(prompt).toContain('A pull request needs code review')
    expect(prompt).toContain('**Repository**: owner/repo')
    expect(prompt).toContain('**PR**: #42 — Fix authentication bug')
    expect(prompt).toContain('**Author**: octocat')
    expect(prompt).toContain('**Branch**: fix-auth → main')
    expect(prompt).toContain('3 files changed, +25/-10')
    expect(prompt).toContain('**Head**: abc1234')
    expect(prompt).toContain('## PR Description')
    expect(prompt).toContain('fixes the login flow')
    expect(prompt).toContain('## Changed Files')
    expect(prompt).toContain('src/auth.ts (modified, +20/-8)')
    expect(prompt).toContain('## Commits')
    expect(prompt).toContain('abc1234: fix: resolve auth bug')
    expect(prompt).toContain('## Diff')
    expect(prompt).toContain('+fixed line')
    expect(prompt).toContain('## Instructions')
  })

  it('opened action produces comprehensive review instructions', () => {
    const prompt = buildPrReviewPrompt(makeContext({ action: 'opened' }), '/tmp/workspace')
    expect(prompt).toContain('comprehensive code review')
  })

  it('reopened action mentions fresh review', () => {
    const prompt = buildPrReviewPrompt(makeContext({ action: 'reopened' }), '/tmp/workspace')
    expect(prompt).toContain('reopened')
    expect(prompt).toContain('fresh comprehensive code review')
  })

  it('synchronize action mentions previous head', () => {
    const prompt = buildPrReviewPrompt(
      makeContext({ action: 'synchronize', beforeSha: 'old1234567890' }),
      '/tmp/workspace',
    )
    expect(prompt).toContain('updated with new commits')
    expect(prompt).toContain('old1234')
    expect(prompt).toContain('abc1234')
  })

  it('synchronize without beforeSha falls back to comprehensive review', () => {
    const prompt = buildPrReviewPrompt(
      makeContext({ action: 'synchronize', beforeSha: undefined }),
      '/tmp/workspace',
    )
    expect(prompt).toContain('comprehensive code review')
  })

  it('missing PR body omits description section', () => {
    const prompt = buildPrReviewPrompt(makeContext({ prBody: '' }), '/tmp/workspace')
    expect(prompt).not.toContain('## PR Description')
  })

  it('empty diff shows "No diff available"', () => {
    const prompt = buildPrReviewPrompt(makeContext({ diff: '' }), '/tmp/workspace')
    expect(prompt).toContain('No diff available')
  })

  it('empty file list omits changed files section', () => {
    const prompt = buildPrReviewPrompt(makeContext({ fileList: '' }), '/tmp/workspace')
    expect(prompt).not.toContain('## Changed Files')
  })

  it('empty commit messages omits commits section', () => {
    const prompt = buildPrReviewPrompt(makeContext({ commitMessages: '' }), '/tmp/workspace')
    expect(prompt).not.toContain('## Commits')
  })

  it('always includes the no-GitHub-posting constraint', () => {
    const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
    expect(prompt).toContain('DO NOT post comments, reviews, or any content to GitHub')
  })

  describe('custom prompt resolution', () => {
    it('uses repo-level custom prompt when available', () => {
      vi.mocked(existsSync).mockImplementation((p) =>
        String(p).includes('/tmp/workspace/.codekin/pr-review-prompt.md'),
      )
      vi.mocked(readFileSync).mockReturnValue('Custom repo review instructions here')

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('Custom repo review instructions here')
      // Should NOT contain default instructions
      expect(prompt).not.toContain('comprehensive code review')
    })

    it('uses global custom prompt when repo-level not found', () => {
      vi.mocked(existsSync).mockImplementation((p) =>
        String(p).includes('.codekin/pr-review-prompt.md') && !String(p).includes('/tmp/workspace'),
      )
      vi.mocked(readFileSync).mockReturnValue('Global custom instructions')

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('Global custom instructions')
    })

    it('falls back to default when no custom prompt exists', () => {
      vi.mocked(existsSync).mockReturnValue(false)

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('comprehensive code review')
      expect(prompt).toContain('Code correctness')
    })

    it('repo-level takes precedence over global', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockImplementation((p) => {
        if (String(p).includes('/tmp/workspace')) return 'Repo prompt wins'
        return 'Global prompt loses'
      })

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('Repo prompt wins')
      expect(prompt).not.toContain('Global prompt loses')
    })

    it('no-GitHub constraint present even with custom prompt', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('Just my custom instructions')

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('DO NOT post comments, reviews, or any content to GitHub')
    })

    it('skips empty custom prompt file and falls back', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('   \n  ')

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      // Should fall back to default since file was whitespace-only
      expect(prompt).toContain('comprehensive code review')
    })
  })
})
