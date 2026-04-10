import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { PrReviewProviderMode, WebhookConfig } from './webhook-types.js'

function isPrReviewProviderMode(value: unknown): value is PrReviewProviderMode {
  return value === 'claude' || value === 'opencode' || value === 'split'
}

const CONFIG_FILE = join(homedir(), '.codekin', 'webhook-config.json')

export interface FullWebhookConfig extends WebhookConfig {
  secret: string
}

/**
 * Load webhook configuration from environment variables and optional config file.
 * Env vars take precedence over config file values.
 */
export function loadWebhookConfig(): FullWebhookConfig {
  // Defaults
  let enabled = false
  let maxConcurrentSessions = 15
  let logLinesToInclude = 200
  let actorAllowlist: string[] = []
  let prDebounceMs = 60_000 // 60 seconds — coalesce rapid PR events
  let prReviewProvider: PrReviewProviderMode = 'claude'
  let prReviewClaudeModel = 'sonnet'
  let prReviewOpencodeModel = 'openai/gpt-5.4'

  // Try loading config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8')
      const file = JSON.parse(raw) as Partial<WebhookConfig>
      if (typeof file.enabled === 'boolean') enabled = file.enabled
      if (typeof file.maxConcurrentSessions === 'number') maxConcurrentSessions = file.maxConcurrentSessions
      if (typeof file.logLinesToInclude === 'number') logLinesToInclude = file.logLinesToInclude
      if (Array.isArray(file.actorAllowlist) && file.actorAllowlist.every(v => typeof v === 'string')) {
        actorAllowlist = file.actorAllowlist
      }
      if (typeof file.prDebounceMs === 'number') prDebounceMs = file.prDebounceMs
      if (isPrReviewProviderMode(file.prReviewProvider)) prReviewProvider = file.prReviewProvider
      if (typeof file.prReviewClaudeModel === 'string' && file.prReviewClaudeModel.trim()) {
        prReviewClaudeModel = file.prReviewClaudeModel.trim()
      }
      if (typeof file.prReviewOpencodeModel === 'string' && file.prReviewOpencodeModel.trim()) {
        prReviewOpencodeModel = file.prReviewOpencodeModel.trim()
      }
    } catch (err) {
      console.warn('[webhook] Failed to parse config file:', err)
    }
  }

  // Env vars override config file
  const envEnabled = process.env.GITHUB_WEBHOOK_ENABLED
  if (envEnabled !== undefined) {
    enabled = envEnabled === 'true' || envEnabled === '1'
  }

  const envMaxSessions = process.env.GITHUB_WEBHOOK_MAX_SESSIONS
  if (envMaxSessions !== undefined) {
    const n = parseInt(envMaxSessions, 10)
    if (!isNaN(n) && n > 0) maxConcurrentSessions = n
  }

  const envLogLines = process.env.GITHUB_WEBHOOK_LOG_LINES
  if (envLogLines !== undefined) {
    const n = parseInt(envLogLines, 10)
    if (!isNaN(n) && n > 0) logLinesToInclude = n
  }

  const envActorAllowlist = process.env.GITHUB_WEBHOOK_ACTOR_ALLOWLIST
  if (envActorAllowlist !== undefined) {
    actorAllowlist = envActorAllowlist.split(',').map(s => s.trim()).filter(Boolean)
  }

  const envPrDebounceMs = process.env.GITHUB_WEBHOOK_PR_DEBOUNCE_MS
  if (envPrDebounceMs !== undefined) {
    const n = parseInt(envPrDebounceMs, 10)
    if (!isNaN(n) && n >= 0) prDebounceMs = n
  }

  const envPrReviewProvider = process.env.GITHUB_WEBHOOK_PR_REVIEW_PROVIDER
  if (envPrReviewProvider !== undefined && isPrReviewProviderMode(envPrReviewProvider)) {
    prReviewProvider = envPrReviewProvider
  }

  const envPrReviewClaudeModel = process.env.GITHUB_WEBHOOK_PR_REVIEW_CLAUDE_MODEL
  if (envPrReviewClaudeModel !== undefined && envPrReviewClaudeModel.trim()) {
    prReviewClaudeModel = envPrReviewClaudeModel.trim()
  }

  const envPrReviewOpencodeModel = process.env.GITHUB_WEBHOOK_PR_REVIEW_OPENCODE_MODEL
  if (envPrReviewOpencodeModel !== undefined && envPrReviewOpencodeModel.trim()) {
    prReviewOpencodeModel = envPrReviewOpencodeModel.trim()
  }

  const secret = process.env.GITHUB_WEBHOOK_SECRET || ''

  return {
    enabled,
    secret,
    maxConcurrentSessions,
    logLinesToInclude,
    actorAllowlist,
    prDebounceMs,
    prReviewProvider,
    prReviewClaudeModel,
    prReviewOpencodeModel,
  }
}
