/**
 * Tracks the last observed health of each webhook review provider
 * (Claude, OpenCode) and persists it to disk so restarts don't lose state.
 *
 * **Observational only** — the webhook-handler never short-circuits routing
 * based on health. Every webhook always attempts its picked provider. Health
 * state is diagnostic: surfaced via `GET /api/webhooks/health` for the UI /
 * external monitoring, and used in PR comments to tell the user which
 * provider is currently failing. A successful review automatically flips a
 * provider back to `healthy` — there is no time-based TTL.
 *
 * Persistence pattern mirrors `webhook-dedup.ts`: atomic tmp+rename writes,
 * `{mode: 0o600}` file permissions, graceful shutdown handler.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { CodingProvider } from './coding-process.js'
import type {
  ProviderHealth,
  ProviderHealthFile,
  ProviderUnhealthyReason,
} from './webhook-types.js'

const DATA_DIR = join(homedir(), '.codekin')
const HEALTH_FILE = join(DATA_DIR, 'provider-health.json')

/** Cap on stored error text to prevent the file from growing unbounded. */
const MAX_ERROR_LENGTH = 500

/** Default shape used when no file exists yet or the file is corrupt. */
const INITIAL_STATE: ProviderHealthFile = {
  claude: { status: 'healthy' },
  opencode: { status: 'healthy' },
}

export class ProviderHealthManager {
  private state: ProviderHealthFile

  constructor() {
    this.state = this.loadFromDisk()
  }

  /** Return the current health of a specific provider. */
  get(provider: CodingProvider): ProviderHealth {
    return { ...this.state[provider] }
  }

  /** Return a snapshot of both providers. Safe to serialize directly. */
  getAll(): ProviderHealthFile {
    return {
      claude: { ...this.state.claude },
      opencode: { ...this.state.opencode },
    }
  }

  /**
   * Mark a provider as unhealthy with a reason and the raw error text.
   * Preserves `lastSuccessAt` (the timestamp of the last success before this
   * failure) so the endpoint can show both the failure and the last good run.
   */
  markUnhealthy(
    provider: CodingProvider,
    reason: ProviderUnhealthyReason,
    errorText: string,
    detectedAt: Date = new Date(),
  ): void {
    const existing = this.state[provider]
    this.state[provider] = {
      status: 'unhealthy',
      reason,
      detectedAt: detectedAt.toISOString(),
      lastError: truncate(errorText, MAX_ERROR_LENGTH),
      // Carry the previous lastSuccessAt forward so `/health` can still show
      // how long it's been since the provider last worked.
      lastSuccessAt: existing.lastSuccessAt,
    }
    this.flushToDisk()
  }

  /**
   * Mark a provider as healthy. Clears the unhealthy reason/error and
   * updates `lastSuccessAt`. Called after a review session completes cleanly.
   */
  markHealthy(provider: CodingProvider, at: Date = new Date()): void {
    this.state[provider] = {
      status: 'healthy',
      lastSuccessAt: at.toISOString(),
    }
    this.flushToDisk()
  }

  /** Flush final state to disk. Call from the webhook handler's shutdown(). */
  shutdown(): void {
    this.flushToDisk()
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private loadFromDisk(): ProviderHealthFile {
    if (!existsSync(HEALTH_FILE)) {
      return { ...INITIAL_STATE, claude: { ...INITIAL_STATE.claude }, opencode: { ...INITIAL_STATE.opencode } }
    }
    try {
      const raw = readFileSync(HEALTH_FILE, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ProviderHealthFile>
      return {
        claude: normalizeHealth(parsed.claude),
        opencode: normalizeHealth(parsed.opencode),
      }
    } catch (err) {
      console.warn('[provider-health] Failed to load provider-health.json, starting fresh:', err)
      return { ...INITIAL_STATE, claude: { ...INITIAL_STATE.claude }, opencode: { ...INITIAL_STATE.opencode } }
    }
  }

  private flushToDisk(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = HEALTH_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 })
      renameSync(tmp, HEALTH_FILE)
    } catch (err) {
      console.warn('[provider-health] Failed to persist provider-health.json:', err)
    }
  }
}

/** Ensure a parsed-from-disk health entry has a valid shape. */
function normalizeHealth(entry: ProviderHealth | undefined): ProviderHealth {
  if (!entry || typeof entry !== 'object') return { status: 'healthy' }
  if (entry.status !== 'healthy' && entry.status !== 'unhealthy') return { status: 'healthy' }
  return { ...entry }
}

/** Clamp a string to at most `max` chars, appending a marker when truncated. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `… (truncated, ${text.length} chars total)`
}
