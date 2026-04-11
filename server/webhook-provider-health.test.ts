/** Tests for ProviderHealthManager — verifies load/save, mark healthy/unhealthy,
 *  last-success preservation, and file corruption handling; mocks fs. */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
  }
})

import { ProviderHealthManager } from './webhook-provider-health.js'
import { existsSync, writeFileSync, readFileSync } from 'fs'

describe('ProviderHealthManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(existsSync).mockReturnValue(false)
    vi.mocked(readFileSync).mockReturnValue('{}')
  })

  describe('initial state', () => {
    it('both providers start healthy when no file exists', () => {
      const mgr = new ProviderHealthManager()
      expect(mgr.get('claude')).toEqual({ status: 'healthy' })
      expect(mgr.get('opencode')).toEqual({ status: 'healthy' })
    })

    it('loads existing state from disk', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        claude: { status: 'healthy', lastSuccessAt: '2026-04-12T09:00:00.000Z' },
        opencode: {
          status: 'unhealthy',
          reason: 'rate_limit',
          detectedAt: '2026-04-12T09:30:00.000Z',
          lastError: 'API Error: 429',
        },
      }))

      const mgr = new ProviderHealthManager()
      expect(mgr.get('claude').status).toBe('healthy')
      expect(mgr.get('claude').lastSuccessAt).toBe('2026-04-12T09:00:00.000Z')
      expect(mgr.get('opencode').status).toBe('unhealthy')
      expect(mgr.get('opencode').reason).toBe('rate_limit')
      expect(mgr.get('opencode').lastError).toBe('API Error: 429')
    })

    it('handles corrupt JSON by starting fresh', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('not valid json{{{')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const mgr = new ProviderHealthManager()
      expect(mgr.get('claude')).toEqual({ status: 'healthy' })
      expect(mgr.get('opencode')).toEqual({ status: 'healthy' })
      expect(warn).toHaveBeenCalled()

      warn.mockRestore()
    })

    it('handles missing provider entries by defaulting to healthy', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        claude: { status: 'unhealthy', reason: 'rate_limit' },
        // opencode missing
      }))

      const mgr = new ProviderHealthManager()
      expect(mgr.get('claude').status).toBe('unhealthy')
      expect(mgr.get('opencode').status).toBe('healthy')
    })

    it('ignores invalid status values', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        claude: { status: 'broken' },
        opencode: { status: 'healthy' },
      }))

      const mgr = new ProviderHealthManager()
      expect(mgr.get('claude')).toEqual({ status: 'healthy' })
    })
  })

  describe('markUnhealthy', () => {
    it('sets unhealthy status with reason and error', () => {
      const mgr = new ProviderHealthManager()
      const at = new Date('2026-04-12T10:00:00.000Z')
      mgr.markUnhealthy('claude', 'rate_limit', 'API Error: 429 daily limit', at)

      expect(mgr.get('claude')).toEqual({
        status: 'unhealthy',
        reason: 'rate_limit',
        detectedAt: '2026-04-12T10:00:00.000Z',
        lastError: 'API Error: 429 daily limit',
        lastSuccessAt: undefined,
      })
    })

    it('preserves lastSuccessAt from previous healthy state', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        claude: { status: 'healthy', lastSuccessAt: '2026-04-12T08:00:00.000Z' },
        opencode: { status: 'healthy' },
      }))
      const mgr = new ProviderHealthManager()

      mgr.markUnhealthy('claude', 'rate_limit', 'some error', new Date('2026-04-12T10:00:00.000Z'))

      const h = mgr.get('claude')
      expect(h.status).toBe('unhealthy')
      expect(h.lastSuccessAt).toBe('2026-04-12T08:00:00.000Z')
    })

    it('truncates long error text', () => {
      const mgr = new ProviderHealthManager()
      const longError = 'x'.repeat(1000)
      mgr.markUnhealthy('claude', 'rate_limit', longError)

      const h = mgr.get('claude')
      expect(h.lastError).toBeDefined()
      expect(h.lastError!.length).toBeLessThan(1000)
      expect(h.lastError).toContain('truncated')
    })

    it('writes to disk on mutation', () => {
      const mgr = new ProviderHealthManager()
      vi.mocked(writeFileSync).mockClear()

      mgr.markUnhealthy('opencode', 'auth_failure', 'invalid api key')

      expect(writeFileSync).toHaveBeenCalled()
      const [path, content] = vi.mocked(writeFileSync).mock.calls[0]
      expect(String(path)).toContain('provider-health.json')
      const parsed = JSON.parse(String(content))
      expect(parsed.opencode.status).toBe('unhealthy')
      expect(parsed.opencode.reason).toBe('auth_failure')
    })
  })

  describe('markHealthy', () => {
    it('clears unhealthy state and sets lastSuccessAt', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        claude: {
          status: 'unhealthy',
          reason: 'rate_limit',
          detectedAt: '2026-04-12T09:30:00.000Z',
          lastError: 'API Error: 429',
        },
        opencode: { status: 'healthy' },
      }))
      const mgr = new ProviderHealthManager()

      mgr.markHealthy('claude', new Date('2026-04-12T11:00:00.000Z'))

      expect(mgr.get('claude')).toEqual({
        status: 'healthy',
        lastSuccessAt: '2026-04-12T11:00:00.000Z',
      })
      // Error fields are gone
      expect(mgr.get('claude').reason).toBeUndefined()
      expect(mgr.get('claude').lastError).toBeUndefined()
    })

    it('is idempotent for already-healthy providers', () => {
      const mgr = new ProviderHealthManager()
      const before = mgr.get('claude')
      mgr.markHealthy('claude', new Date('2026-04-12T11:00:00.000Z'))
      const after = mgr.get('claude')

      expect(before.status).toBe('healthy')
      expect(after.status).toBe('healthy')
      expect(after.lastSuccessAt).toBe('2026-04-12T11:00:00.000Z')
    })
  })

  describe('getAll', () => {
    it('returns a snapshot of both providers', () => {
      const mgr = new ProviderHealthManager()
      mgr.markUnhealthy('claude', 'rate_limit', 'err')

      const snap = mgr.getAll()
      expect(snap.claude.status).toBe('unhealthy')
      expect(snap.opencode.status).toBe('healthy')
    })

    it('returns a copy, not a reference', () => {
      const mgr = new ProviderHealthManager()
      const snap = mgr.getAll()
      snap.claude.status = 'unhealthy'

      expect(mgr.get('claude').status).toBe('healthy')
    })
  })

  describe('shutdown', () => {
    it('flushes state to disk', () => {
      const mgr = new ProviderHealthManager()
      vi.mocked(writeFileSync).mockClear()

      mgr.shutdown()

      expect(writeFileSync).toHaveBeenCalled()
    })
  })
})
