/** Tests for classifyProviderError — verifies regex patterns against realistic
 *  error strings from Claude CLI, OpenCode / OpenAI, and the GitHub API. */
import { describe, it, expect } from 'vitest'
import { classifyProviderError } from './webhook-error-classifier.js'

describe('classifyProviderError', () => {
  describe('null / empty input', () => {
    it('returns "other" for undefined', () => {
      expect(classifyProviderError(undefined)).toBe('other')
    })

    it('returns "other" for null', () => {
      expect(classifyProviderError(null)).toBe('other')
    })

    it('returns "other" for empty string', () => {
      expect(classifyProviderError('')).toBe('other')
    })

    it('returns "other" for whitespace-only', () => {
      expect(classifyProviderError('   \n  ')).toBe('other')
    })
  })

  describe('rate_limit category', () => {
    // Realistic strings — mix of what Claude CLI, OpenCode, and raw GitHub API surface.
    const cases: Array<[string, string]> = [
      ['API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your daily rate limit."}}', 'Claude daily rate limit'],
      ['Claude usage limit reached. Please try again in 4h 32m.', 'Claude usage limit wording'],
      ['Rate limit exceeded. Please retry after 60 seconds.', 'generic rate limit'],
      ['Error 429: Too Many Requests', 'HTTP 429'],
      ['You exceeded your current quota, please check your plan and billing details.', 'OpenAI quota exceeded'],
      ['Request was rate-limited by provider.', 'hyphen-rate-limited'],
      ['tokens per minute exceeded for gpt-4', 'TPM'],
      ['tokens per day: insufficient', 'TPD'],
      ['Weekly cap reached. Limit resets in 3 days.', 'weekly cap'],
      ['monthly quota exhausted', 'monthly quota'],
      ['Service overloaded — try again later', 'overloaded'],
      ['Insufficient credits to complete request', 'insufficient credits'],
      ['Your balance is too low to make API calls', 'low balance'],
      ['You have reached your rate limit for this model.', 'you have reached'],
    ]

    for (const [input, label] of cases) {
      it(`matches: ${label}`, () => {
        expect(classifyProviderError(input)).toBe('rate_limit')
      })
    }
  })

  describe('auth_failure category', () => {
    const cases: Array<[string, string]> = [
      ['API Error: 401 Unauthorized', 'HTTP 401'],
      ['Error 403: Forbidden', 'HTTP 403'],
      ['Invalid API key provided', 'invalid api key'],
      ['The token is invalid or expired', 'invalid/expired token'],
      ['Your API key has expired', 'expired api key'],
      ['oauth token expired', 'expired oauth'],
      ['Authentication failed: credentials missing', 'auth fail'],
      ['Unauthorized: check your API key', 'unauthorized'],
      ['Unauthorised access', 'UK spelling'],
      ['403 Forbidden — insufficient permissions', 'forbidden'],
      ['Missing API key in request headers', 'missing api key'],
      ['API key invalid — please regenerate', 'api key invalid'],
      ['API key revoked', 'revoked'],
    ]

    for (const [input, label] of cases) {
      it(`matches: ${label}`, () => {
        expect(classifyProviderError(input)).toBe('auth_failure')
      })
    }
  })

  describe('other category', () => {
    const cases: Array<[string, string]> = [
      ['Connection refused', 'network'],
      ['ENOENT: file not found', 'filesystem'],
      ['syntax error at line 42', 'parse error'],
      ['Context length exceeded — too many tokens in prompt', 'context length (not rate)'],
      ['gh: command not found', 'missing binary'],
      ['Workspace directory does not exist', 'workspace error'],
      ['Segmentation fault', 'crash'],
      ['UnhandledPromiseRejection: Error: something went wrong', 'generic error'],
    ]

    for (const [input, label] of cases) {
      it(`returns "other" for: ${label}`, () => {
        expect(classifyProviderError(input)).toBe('other')
      })
    }
  })

  describe('precedence', () => {
    it('rate_limit wins when both categories match', () => {
      // "403 quota exceeded" — both an auth-ish 403 and a quota pattern.
      // Rate limit is preferred because it's the more actionable category
      // (wait-and-retry vs. operator must intervene).
      expect(classifyProviderError('403 Forbidden: monthly quota exceeded')).toBe('rate_limit')
    })
  })

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      expect(classifyProviderError('RATE LIMIT EXCEEDED')).toBe('rate_limit')
      expect(classifyProviderError('unauthorized')).toBe('auth_failure')
      expect(classifyProviderError('Unauthorized')).toBe('auth_failure')
      expect(classifyProviderError('INVALID API KEY')).toBe('auth_failure')
    })
  })
})
