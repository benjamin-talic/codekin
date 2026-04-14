import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { randomBytes } from 'crypto'
import type { WebhookConfig } from './webhook-types.js'

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
  let maxConcurrentSessions = 3
  let logLinesToInclude = 200
  let actorAllowlist: string[] = []
  let secret = ''
  let prDebounceMs = 60_000
  let prReviewProvider: 'claude' | 'opencode' | 'split' = 'claude'
  let prReviewClaudeModel = 'sonnet'
  let prReviewOpencodeModel = 'openai/gpt-5.4'

  // Try loading config file
  if (existsSync(CONFIG_FILE)) {
    try {
      const raw = readFileSync(CONFIG_FILE, 'utf-8')
      const file = JSON.parse(raw) as Partial<WebhookConfig> & { secret?: string }
      if (typeof file.enabled === 'boolean') enabled = file.enabled
      if (typeof file.maxConcurrentSessions === 'number') maxConcurrentSessions = file.maxConcurrentSessions
      if (typeof file.logLinesToInclude === 'number') logLinesToInclude = file.logLinesToInclude
      if (Array.isArray(file.actorAllowlist) && file.actorAllowlist.every(v => typeof v === 'string')) {
        actorAllowlist = file.actorAllowlist
      }
      if (typeof file.secret === 'string') secret = file.secret
      if (typeof file.prDebounceMs === 'number') prDebounceMs = file.prDebounceMs
      if (file.prReviewProvider === 'claude' || file.prReviewProvider === 'opencode' || file.prReviewProvider === 'split') {
        prReviewProvider = file.prReviewProvider
      }
      if (typeof file.prReviewClaudeModel === 'string') prReviewClaudeModel = file.prReviewClaudeModel
      if (typeof file.prReviewOpencodeModel === 'string') prReviewOpencodeModel = file.prReviewOpencodeModel
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

  const envSecret = process.env.GITHUB_WEBHOOK_SECRET
  if (envSecret !== undefined) {
    secret = envSecret
  }

  const envDebounce = process.env.GITHUB_WEBHOOK_PR_DEBOUNCE_MS
  if (envDebounce !== undefined) {
    const n = parseInt(envDebounce, 10)
    if (!isNaN(n) && n >= 0) prDebounceMs = n
  }

  const envProvider = process.env.GITHUB_WEBHOOK_PR_REVIEW_PROVIDER
  if (envProvider === 'claude' || envProvider === 'opencode' || envProvider === 'split') {
    prReviewProvider = envProvider
  }

  const envClaudeModel = process.env.GITHUB_WEBHOOK_PR_REVIEW_CLAUDE_MODEL
  if (envClaudeModel) prReviewClaudeModel = envClaudeModel

  const envOpencodeModel = process.env.GITHUB_WEBHOOK_PR_REVIEW_OPENCODE_MODEL
  if (envOpencodeModel) prReviewOpencodeModel = envOpencodeModel

  // Normalize short Claude model names to full IDs so the UI model validation
  // doesn't "correct" them (e.g. 'sonnet' → 'claude-sonnet-4-6').
  const CLAUDE_MODEL_ALIASES: Record<string, string> = {
    'sonnet': 'claude-sonnet-4-6',
    'opus': 'claude-opus-4-6',
    'haiku': 'claude-haiku-4-5-20251001',
  }
  prReviewClaudeModel = CLAUDE_MODEL_ALIASES[prReviewClaudeModel] ?? prReviewClaudeModel

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

// ---------------------------------------------------------------------------
// Config persistence for auto-setup
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random webhook secret.
 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Persist webhook config updates to the config file (atomic read-merge-write).
 * Only writes fields that are explicitly provided; preserves existing values.
 */
export function saveWebhookConfig(updates: Partial<FullWebhookConfig>): void {
  let existing: Record<string, unknown> = {}

  if (existsSync(CONFIG_FILE)) {
    try {
      existing = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8')) as Record<string, unknown>
    } catch {
      // Start fresh if file is corrupt
    }
  }

  const merged = { ...existing, ...updates }

  // Ensure directory exists
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })

  // Atomic write: write to tmp file then rename
  const tmpFile = CONFIG_FILE + '.tmp'
  writeFileSync(tmpFile, JSON.stringify(merged, null, 2) + '\n', 'utf-8')
  renameSync(tmpFile, CONFIG_FILE)
}
