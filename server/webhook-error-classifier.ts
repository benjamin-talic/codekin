/**
 * Classify a provider error message into a category so the webhook flow can
 * respond appropriately (retry backlog, post PR comment, mark provider unhealthy).
 *
 * Used by `webhook-handler.ts` when a review session fails. The classification
 * decides whether the failure is a transient usage-limit issue (should backlog
 * and retry later) or an auth failure (operator intervention needed) vs. an
 * unrelated error that gets no special treatment.
 *
 * These patterns are empirical — they will need tuning as real failures surface.
 * The first deploy should be conservative: when in doubt, lean toward
 * `rate_limit` so events get backlogged rather than silently dropped.
 */

/** Category assigned to a failing provider error. */
export type ProviderErrorCategory = 'rate_limit' | 'auth_failure' | 'other'

/**
 * Regex patterns that indicate a usage / rate / quota limit was hit.
 * Starts from the existing `API_RETRY_PATTERNS` in `session-manager.ts:61-70`
 * and adds provider-specific wording (Claude's weekly/daily/monthly caps,
 * OpenAI/OpenCode's tokens-per-minute language, etc.).
 */
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /rate.?limit/i,
  /usage.?limit/i,
  /quota/i,
  /too.?many.?requests/i,
  /\b429\b/,
  /tokens.?per.?(minute|day)/i,
  /(daily|weekly|monthly).?(limit|quota|cap)/i,
  /overloaded/i,
  /(insufficient|exceeded|low).*(quota|credits|balance)/i,
  /balance.*(too.?low|insufficient|exceeded)/i,
  /you.?have.?reached.?your/i,
]

/**
 * Regex patterns that indicate bad credentials — invalid/expired API key,
 * OAuth token expiry, 401/403 responses, etc. These warrant operator
 * intervention (different PR comment) and still go on the retry backlog
 * in case the operator fixes credentials before the PR closes.
 */
const AUTH_FAILURE_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /invalid.?api.?key/i,
  /invalid.?token/i,
  /expired.?(token|key|credential|oauth)/i,
  // Also handles reversed word order: "token is invalid", "api key expired", "oauth token expired"
  /(token|credential|api.?key|oauth|session).*(is\s+)?(invalid|expired|revoked)/i,
  /unauthori[sz]ed/i,
  /authentication.?fail/i,
  /\bforbidden\b/i,
  /missing.*(credential|api.?key|token)/i,
  /api.?key.*(invalid|missing|expired|revoked)/i,
]

/**
 * Classify a provider error message.
 *
 * Order of precedence: if a message matches BOTH rate-limit and auth-failure
 * patterns (unlikely but possible — e.g. a 403 with "quota exceeded"), we
 * prefer `rate_limit` since that's typically the more actionable category
 * (wait and retry vs. operator intervention).
 *
 * @param text - Raw error text from the session (stderr, error event, etc.).
 * @returns The classification — `'other'` if nothing matches.
 */
export function classifyProviderError(text: string | undefined | null): ProviderErrorCategory {
  if (!text) return 'other'

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(text)) return 'rate_limit'
  }
  for (const pattern of AUTH_FAILURE_PATTERNS) {
    if (pattern.test(text)) return 'auth_failure'
  }
  return 'other'
}
