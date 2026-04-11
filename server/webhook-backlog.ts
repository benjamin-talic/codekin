/**
 * Persists webhook PR events that failed due to provider-level issues
 * (rate limit, auth failure) so they can be retried after a cooldown period.
 *
 * The retry worker (owned by `webhook-handler.ts`) polls this backlog every
 * minute, pulls entries whose `retryAfter` is in the past, checks the PR is
 * still open via `gh api`, and re-fires events that should still be reviewed.
 *
 * No max retry count: entries stay until the PR closes/merges. That keeps
 * the system self-healing — an operator who fixes a bad API key later will
 * see the backlogged review run successfully whenever it next comes due.
 *
 * Persistence pattern mirrors `webhook-dedup.ts` and `webhook-provider-health.ts`:
 * atomic tmp+rename writes, `{mode: 0o600}`, graceful shutdown.
 */

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type {
  BacklogEntry,
  PullRequestPayload,
  ProviderUnhealthyReason,
} from './webhook-types.js'

const DATA_DIR = join(homedir(), '.codekin')
const BACKLOG_FILE = join(DATA_DIR, 'webhook-backlog.json')

/** 1 hour between retries. Matches the plan spec. */
export const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000

/** Parameters for creating a new backlog entry. */
export interface EnqueueParams {
  repo: string
  prNumber: number
  headSha: string
  payload: PullRequestPayload
  reason: ProviderUnhealthyReason
  failedProvider: 'claude' | 'opencode' | 'both'
  /** Override for testing. Defaults to `new Date()`. */
  now?: Date
  /** Override the retry delay (for testing or a future config hook). */
  retryDelayMs?: number
}

export class BacklogManager {
  private entries: BacklogEntry[] = []

  constructor() {
    this.loadFromDisk()
  }

  /**
   * Add a new entry to the backlog and flush to disk immediately.
   * Returns the generated entry (including its id).
   */
  enqueue(params: EnqueueParams): BacklogEntry {
    const now = params.now ?? new Date()
    const delayMs = params.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
    const retryAfter = new Date(now.getTime() + delayMs)

    const entry: BacklogEntry = {
      id: randomUUID(),
      repo: params.repo,
      prNumber: params.prNumber,
      headSha: params.headSha,
      payload: params.payload,
      reason: params.reason,
      failedProvider: params.failedProvider,
      queuedAt: now.toISOString(),
      retryAfter: retryAfter.toISOString(),
      retryCount: 0,
    }
    this.entries.push(entry)
    this.flushToDisk()
    return entry
  }

  /**
   * Return all entries whose `retryAfter` has passed. Returns shallow copies —
   * mutating them does not affect the stored entries. The caller is responsible
   * for calling `remove()` after successfully re-firing, or `bumpRetry()` if
   * the retry should be rescheduled for another round.
   */
  getReady(now: Date = new Date()): BacklogEntry[] {
    const cutoff = now.getTime()
    return this.entries
      .filter(e => new Date(e.retryAfter).getTime() <= cutoff)
      .map(e => ({ ...e }))
  }

  /**
   * Remove an entry by id. No-op if the id is unknown. Flushes to disk.
   */
  remove(id: string): void {
    const before = this.entries.length
    this.entries = this.entries.filter(e => e.id !== id)
    if (this.entries.length !== before) {
      this.flushToDisk()
    }
  }

  /**
   * Reschedule an entry for another retry round. Increments `retryCount`
   * and pushes `retryAfter` forward by `retryDelayMs`. No-op if id unknown.
   * Called by the retry worker when the new attempt also fails.
   */
  bumpRetry(id: string, now: Date = new Date(), retryDelayMs: number = DEFAULT_RETRY_DELAY_MS): void {
    const entry = this.entries.find(e => e.id === id)
    if (!entry) return
    entry.retryCount += 1
    entry.retryAfter = new Date(now.getTime() + retryDelayMs).toISOString()
    this.flushToDisk()
  }

  /** Return all current backlog entries (copies). */
  all(): BacklogEntry[] {
    return this.entries.map(e => ({ ...e }))
  }

  /** Current backlog size. Exposed via `/api/webhooks/health`. */
  size(): number {
    return this.entries.length
  }

  /** Flush final state to disk. Called from the webhook handler's shutdown(). */
  shutdown(): void {
    this.flushToDisk()
  }

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private loadFromDisk(): void {
    if (!existsSync(BACKLOG_FILE)) return
    try {
      const raw = readFileSync(BACKLOG_FILE, 'utf-8')
      const parsed = JSON.parse(raw) as { entries?: BacklogEntry[] }
      if (Array.isArray(parsed.entries)) {
        this.entries = parsed.entries.filter(isValidEntry)
      }
    } catch (err) {
      console.warn('[webhook-backlog] Failed to load webhook-backlog.json, starting empty:', err)
      this.entries = []
    }
  }

  private flushToDisk(): void {
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = BACKLOG_FILE + '.tmp'
      const data = { entries: this.entries }
      writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
      renameSync(tmp, BACKLOG_FILE)
    } catch (err) {
      console.warn('[webhook-backlog] Failed to persist webhook-backlog.json:', err)
    }
  }
}

/** Defensive check to drop malformed entries at load time. */
function isValidEntry(entry: unknown): entry is BacklogEntry {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Record<string, unknown>
  return (
    typeof e.id === 'string' &&
    typeof e.repo === 'string' &&
    typeof e.prNumber === 'number' &&
    typeof e.headSha === 'string' &&
    typeof e.payload === 'object' &&
    (e.reason === 'rate_limit' || e.reason === 'auth_failure') &&
    typeof e.queuedAt === 'string' &&
    typeof e.retryAfter === 'string' &&
    typeof e.retryCount === 'number'
  )
}
