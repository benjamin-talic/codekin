/** Tests for loadWebhookConfig — verifies default values, environment variable overrides, and file-based configuration; mocks fs. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
  }
})

import { loadWebhookConfig } from './webhook-config.js'
import { existsSync, readFileSync } from 'fs'

describe('loadWebhookConfig', () => {
  const savedEnv = { ...process.env }

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false)
    // Clear all webhook env vars
    delete process.env.GITHUB_WEBHOOK_ENABLED
    delete process.env.GITHUB_WEBHOOK_MAX_SESSIONS
    delete process.env.GITHUB_WEBHOOK_LOG_LINES
    delete process.env.GITHUB_WEBHOOK_SECRET
    delete process.env.GITHUB_WEBHOOK_ACTOR_ALLOWLIST
    delete process.env.GITHUB_WEBHOOK_PR_DEBOUNCE_MS
    delete process.env.GITHUB_WEBHOOK_PR_REVIEW_PROVIDER
    delete process.env.GITHUB_WEBHOOK_PR_REVIEW_CLAUDE_MODEL
    delete process.env.GITHUB_WEBHOOK_PR_REVIEW_OPENCODE_MODEL
  })

  afterEach(() => {
    process.env = { ...savedEnv }
    vi.restoreAllMocks()
  })

  describe('defaults', () => {
    it('returns default values when no file and no env vars', () => {
      const config = loadWebhookConfig()
      expect(config).toEqual({
        enabled: false,
        maxConcurrentSessions: 15,
        logLinesToInclude: 200,
        secret: '',
        actorAllowlist: [],
        prDebounceMs: 60_000,
        prReviewProvider: 'claude',
        prReviewClaudeModel: 'sonnet',
        prReviewOpencodeModel: 'openai/gpt-5.4',
      })
    })
  })

  describe('config file loading', () => {
    it('overrides defaults with file values', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        enabled: true,
        maxConcurrentSessions: 5,
        logLinesToInclude: 500,
      }))

      const config = loadWebhookConfig()
      expect(config.enabled).toBe(true)
      expect(config.maxConcurrentSessions).toBe(5)
      expect(config.logLinesToInclude).toBe(500)
    })

    it('only overrides provided fields', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ enabled: true }))

      const config = loadWebhookConfig()
      expect(config.enabled).toBe(true)
      expect(config.maxConcurrentSessions).toBe(15)  // default
      expect(config.logLinesToInclude).toBe(200)     // default
    })

    it('ignores wrong types in config file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        enabled: 'yes',              // should be boolean
        maxConcurrentSessions: 'five', // should be number
      }))

      const config = loadWebhookConfig()
      expect(config.enabled).toBe(false)           // default
      expect(config.maxConcurrentSessions).toBe(15) // default
    })

    it('handles missing config file gracefully', () => {
      vi.mocked(existsSync).mockReturnValue(false)
      const config = loadWebhookConfig()
      expect(config.enabled).toBe(false)
    })

    it('handles corrupt JSON in config file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('not valid json{{{')

      const config = loadWebhookConfig()
      expect(config.enabled).toBe(false)
      expect(config.maxConcurrentSessions).toBe(15)
    })
  })

  describe('env var overrides', () => {
    it('GITHUB_WEBHOOK_ENABLED=true enables', () => {
      process.env.GITHUB_WEBHOOK_ENABLED = 'true'
      expect(loadWebhookConfig().enabled).toBe(true)
    })

    it('GITHUB_WEBHOOK_ENABLED=1 enables', () => {
      process.env.GITHUB_WEBHOOK_ENABLED = '1'
      expect(loadWebhookConfig().enabled).toBe(true)
    })

    it('GITHUB_WEBHOOK_ENABLED=false overrides file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ enabled: true }))
      process.env.GITHUB_WEBHOOK_ENABLED = 'false'

      expect(loadWebhookConfig().enabled).toBe(false)
    })

    it('GITHUB_WEBHOOK_MAX_SESSIONS overrides default', () => {
      process.env.GITHUB_WEBHOOK_MAX_SESSIONS = '10'
      expect(loadWebhookConfig().maxConcurrentSessions).toBe(10)
    })

    it('GITHUB_WEBHOOK_MAX_SESSIONS=0 is ignored', () => {
      process.env.GITHUB_WEBHOOK_MAX_SESSIONS = '0'
      expect(loadWebhookConfig().maxConcurrentSessions).toBe(15)
    })

    it('GITHUB_WEBHOOK_MAX_SESSIONS=abc is ignored', () => {
      process.env.GITHUB_WEBHOOK_MAX_SESSIONS = 'abc'
      expect(loadWebhookConfig().maxConcurrentSessions).toBe(15)
    })

    it('GITHUB_WEBHOOK_LOG_LINES overrides default', () => {
      process.env.GITHUB_WEBHOOK_LOG_LINES = '500'
      expect(loadWebhookConfig().logLinesToInclude).toBe(500)
    })

    it('GITHUB_WEBHOOK_SECRET is returned', () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'mysecret123'
      expect(loadWebhookConfig().secret).toBe('mysecret123')
    })

    it('GITHUB_WEBHOOK_ACTOR_ALLOWLIST parses comma-separated usernames', () => {
      process.env.GITHUB_WEBHOOK_ACTOR_ALLOWLIST = 'alice, bob, charlie'
      const config = loadWebhookConfig()
      expect(config.actorAllowlist).toEqual(['alice', 'bob', 'charlie'])
    })

    it('GITHUB_WEBHOOK_ACTOR_ALLOWLIST handles single user', () => {
      process.env.GITHUB_WEBHOOK_ACTOR_ALLOWLIST = 'alice'
      expect(loadWebhookConfig().actorAllowlist).toEqual(['alice'])
    })

    it('GITHUB_WEBHOOK_ACTOR_ALLOWLIST empty string results in empty array', () => {
      process.env.GITHUB_WEBHOOK_ACTOR_ALLOWLIST = ''
      expect(loadWebhookConfig().actorAllowlist).toEqual([])
    })
  })

  describe('actorAllowlist from config file', () => {
    it('loads actorAllowlist from config file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        actorAllowlist: ['alice', 'bob'],
      }))

      expect(loadWebhookConfig().actorAllowlist).toEqual(['alice', 'bob'])
    })

    it('ignores non-array actorAllowlist', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        actorAllowlist: 'alice',
      }))

      expect(loadWebhookConfig().actorAllowlist).toEqual([])
    })

    it('ignores actorAllowlist with non-string entries', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        actorAllowlist: ['alice', 123],
      }))

      expect(loadWebhookConfig().actorAllowlist).toEqual([])
    })

    it('env var overrides config file actorAllowlist', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        actorAllowlist: ['alice'],
      }))
      process.env.GITHUB_WEBHOOK_ACTOR_ALLOWLIST = 'bob,charlie'

      expect(loadWebhookConfig().actorAllowlist).toEqual(['bob', 'charlie'])
    })
  })

  describe('prDebounceMs', () => {
    it('defaults to 60000', () => {
      expect(loadWebhookConfig().prDebounceMs).toBe(60_000)
    })

    it('loads from config file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ prDebounceMs: 30000 }))
      expect(loadWebhookConfig().prDebounceMs).toBe(30000)
    })

    it('GITHUB_WEBHOOK_PR_DEBOUNCE_MS overrides default', () => {
      process.env.GITHUB_WEBHOOK_PR_DEBOUNCE_MS = '5000'
      expect(loadWebhookConfig().prDebounceMs).toBe(5000)
    })

    it('GITHUB_WEBHOOK_PR_DEBOUNCE_MS=0 disables debounce', () => {
      process.env.GITHUB_WEBHOOK_PR_DEBOUNCE_MS = '0'
      expect(loadWebhookConfig().prDebounceMs).toBe(0)
    })

    it('GITHUB_WEBHOOK_PR_DEBOUNCE_MS=abc is ignored', () => {
      process.env.GITHUB_WEBHOOK_PR_DEBOUNCE_MS = 'abc'
      expect(loadWebhookConfig().prDebounceMs).toBe(60_000)
    })

    it('env var overrides config file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ prDebounceMs: 30000 }))
      process.env.GITHUB_WEBHOOK_PR_DEBOUNCE_MS = '10000'
      expect(loadWebhookConfig().prDebounceMs).toBe(10000)
    })
  })

  describe('prReview provider/model settings', () => {
    it('loads provider and model settings from config file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        prReviewProvider: 'opencode',
        prReviewClaudeModel: 'opus',
        prReviewOpencodeModel: 'openai/gpt-5.4-mini',
      }))

      const config = loadWebhookConfig()
      expect(config.prReviewProvider).toBe('opencode')
      expect(config.prReviewClaudeModel).toBe('opus')
      expect(config.prReviewOpencodeModel).toBe('openai/gpt-5.4-mini')
    })

    it('env vars override config file values', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
        prReviewProvider: 'claude',
        prReviewClaudeModel: 'sonnet',
        prReviewOpencodeModel: 'openai/gpt-5.4',
      }))

      process.env.GITHUB_WEBHOOK_PR_REVIEW_PROVIDER = 'split'
      process.env.GITHUB_WEBHOOK_PR_REVIEW_CLAUDE_MODEL = 'opus-override'
      process.env.GITHUB_WEBHOOK_PR_REVIEW_OPENCODE_MODEL = 'openai/o3'

      const config = loadWebhookConfig()
      expect(config.prReviewProvider).toBe('split')
      expect(config.prReviewClaudeModel).toBe('opus-override')
      expect(config.prReviewOpencodeModel).toBe('openai/o3')
    })

    it('ignores invalid provider mode in config file', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ prReviewProvider: 'invalid' }))
      expect(loadWebhookConfig().prReviewProvider).toBe('claude')
    })

    it('ignores invalid provider mode in env var', () => {
      process.env.GITHUB_WEBHOOK_PR_REVIEW_PROVIDER = 'invalid'
      expect(loadWebhookConfig().prReviewProvider).toBe('claude')
    })

    it('accepts split as valid provider mode', () => {
      process.env.GITHUB_WEBHOOK_PR_REVIEW_PROVIDER = 'split'
      expect(loadWebhookConfig().prReviewProvider).toBe('split')
    })

    it('ignores empty string model env vars', () => {
      process.env.GITHUB_WEBHOOK_PR_REVIEW_CLAUDE_MODEL = ''
      process.env.GITHUB_WEBHOOK_PR_REVIEW_OPENCODE_MODEL = '  '
      const config = loadWebhookConfig()
      expect(config.prReviewClaudeModel).toBe('sonnet')
      expect(config.prReviewOpencodeModel).toBe('openai/gpt-5.4')
    })
  })
})
