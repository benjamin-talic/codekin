/** Tests for BacklogManager — verifies enqueue, getReady, remove, bumpRetry,
 *  persistence round-trip, and corrupt-file recovery; mocks fs. */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn(() => '{"entries":[]}'),
  }
})

import { BacklogManager, DEFAULT_RETRY_DELAY_MS } from './webhook-backlog.js'
import { existsSync, writeFileSync, readFileSync } from 'fs'
import type { PullRequestPayload } from './webhook-types.js'

function samplePayload(): PullRequestPayload {
  return {
    action: 'synchronize',
    number: 42,
    pull_request: {
      number: 42,
      title: 'Test PR',
      body: null,
      state: 'open',
      draft: false,
      merged: false,
      user: { login: 'user1' },
      head: {
        ref: 'feature/x',
        sha: 'abc123',
        repo: { clone_url: 'https://github.com/owner/repo.git' },
      },
      base: { ref: 'main', sha: 'def456' },
      html_url: 'https://github.com/owner/repo/pull/42',
      changed_files: 1,
      additions: 10,
      deletions: 5,
    },
    repository: {
      full_name: 'owner/repo',
      name: 'repo',
      clone_url: 'https://github.com/owner/repo.git',
    },
    sender: { login: 'user1' },
  }
}

describe('BacklogManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readFileSync).mockReturnValue('{"entries":[]}')
  })

  describe('constructor', () => {
    it('starts empty when no file exists', () => {
      const mgr = new BacklogManager()
      expect(mgr.size()).toBe(0)
      expect(mgr.all()).toEqual([])
    })

    it('loads entries from disk', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        entries: [{
          id: 'abc',
          repo: 'owner/repo',
          prNumber: 42,
          headSha: 'abc123',
          payload: samplePayload(),
          reason: 'rate_limit',
          failedProvider: 'claude',
          queuedAt: '2026-04-12T10:00:00.000Z',
          retryAfter: '2026-04-12T11:00:00.000Z',
          retryCount: 0,
        }],
      }))

      const mgr = new BacklogManager()
      expect(mgr.size()).toBe(1)
      expect(mgr.all()[0].id).toBe('abc')
    })

    it('drops malformed entries at load time', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        entries: [
          {
            id: 'good',
            repo: 'owner/repo',
            prNumber: 42,
            headSha: 'abc',
            payload: samplePayload(),
            reason: 'rate_limit',
            failedProvider: 'claude',
            queuedAt: '2026-04-12T10:00:00.000Z',
            retryAfter: '2026-04-12T11:00:00.000Z',
            retryCount: 0,
          },
          { id: 'bad', reason: 'not_a_real_reason' },  // malformed
          null,
          'string not object',
        ],
      }))

      const mgr = new BacklogManager()
      expect(mgr.size()).toBe(1)
      expect(mgr.all()[0].id).toBe('good')
    })

    it('handles corrupt JSON by starting empty', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('not valid{{{')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const mgr = new BacklogManager()
      expect(mgr.size()).toBe(0)
      expect(warn).toHaveBeenCalled()

      warn.mockRestore()
    })
  })

  describe('enqueue', () => {
    it('adds an entry and writes to disk', () => {
      const mgr = new BacklogManager()
      vi.mocked(writeFileSync).mockClear()

      const now = new Date('2026-04-12T10:00:00.000Z')
      const entry = mgr.enqueue({
        repo: 'owner/repo',
        prNumber: 42,
        headSha: 'abc123',
        payload: samplePayload(),
        reason: 'rate_limit',
        failedProvider: 'claude',
        now,
      })

      expect(mgr.size()).toBe(1)
      expect(entry.id).toBeDefined()
      expect(entry.repo).toBe('owner/repo')
      expect(entry.prNumber).toBe(42)
      expect(entry.retryCount).toBe(0)
      expect(entry.queuedAt).toBe('2026-04-12T10:00:00.000Z')
      expect(entry.retryAfter).toBe('2026-04-12T11:00:00.000Z')
      expect(writeFileSync).toHaveBeenCalled()
    })

    it('generates a unique id for each entry', () => {
      const mgr = new BacklogManager()
      const a = mgr.enqueue({
        repo: 'owner/repo', prNumber: 1, headSha: 'a', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
      })
      const b = mgr.enqueue({
        repo: 'owner/repo', prNumber: 2, headSha: 'b', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
      })
      expect(a.id).not.toBe(b.id)
    })

    it('uses the default 1h retry delay', () => {
      const mgr = new BacklogManager()
      const now = new Date('2026-04-12T10:00:00.000Z')
      const entry = mgr.enqueue({
        repo: 'owner/repo', prNumber: 42, headSha: 'abc',
        payload: samplePayload(), reason: 'rate_limit', failedProvider: 'claude',
        now,
      })
      const retryAt = new Date(entry.retryAfter).getTime()
      expect(retryAt - now.getTime()).toBe(DEFAULT_RETRY_DELAY_MS)
    })

    it('honours retryDelayMs override', () => {
      const mgr = new BacklogManager()
      const now = new Date('2026-04-12T10:00:00.000Z')
      const entry = mgr.enqueue({
        repo: 'owner/repo', prNumber: 42, headSha: 'abc',
        payload: samplePayload(), reason: 'rate_limit', failedProvider: 'claude',
        now,
        retryDelayMs: 30_000, // 30 seconds
      })
      const retryAt = new Date(entry.retryAfter).getTime()
      expect(retryAt - now.getTime()).toBe(30_000)
    })
  })

  describe('getReady', () => {
    it('returns only entries whose retryAfter has passed', () => {
      const mgr = new BacklogManager()
      const now = new Date('2026-04-12T10:00:00.000Z')

      // Entry queued 2h ago — retry at t-1h, which is in the past.
      mgr.enqueue({
        repo: 'owner/a', prNumber: 1, headSha: 'a', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
        now: new Date('2026-04-12T08:00:00.000Z'),
      })
      // Entry queued now — retry at t+1h, not ready yet.
      mgr.enqueue({
        repo: 'owner/b', prNumber: 2, headSha: 'b', payload: samplePayload(),
        reason: 'auth_failure', failedProvider: 'opencode',
        now,
      })

      const ready = mgr.getReady(now)
      expect(ready).toHaveLength(1)
      expect(ready[0].repo).toBe('owner/a')
    })

    it('returns copies that do not affect stored entries', () => {
      const mgr = new BacklogManager()
      mgr.enqueue({
        repo: 'owner/a', prNumber: 1, headSha: 'a', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
        now: new Date('2026-04-12T08:00:00.000Z'),
      })

      const ready = mgr.getReady(new Date('2026-04-12T10:00:00.000Z'))
      ready[0].retryCount = 999

      expect(mgr.all()[0].retryCount).toBe(0)
    })

    it('returns empty array when nothing ready', () => {
      const mgr = new BacklogManager()
      mgr.enqueue({
        repo: 'owner/a', prNumber: 1, headSha: 'a', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
        now: new Date('2026-04-12T10:00:00.000Z'),
      })

      const ready = mgr.getReady(new Date('2026-04-12T10:30:00.000Z'))
      expect(ready).toEqual([])
    })
  })

  describe('remove', () => {
    it('removes an entry by id and writes to disk', () => {
      const mgr = new BacklogManager()
      const entry = mgr.enqueue({
        repo: 'owner/a', prNumber: 1, headSha: 'a', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
      })
      vi.mocked(writeFileSync).mockClear()

      mgr.remove(entry.id)
      expect(mgr.size()).toBe(0)
      expect(writeFileSync).toHaveBeenCalled()
    })

    it('is a no-op for unknown ids', () => {
      const mgr = new BacklogManager()
      mgr.enqueue({
        repo: 'owner/a', prNumber: 1, headSha: 'a', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
      })
      vi.mocked(writeFileSync).mockClear()

      mgr.remove('nonexistent')
      expect(mgr.size()).toBe(1)
      expect(writeFileSync).not.toHaveBeenCalled()
    })
  })

  describe('removeByPr', () => {
    it('removes all entries for a given PR', () => {
      const mgr = new BacklogManager()
      mgr.enqueue({ repo: 'owner/repo', prNumber: 42, headSha: 'a', payload: samplePayload(), reason: 'rate_limit', failedProvider: 'claude' })
      mgr.enqueue({ repo: 'owner/repo', prNumber: 42, headSha: 'b', payload: samplePayload(), reason: 'auth_failure', failedProvider: 'opencode' })
      mgr.enqueue({ repo: 'owner/repo', prNumber: 99, headSha: 'c', payload: samplePayload(), reason: 'rate_limit', failedProvider: 'claude' })

      const removed = mgr.removeByPr('owner/repo', 42)
      expect(removed).toBe(2)
      expect(mgr.size()).toBe(1)
      expect(mgr.all()[0].prNumber).toBe(99)
    })

    it('returns 0 and does not flush when no entries match', () => {
      const mgr = new BacklogManager()
      mgr.enqueue({ repo: 'owner/repo', prNumber: 1, headSha: 'a', payload: samplePayload(), reason: 'rate_limit', failedProvider: 'claude' })
      vi.mocked(writeFileSync).mockClear()

      const removed = mgr.removeByPr('owner/repo', 999)
      expect(removed).toBe(0)
      expect(mgr.size()).toBe(1)
      expect(writeFileSync).not.toHaveBeenCalled()
    })
  })

  describe('bumpRetry', () => {
    it('increments retryCount and pushes retryAfter forward', () => {
      const mgr = new BacklogManager()
      const entry = mgr.enqueue({
        repo: 'owner/a', prNumber: 1, headSha: 'a', payload: samplePayload(),
        reason: 'rate_limit', failedProvider: 'claude',
        now: new Date('2026-04-12T08:00:00.000Z'),
      })
      expect(entry.retryCount).toBe(0)
      expect(entry.retryAfter).toBe('2026-04-12T09:00:00.000Z')

      mgr.bumpRetry(entry.id, new Date('2026-04-12T09:30:00.000Z'))

      const updated = mgr.all()[0]
      expect(updated.retryCount).toBe(1)
      expect(updated.retryAfter).toBe('2026-04-12T10:30:00.000Z')
    })

    it('is a no-op for unknown ids', () => {
      const mgr = new BacklogManager()
      expect(() => mgr.bumpRetry('nonexistent')).not.toThrow()
    })
  })

  describe('persistence round-trip', () => {
    it('enqueue → serialize → load preserves data', () => {
      const mgr1 = new BacklogManager()
      const entry = mgr1.enqueue({
        repo: 'owner/a', prNumber: 42, headSha: 'abc', payload: samplePayload(),
        reason: 'auth_failure', failedProvider: 'both',
        now: new Date('2026-04-12T10:00:00.000Z'),
      })

      // Grab what was written to disk
      const writeCall = vi.mocked(writeFileSync).mock.calls.find(c =>
        String(c[0]).includes('webhook-backlog'),
      )
      expect(writeCall).toBeDefined()
      const serialized = String(writeCall?.[1])

      // Simulate a fresh start that loads the file
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(serialized)

      const mgr2 = new BacklogManager()
      expect(mgr2.size()).toBe(1)
      expect(mgr2.all()[0]).toEqual(entry)
    })
  })

  describe('shutdown', () => {
    it('flushes state to disk', () => {
      const mgr = new BacklogManager()
      vi.mocked(writeFileSync).mockClear()
      mgr.shutdown()
      expect(writeFileSync).toHaveBeenCalled()
    })
  })
})
