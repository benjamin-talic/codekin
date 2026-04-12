/**
 * GitHub webhook handler for automated CI failure triage and PR code review.
 *
 * Processes incoming webhook events:
 *   - `workflow_run` (completed+failed) → spawns Claude session for CI diagnosis
 *   - `pull_request` (opened/synchronize/reopened/ready_for_review) → spawns Claude session for code review
 *
 * Event lifecycle / state machine:
 *   received → (filtered/duplicate/capped)
 *   received → debounced  — PR event accepted, waiting for debounce timer
 *            → (superseded)  — newer event for same PR arrived during debounce
 *            → processing  — debounce fired (or debounce disabled), async fetch started
 *            → session_created — workspace ready, session spawned, prompt sent
 *            → completed | error  — Claude exited 0 (success) or non-zero (failure)
 *
 * The 'debounced' state coalesces rapid events for the same PR (e.g. quick
 * successive pushes) so only the latest event triggers a review session.
 * The 'processing' state bridges the async gap between the debounce firing
 * (or direct accept) and the session being created.  A watchdog marks events
 * stuck in 'processing' as 'error' after PROCESSING_TIMEOUT_MS to prevent the
 * concurrency cap from leaking on partial failures.
 */

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { CreateSessionOptions, SessionManager } from './session-manager.js'
import { verifyHmacSignature } from './crypto-utils.js'
import type { CodingProvider } from './coding-process.js'
import type { WsServerMessage } from './types.js'
import type {
  WebhookConfig,
  WebhookEvent,
  WebhookEventStatus,
  WorkflowRunPayload,
  FailureContext,
  PullRequestPayload,
  PullRequestContext,
  ProviderHealthFile,
} from './webhook-types.js'
import type { FullWebhookConfig } from './webhook-config.js'
import { WebhookDedup, computeIdempotencyKey, computePrIdempotencyKey } from './webhook-dedup.js'
import { checkGhHealth, fetchFailedLogs, fetchJobs, fetchAnnotations, fetchCommitMessage, fetchPRTitle } from './webhook-github.js'
import {
  fetchPrDiff,
  fetchPrFiles,
  fetchPrCommits,
  fetchPrReviewComments,
  fetchPrReviews,
  fetchExistingReviewComment,
  fetchPrState,
  postProviderUnavailableComment,
} from './webhook-pr-github.js'
import { buildPrompt } from './webhook-prompt.js'
import { buildPrReviewPrompt } from './webhook-pr-prompt.js'
import { loadPrCache, ensureCacheDir, archivePrCache, deletePrCache } from './webhook-pr-cache.js'
import { createWorkspace, cleanupWorkspace } from './webhook-workspace.js'
import { WebhookHandlerBase } from './webhook-handler-base.js'
import { ProviderHealthManager } from './webhook-provider-health.js'
import { BacklogManager } from './webhook-backlog.js'
import { classifyProviderError } from './webhook-error-classifier.js'
import { REPOS_ROOT } from './config.js'

/** How long an event can stay in 'processing' before the watchdog marks it as error. */
const PROCESSING_TIMEOUT_MS = 5 * 60 * 1000

/** Supported pull_request actions for code review. */
const PR_REVIEW_ACTIONS = ['opened', 'synchronize', 'reopened', 'ready_for_review'] as const

/**
 * Actions that don't involve code changes — if the PR was already reviewed
 * at this SHA, skip the review to avoid wasting resources.
 */
const NO_CODE_CHANGE_ACTIONS: readonly string[] = ['reopened', 'ready_for_review']

/** Pending debounce entry for a PR event waiting to fire. */
interface PendingDebounce {
  payload: PullRequestPayload
  event: WebhookEvent
  sessionId: string
  timer: ReturnType<typeof setTimeout>
}

/** Serializable form of a pending debounce entry (no timer, for disk persistence). */
interface PendingDebounceRecord {
  key: string
  payload: PullRequestPayload
  event: WebhookEvent
  sessionId: string
}

/** On-disk location for persisted pending debounces. */
const PENDING_DEBOUNCE_FILE = join(homedir(), '.codekin', 'webhook-pending-debounce.json')

/** How often the backlog retry worker checks for ready entries. */
const RETRY_WORKER_INTERVAL_MS = 60 * 1000

/**
 * Tracking info for an active webhook review session, kept in memory only.
 * Used by the onSessionExit handler to classify failures and decide whether
 * to split-mode-fallback or backlog the event.
 */
interface ReviewSessionInfo {
  eventId: string
  provider: CodingProvider
  model: string
  payload: PullRequestPayload
  /** Set to true if this session is itself a split-mode fallback retry. */
  isFallback: boolean
}

export class WebhookHandler extends WebhookHandlerBase<WebhookEvent, WebhookEventStatus> {
  private config: FullWebhookConfig
  private sessions: SessionManager
  private dedup: WebhookDedup
  private providerHealth: ProviderHealthManager
  private backlog: BacklogManager
  private ghHealthy = false
  /** Pending debounce timers keyed by `repo#prNumber`. */
  private pendingDebounce = new Map<string, PendingDebounce>()
  /**
   * Per-session tracking of which provider was used for that review session,
   * plus the payload needed for split-mode fallback. Entries are added when
   * the session is created and removed when it exits (success or failure).
   */
  private reviewSessions = new Map<string, ReviewSessionInfo>()
  /**
   * Buffers the latest error text emitted by each session. Populated by the
   * onSessionError listener; read by onSessionExit when the session exits
   * non-zero so the error can be classified.
   */
  private sessionLastError = new Map<string, string>()
  /** Handle for the backlog retry worker interval. */
  private retryWorkerTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Whether `restorePendingDebounces()` actually ran during this process lifecycle.
   * Guards `savePendingDebounces()` from deleting a stale file when the map is empty
   * but restore never ran (e.g. unhealthy `gh` on startup) — otherwise events from a
   * prior run would be permanently lost.
   */
  private debounceFileConsumed = false

  constructor(config: FullWebhookConfig, sessions: SessionManager) {
    super('webhook', PROCESSING_TIMEOUT_MS)

    this.config = config
    this.sessions = sessions
    this.dedup = new WebhookDedup()
    this.providerHealth = new ProviderHealthManager()
    this.backlog = new BacklogManager()

    // Buffer the latest error text per session so the onSessionExit handler
    // can classify it. The error event fires BEFORE exit, so by the time
    // exit runs we have the most recent message.
    sessions.onSessionError((sessionId, errorText) => {
      this.sessionLastError.set(sessionId, errorText)
    })

    // Track session completion to update webhook event status.
    // Only update on final exit (willRestart=false) to avoid prematurely
    // marking events as 'error' when auto-restart will retry.
    sessions.onSessionExit((sessionId, code, _signal, willRestart) => {
      if (willRestart) return  // Don't update status — Claude will retry

      // Match any non-terminal status — covers both 'processing' (if Claude
      // exits before status reaches 'session_created') and 'session_created'.
      const event = this.getEvents().find(e => e.sessionId === sessionId && (e.status === 'session_created' || e.status === 'processing'))
      if (!event) {
        // Session isn't a known webhook review — clean up error buffer and bail.
        this.sessionLastError.delete(sessionId)
        return
      }

      if (code === 0) {
        // Clean exit — mark completed. onSessionResult will have already run
        // for the happy path (flipping health to healthy) and cleaned up its
        // own map entry, but this branch also covers the case where a session
        // exits 0 without emitting a result event.
        this.updateEventStatus(event.id, 'completed')
        console.log(`[webhook] Event ${event.id} → completed (session ${sessionId}, code=0)`)
        this.reviewSessions.delete(sessionId)
        this.sessionLastError.delete(sessionId)
        cleanupWorkspace(sessionId)
        return
      }

      // Non-zero exit. Classify the error text buffered from the error listener.
      const errorText = this.sessionLastError.get(sessionId) ?? `Session exited with code ${code}`
      this.sessionLastError.delete(sessionId)

      const reviewInfo = this.reviewSessions.get(sessionId)
      this.reviewSessions.delete(sessionId)

      void this.handleReviewFailure(event, sessionId, errorText, reviewInfo)
    })

    // Auto-kill webhook sessions after Claude completes its turn so they don't
    // sit idle waiting for more input and consume memory indefinitely.
    sessions.onSessionResult((sessionId, isError) => {
      if (isError) return

      const event = this.getEvents().find(
        e => e.sessionId === sessionId && (e.status === 'session_created' || e.status === 'processing'),
      )
      if (!event) return

      // Successful review — mark the used provider healthy.
      const reviewInfo = this.reviewSessions.get(sessionId)
      if (reviewInfo) {
        this.providerHealth.markHealthy(reviewInfo.provider)
        this.reviewSessions.delete(sessionId)
      }
      this.sessionLastError.delete(sessionId)

      this.updateEventStatus(event.id, 'completed')
      console.log(`[webhook] Session ${sessionId} completed review, scheduling cleanup`)

      this.sessions.stopClaude(sessionId) // suppress auto-restart
      setTimeout(() => {
        this.sessions.delete(sessionId)
      }, 2000)
    })

    // Start the backlog retry worker. It polls `backlog.getReady()` every
    // minute, skips entries whose PRs have closed, and re-fires the rest.
    this.retryWorkerTimer = setInterval(() => {
      void this.runRetryWorker()
    }, RETRY_WORKER_INTERVAL_MS)
    if (this.retryWorkerTimer.unref) this.retryWorkerTimer.unref()
  }

  /**
   * Run gh CLI health check. Must be called on startup.
   * Sets ghHealthy flag — if false, webhook processing is disabled.
   */
  async checkHealth(): Promise<boolean> {
    const result = await checkGhHealth()
    this.ghHealthy = result.available
    console.log(`[webhook] PR review config: provider=${this.config.prReviewProvider}, claudeModel=${this.config.prReviewClaudeModel}, opencodeModel=${this.config.prReviewOpencodeModel}`)
    if (!result.available) {
      console.warn(`[webhook] gh health check failed: ${result.reason}`)
      console.warn('[webhook] Webhook processing disabled — manual sessions still work')
    } else {
      console.log('[webhook] gh CLI health check passed')
      // Resume any debounced events that were pending when the server last shut down.
      // These were already acknowledged to GitHub (202), so if we don't fire them now
      // they are lost forever — GitHub won't retry.
      this.restorePendingDebounces()
    }
    return this.ghHealthy
  }

  /**
   * Verify the HMAC-SHA256 signature of a webhook payload.
   */
  verifySignature(payload: Buffer, signature: string): boolean {
    if (!this.config.secret) return false
    return verifyHmacSignature(payload, signature, this.config.secret)
  }

  /**
   * Main entry point: handle an incoming GitHub webhook request.
   * Returns the response to send back to GitHub.
   */
  async handleWebhook(
    rawBody: Buffer,
    headers: {
      event: string
      delivery: string
      signature: string
    },
  ): Promise<{
    statusCode: number
    body: Record<string, unknown>
  }> {
    const eventId = headers.delivery || randomUUID()

    // --- Enabled check ---
    if (!this.config.enabled) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'disabled', filterReason: 'Webhooks are disabled' },
      }
    }

    // --- gh health check ---
    if (!this.ghHealthy) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'disabled', filterReason: 'gh CLI not available' },
      }
    }

    // --- Signature validation ---
    if (!headers.signature) {
      return { statusCode: 401, body: { error: 'Missing X-Hub-Signature-256 header' } }
    }
    if (!this.verifySignature(rawBody, headers.signature)) {
      return { statusCode: 401, body: { error: 'Invalid signature' } }
    }

    // --- Parse payload (generic parse, dispatch by event type) ---
    let payload: unknown
    try {
      payload = JSON.parse(rawBody.toString('utf-8'))
    } catch {
      return { statusCode: 400, body: { error: 'Malformed JSON payload' } }
    }

    // --- Event type dispatch ---
    switch (headers.event) {
      case 'workflow_run':
        return this.handleWorkflowRunEvent(payload as WorkflowRunPayload, eventId, headers)
      case 'pull_request':
        return this.handlePullRequestEvent(payload as PullRequestPayload, eventId, headers)
      default:
        return {
          statusCode: 200,
          body: { accepted: false, eventId, status: 'filtered', filterReason: `Event type '${headers.event}' not supported` },
        }
    }
  }

  // ---------------------------------------------------------------------------
  // workflow_run handling (existing logic, extracted into its own method)
  // ---------------------------------------------------------------------------

  private async handleWorkflowRunEvent(
    payload: WorkflowRunPayload,
    eventId: string,
    headers: { event: string; delivery: string; signature: string },
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const wr = payload.workflow_run
    if (!wr) {
      return { statusCode: 400, body: { error: 'Missing workflow_run in payload' } }
    }

    if (payload.action !== 'completed' || wr.conclusion !== 'failure') {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `action=${payload.action}, conclusion=${wr.conclusion ?? 'null'} (only completed+failure triggers processing)`,
        },
      }
    }

    // --- Actor allowlist filter ---
    const actorLower = wr.actor.login.toLowerCase()
    if (this.config.actorAllowlist.length > 0 && !this.config.actorAllowlist.some(a => a.toLowerCase() === actorLower)) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `Actor '${wr.actor.login}' not in allowlist`,
        },
      }
    }

    // --- Deduplication ---
    const idempotencyKey = computeIdempotencyKey(
      payload.repository.full_name,
      headers.event,
      wr.id,
      payload.action,
      wr.conclusion ?? '',
      wr.run_attempt,
    )

    if (this.dedup.isDuplicate(eventId, idempotencyKey)) {
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: headers.event,
        action: payload.action,
        repo: payload.repository.full_name,
        branch: wr.head_branch,
        workflow: wr.name,
        runId: wr.id,
        runAttempt: wr.run_attempt,
        conclusion: wr.conclusion ?? 'unknown',
        status: 'duplicate',
      })
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'duplicate' },
      }
    }

    // --- Session cap check ---
    if (this.isAtSessionCap()) {
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: headers.event,
        action: payload.action,
        repo: payload.repository.full_name,
        branch: wr.head_branch,
        workflow: wr.name,
        runId: wr.id,
        runAttempt: wr.run_attempt,
        conclusion: wr.conclusion ?? 'unknown',
        status: 'error',
        error: `Max concurrent webhook sessions reached (${this.config.maxConcurrentSessions})`,
      })
      return {
        statusCode: 429,
        body: { error: 'Max concurrent webhook sessions reached', max: this.config.maxConcurrentSessions },
      }
    }

    // --- Pre-allocate session ID and respond 202 ---
    const sessionId = randomUUID()
    const webhookEvent: WebhookEvent = {
      id: eventId,
      idempotencyKey,
      receivedAt: new Date().toISOString(),
      event: headers.event,
      action: payload.action,
      repo: payload.repository.full_name,
      branch: wr.head_branch,
      workflow: wr.name,
      runId: wr.id,
      runAttempt: wr.run_attempt,
      conclusion: wr.conclusion ?? 'unknown',
      status: 'processing',
      sessionId,
    }
    this.recordEvent(webhookEvent)
    this.dedup.recordProcessed(eventId, idempotencyKey)

    // Process asynchronously — don't block the 202 response
    this.processWebhookAsync(payload, webhookEvent, sessionId).catch(err => {
      console.error('[webhook] Async processing error:', err)
      this.updateEventStatus(eventId, 'error', String(err))
    })

    return {
      statusCode: 202,
      body: { accepted: true, eventId, status: 'processing', sessionId },
    }
  }

  // ---------------------------------------------------------------------------
  // pull_request handling (new)
  // ---------------------------------------------------------------------------

  private async handlePullRequestEvent(
    payload: PullRequestPayload,
    eventId: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _headers: { event: string; delivery: string; signature: string },
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const pr = payload.pull_request
    if (!pr) {
      return { statusCode: 400, body: { error: 'Missing pull_request in payload' } }
    }

    // --- Closed/merged handling (cleanup, no review) ---
    if (payload.action === 'closed') {
      return this.handlePrClosed(payload, eventId)
    }

    // --- Action filter ---
    if (!(PR_REVIEW_ACTIONS as readonly string[]).includes(payload.action)) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `PR action '${payload.action}' not supported (only ${PR_REVIEW_ACTIONS.join(', ')})`,
        },
      }
    }

    // --- Draft filter ---
    if (pr.draft) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: 'Draft PRs are skipped',
        },
      }
    }

    // --- Actor allowlist filter ---
    if (this.config.actorAllowlist.length > 0 && !this.config.actorAllowlist.includes(payload.sender.login)) {
      return {
        statusCode: 200,
        body: {
          accepted: false,
          eventId,
          status: 'filtered',
          filterReason: `Actor '${payload.sender.login}' not in allowlist`,
        },
      }
    }

    // --- Deduplication (runs before smart filter so redeliveries are caught cheaply) ---
    const idempotencyKey = computePrIdempotencyKey(
      payload.repository.full_name,
      pr.number,
      payload.action,
      pr.head.sha,
    )

    if (this.dedup.isDuplicate(eventId, idempotencyKey)) {
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: 'pull_request',
        action: payload.action,
        repo: payload.repository.full_name,
        branch: pr.head.ref,
        workflow: 'PR Review',
        runId: pr.number,
        runAttempt: 1,
        conclusion: payload.action,
        status: 'duplicate',
        prNumber: pr.number,
        prTitle: pr.title,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
      })
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'duplicate' },
      }
    }

    // --- Smart filter: skip if this SHA was already reviewed ---
    // Two layers:
    //   1. NO_CODE_CHANGE_ACTIONS (reopened, ready_for_review) — these actions
    //      inherently don't change code, so skip if SHA was already reviewed.
    //   2. All actions — catches redelivered events (e.g. GitHub retry after
    //      dedup TTL expires) where the SHA was already reviewed.
    const prCache = loadPrCache(payload.repository.full_name, pr.number)
    if (prCache && prCache.lastReviewedSha === pr.head.sha) {
      const reason = NO_CODE_CHANGE_ACTIONS.includes(payload.action)
        ? `SHA ${pr.head.sha.slice(0, 7)} already reviewed — no code change since last review`
        : `SHA ${pr.head.sha.slice(0, 7)} already reviewed — possible redeliver`
      this.recordEvent({
        id: eventId,
        idempotencyKey,
        receivedAt: new Date().toISOString(),
        event: 'pull_request',
        action: payload.action,
        repo: payload.repository.full_name,
        branch: pr.head.ref,
        workflow: 'PR Review',
        runId: pr.number,
        runAttempt: 1,
        conclusion: payload.action,
        status: 'filtered',
        filterReason: reason,
        prNumber: pr.number,
        prTitle: pr.title,
        headSha: pr.head.sha,
        baseBranch: pr.base.ref,
      })
      console.log(`[webhook] Smart filter: ${payload.action} for ${payload.repository.full_name}#${pr.number} skipped — ${reason}`)
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'filtered', filterReason: reason },
      }
    }

    // --- Pre-allocate session ID ---
    const sessionId = randomUUID()
    const debounceMs = this.config.prDebounceMs

    const makeEvent = (status: WebhookEventStatus): WebhookEvent => ({
      id: eventId,
      idempotencyKey,
      receivedAt: new Date().toISOString(),
      event: 'pull_request',
      action: payload.action,
      repo: payload.repository.full_name,
      branch: pr.head.ref,
      workflow: 'PR Review',
      runId: pr.number,
      runAttempt: 1,
      conclusion: payload.action,
      status,
      sessionId,
      prNumber: pr.number,
      prTitle: pr.title,
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
    })

    // --- Debounce: wait before processing to coalesce rapid events ---
    if (debounceMs > 0) {
      const webhookEvent = makeEvent('debounced')
      this.recordEvent(webhookEvent)
      // Record dedup early (before timer fires) so GitHub retries during the
      // debounce window are caught as duplicates rather than spawning a second timer.
      this.dedup.recordProcessed(eventId, idempotencyKey)

      const debounceKey = `${payload.repository.full_name}#${pr.number}`
      const existing = this.pendingDebounce.get(debounceKey)
      if (existing) {
        clearTimeout(existing.timer)
        this.updateEventStatus(existing.event.id, 'superseded', 'Superseded by newer event during debounce')
        console.log(`[webhook] Debounce: replacing pending event ${existing.event.id} with ${eventId} for PR ${debounceKey}`)
      }

      const timer = setTimeout(() => {
        this.pendingDebounce.delete(debounceKey)
        this.fireDebouncedPrEvent(payload, webhookEvent, sessionId)
      }, debounceMs)
      if (timer.unref) timer.unref()

      this.pendingDebounce.set(debounceKey, { payload, event: webhookEvent, sessionId, timer })

      console.log(`[webhook] PR ${debounceKey} debounced for ${debounceMs}ms (event ${eventId})`)
      return {
        statusCode: 202,
        body: { accepted: true, eventId, status: 'debounced', sessionId },
      }
    }

    // --- No debounce: process immediately (prDebounceMs = 0) ---
    // Supersede BEFORE recording the new event so we don't supersede ourselves.
    this.supersedePrSessions(payload.repository.full_name, pr.number)

    if (this.isAtSessionCap()) {
      this.recordEvent(makeEvent('error'))
      this.updateEventStatus(eventId, 'error', `Max concurrent webhook sessions reached (${this.config.maxConcurrentSessions})`)
      // Don't record in dedup — let GitHub retry when capacity frees up
      return {
        statusCode: 429,
        body: { error: 'Max concurrent webhook sessions reached', max: this.config.maxConcurrentSessions },
      }
    }

    const webhookEvent = makeEvent('processing')
    this.recordEvent(webhookEvent)
    this.dedup.recordProcessed(eventId, idempotencyKey)

    this.processPullRequestAsync(payload, webhookEvent, sessionId).catch(err => {
      console.error('[webhook] PR async processing error:', err)
      if (this.getEvent(eventId)?.status !== 'superseded') {
        this.updateEventStatus(eventId, 'error', String(err))
      }
    })

    return {
      statusCode: 202,
      body: { accepted: true, eventId, status: 'processing', sessionId },
    }
  }

  /**
   * Async background processing for pull_request events:
   * fetch PR context, create workspace, create session, send review prompt.
   */
  private async processPullRequestAsync(
    payload: PullRequestPayload,
    event: WebhookEvent,
    sessionId: string,
    opts?: { forceProvider?: CodingProvider; isFallback?: boolean },
  ): Promise<void> {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const repoName = payload.repository.name

    const { provider: reviewProvider, model: reviewModel } = opts?.forceProvider
      ? {
          provider: opts.forceProvider,
          model: opts.forceProvider === 'claude' ? this.config.prReviewClaudeModel : this.config.prReviewOpencodeModel,
        }
      : this.resolvePrReviewProvider()
    const isFallback = !!opts?.isFallback
    console.log(`[webhook] Processing PR: ${repo} #${pr.number} "${pr.title}" (${payload.action}) — reviewer: ${reviewProvider} (${reviewModel})${isFallback ? ' [split-fallback]' : ''}`)

    // --- Fetch PR context (all calls degrade gracefully) ---
    const [diffResult, fileList, commitMessages, reviewComments, reviews, priorCache, existingCommentId] = await Promise.all([
      fetchPrDiff(repo, pr.number),
      fetchPrFiles(repo, pr.number),
      fetchPrCommits(repo, pr.number),
      fetchPrReviewComments(repo, pr.number),
      fetchPrReviews(repo, pr.number),
      Promise.resolve(loadPrCache(repo, pr.number)),
      fetchExistingReviewComment(repo, pr.number),
    ])
    const cachePath = ensureCacheDir(repo, pr.number)

    // Check if superseded while fetching PR context
    if (this.getEvent(event.id)?.status === 'superseded') {
      console.log(`[webhook] Event ${event.id} was superseded, aborting PR processing`)
      return
    }

    const context: PullRequestContext = {
      repo,
      prNumber: pr.number,
      prTitle: pr.title,
      prBody: pr.body ?? '',
      prUrl: pr.html_url,
      author: pr.user.login,
      headBranch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      baseSha: pr.base.sha,
      beforeSha: payload.before,
      action: payload.action as PullRequestContext['action'],
      changedFiles: pr.changed_files,
      additions: pr.additions,
      deletions: pr.deletions,
      diff: diffResult.diff,
      fileList,
      commitMessages,
      reviewComments,
      reviews,
      reviewProvider,
      reviewModel,
    }

    // --- Create workspace ---
    let workspacePath: string
    try {
      workspacePath = await createWorkspace(
        sessionId,
        repo,
        pr.head.repo?.clone_url ?? payload.repository.clone_url,
        pr.head.ref,
        pr.head.sha,
      )
    } catch (err) {
      console.error(`[webhook] Failed to create workspace for PR ${repo}#${pr.number}:`, err)
      // Don't overwrite 'superseded' status if a newer event already took over
      if (this.getEvent(event.id)?.status !== 'superseded') {
        this.updateEventStatus(event.id, 'error', `Workspace creation failed: ${err}`)
      }
      return
    }

    // Check if superseded while creating workspace
    if (this.getEvent(event.id)?.status === 'superseded') {
      console.log(`[webhook] Event ${event.id} was superseded during workspace creation, cleaning up`)
      cleanupWorkspace(sessionId)
      return
    }

    // --- Create session ---
    const groupDir = `${REPOS_ROOT}/${repoName}`
    let sessionName: string
    if (payload.action === 'synchronize') {
      sessionName = `PR #${pr.number}: ${pr.title} (update @${pr.head.sha.slice(0, 7)})`
    } else if (payload.action === 'reopened') {
      sessionName = `PR #${pr.number}: ${pr.title} (reopened)`
    } else {
      sessionName = `PR #${pr.number}: ${pr.title}`
    }

    const sessionOptions: CreateSessionOptions = {
      source: 'webhook',
      id: sessionId,
      groupDir,
      provider: reviewProvider,
      model: reviewModel,
    }

    if (reviewProvider === 'claude') {
      // Narrowed Claude allowedTools mirroring the OpenCode sandbox:
      //   - git: read-only subcommands only (no commit/push/reset/rebase/clean)
      //   - gh: scoped to PR/review endpoints
      //   - Write: needed to write the review body file and PR cache JSON
      //   - context7 MCP: the only allowed network lookup (library docs)
      //   - no WebFetch / WebSearch — general web access is an exfil vector
      //
      // Note: Claude CLI's multi-word prefix patterns like `Bash(git diff:*)`
      // occasionally produce false "requires approval" errors on command variants
      // the model tries first — but the model retries and the review completes
      // successfully. Verified empirically on PR #15.
      //
      // `Bash(gh api:*)` is intentionally broader than OpenCode's per-endpoint
      // patterns. Codekin's approval hook uses literal word-boundary prefix matching
      // which doesn't work with slashes (`gh api repos/owner/...` has no space
      // after `repos`). The prompt's explicit gh-endpoint policy is what keeps
      // the model from calling `gh api user`, `gh api /orgs/*`, etc.
      //
      // We pass skipDefaultBashGit to prevent claude-process from prepending
      // the default broad Bash(git:*), which would defeat the narrowing.
      sessionOptions.skipDefaultBashGit = true
      sessionOptions.allowedTools = [
        // git read-only
        'Bash(git status:*)',
        'Bash(git diff:*)',
        'Bash(git log:*)',
        'Bash(git show:*)',
        'Bash(git blame:*)',
        'Bash(git rev-parse:*)',
        'Bash(git ls-files:*)',
        'Bash(git branch:*)',
        'Bash(git config:*)',
        // gh review-specific
        'Bash(gh pr view:*)',
        'Bash(gh pr diff:*)',
        'Bash(gh pr review:*)',
        'Bash(gh api:*)',
        // file/cache write
        'Write',
        // library docs lookup
        'mcp__plugin_context7_context7__resolve-library-id',
        'mcp__plugin_context7_context7__query-docs',
      ]
      sessionOptions.addDirs = [dirname(cachePath)]
    } else {
      // OpenCode uses opencode.json in the workspace for scoped permissions.
      // Write a config that mirrors Claude's allowedTools — allow gh/git bash,
      // file reads/edits, and access to the PR cache directory.
      // Note: OpenCode's pattern matching evaluates rules in order, last match wins.
      // The catch-all "*": "deny" MUST come first so specific allows override it.
      // external_directory and doom_loop default to "ask" — we explicitly deny them
      // by default to prevent bypassPermissions from auto-approving arbitrary access.
      const opencodeConfig = {
        $schema: 'https://opencode.ai/config.json',
        permission: {
          bash: {
            '*': 'deny',
            // gh subcommands needed for PR review — narrowed to block gh auth,
            // gh repo clone, gh secret, gh workflow, gh api user, etc.
            'gh pr view *': 'allow',
            'gh pr diff *': 'allow',
            'gh pr review *': 'allow',
            // gh api scoped to repo-level PR/issue endpoints only.
            // This blocks `gh api user`, `gh api /user`, `gh api /repos/../actions/secrets`, etc.
            // while still allowing everything the review flow needs:
            //   GET/POST/PATCH repos/*/issues/*/comments, repos/*/issues/comments/*
            //   GET/POST     repos/*/pulls/*/comments
            //   GET          repos/*/pulls/*/reviews
            //   PUT          repos/*/pulls/*/reviews/*/dismissals
            'gh api repos/*/issues/*/comments': 'allow',
            'gh api repos/*/issues/*/comments *': 'allow',
            'gh api repos/*/issues/comments/*': 'allow',
            'gh api repos/*/issues/comments/* *': 'allow',
            'gh api repos/*/pulls/*/comments': 'allow',
            'gh api repos/*/pulls/*/comments *': 'allow',
            'gh api repos/*/pulls/*/reviews': 'allow',
            'gh api repos/*/pulls/*/reviews *': 'allow',
            'gh api repos/*/pulls/*/reviews/*': 'allow',
            'gh api repos/*/pulls/*/reviews/* *': 'allow',
            'gh api repos/*/pulls/*/reviews/*/dismissals': 'allow',
            'gh api repos/*/pulls/*/reviews/*/dismissals *': 'allow',
            // git read-only subcommands only — no checkout/commit/push/reset/rebase/clean
            'git status': 'allow',
            'git status *': 'allow',
            'git diff': 'allow',
            'git diff *': 'allow',
            'git log': 'allow',
            'git log *': 'allow',
            'git show': 'allow',
            'git show *': 'allow',
            'git blame *': 'allow',
            'git rev-parse *': 'allow',
            'git ls-files': 'allow',
            'git ls-files *': 'allow',
            'git branch': 'allow',
            'git branch --show-current': 'allow',
            'git config --get *': 'allow',
            // NO shell primitives (cat/ls/head/tail/wc/mkdir/echo/...) — even when
            // labeled "read-only" they can write arbitrary files via shell redirection:
            //   cat <<EOF > ~/.ssh/authorized_keys  (exfil via SSH key)
            //   echo X >> ~/.bashrc                 (persistence)
            //   head file > /tmp/stage              (stage attack payload)
            // OpenCode's `external_directory: deny` scopes the built-in read/write/edit
            // tools but NOT raw bash commands — bash runs with the full filesystem
            // permissions of the user running codekin. For file operations the model
            // MUST use the built-in `read` / `write` / `edit` / `grep` tools, which are
            // path-scoped by external_directory.
          },
          read: 'allow',
          edit: 'allow',
          write: 'allow',
          grep: 'allow',
          // webfetch denied — review should rely on PR context only. General web
          // access is an exfil vector for prompt-injection attacks embedded in PR content.
          webfetch: 'deny',
          external_directory: { '*': 'deny', [dirname(cachePath) + '/**']: 'allow' },
          doom_loop: 'deny',
        },
      }
      writeFileSync(join(workspacePath, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2))
      console.log(`[webhook] Wrote opencode.json permissions config to ${workspacePath}`)
      // bypassPermissions auto-approves permission.asked SSE events — but only
      // for permissions set to "ask" (the default for external_directory, etc.).
      // OpenCode enforces "deny" rules server-side BEFORE emitting permission.asked,
      // so bypassPermissions cannot override the deny rules in opencode.json above.
      // See: https://opencode.ai/docs/permissions/
      // This ensures automated sessions don't hang on "ask" prompts while the
      // opencode.json deny rules still block unauthorized bash commands.
      sessionOptions.permissionMode = 'bypassPermissions'
    }

    this.sessions.create(sessionName, workspacePath, sessionOptions)

    // Track this session so onSessionExit / onSessionResult can look up
    // which provider ran, whether this is a split-mode fallback retry, and
    // the payload needed to spin up a fallback session on failure.
    this.reviewSessions.set(sessionId, {
      eventId: event.id,
      provider: reviewProvider,
      model: reviewModel,
      payload,
      isFallback,
    })

    console.log(`[webhook] PR session created: ${sessionName} (${sessionId})`)
    this.updateEventStatus(event.id, 'session_created')

    // --- Broadcast webhook event ---
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrReviewPrompt(context, workspacePath, {
      priorCache: priorCache ?? undefined,
      cachePath,
      existingCommentId,
    })
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] PR review prompt sent to session ${sessionId}, session is processing...`)
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve the provider and model for a PR review session based on config.
   *
   * `split` mode is **random A/B selection**: each review independently flips a
   * 50/50 coin between Claude and OpenCode. This is intentionally NOT alternation —
   * two consecutive reviews may land on the same provider. The goal is unbiased
   * sampling over many reviews to compare output quality between models, not
   * guaranteed interleaving. If you need strict alternation, use `claude` or
   * `opencode` explicitly and toggle by config.
   */
  private resolvePrReviewProvider(): { provider: 'claude' | 'opencode'; model: string } {
    if (this.config.prReviewProvider === 'opencode') {
      return { provider: 'opencode', model: this.config.prReviewOpencodeModel }
    }
    if (this.config.prReviewProvider === 'split') {
      // Random A/B sampling — see JSDoc above for rationale.
      return Math.random() < 0.5
        ? { provider: 'claude', model: this.config.prReviewClaudeModel }
        : { provider: 'opencode', model: this.config.prReviewOpencodeModel }
    }
    return { provider: 'claude', model: this.config.prReviewClaudeModel }
  }

  // ---------------------------------------------------------------------------
  // Provider health + backlog integration
  // ---------------------------------------------------------------------------

  /**
   * Read-only snapshot of the current provider health state. Used by the
   * `/api/webhooks/health` endpoint.
   */
  getProviderHealth(): ProviderHealthFile {
    return this.providerHealth.getAll()
  }

  /** Current size of the retry backlog. Used by `/api/webhooks/health`. */
  getBacklogSize(): number {
    return this.backlog.size()
  }

  /**
   * Called from the exit handler when a review session exits non-zero.
   * Classifies the error and takes one of three paths:
   *
   * 1. `other` — keep existing behavior, just mark the event as `'error'`.
   * 2. `rate_limit` / `auth_failure` in split mode, fallback not yet tried —
   *    mark provider unhealthy, supersede the original event, and spin up
   *    a new session with the OTHER provider (re-fetches PR context, new
   *    workspace, same payload).
   * 3. `rate_limit` / `auth_failure` in fixed mode, OR split mode with the
   *    fallback also failing — mark provider unhealthy, enqueue the event
   *    in the backlog, post the appropriate PR comment, mark event `'error'`.
   */
  private async handleReviewFailure(
    event: WebhookEvent,
    sessionId: string,
    errorText: string,
    reviewInfo: ReviewSessionInfo | undefined,
  ): Promise<void> {
    const category = classifyProviderError(errorText)

    // Always clean up the workspace for the failed session.
    cleanupWorkspace(sessionId)

    if (category === 'other' || !reviewInfo) {
      // Unknown failure or we never tracked the session — just mark the event as error.
      this.updateEventStatus(event.id, 'error', errorText.slice(0, 500))
      console.log(`[webhook] Event ${event.id} → error (session ${sessionId}, category=${category}, classified: no action)`)
      return
    }

    const { provider, model, payload, isFallback } = reviewInfo

    // Mark this provider unhealthy. Successful reviews later will flip it back.
    this.providerHealth.markUnhealthy(provider, category, errorText)
    console.warn(`[webhook] Provider ${provider} (${model}) failed with ${category}: ${errorText.slice(0, 200)}`)

    // Split-mode fallback: if this was a split-mode selection and we haven't
    // already tried the other provider on this event, spin up a fallback.
    const canFallback = this.config.prReviewProvider === 'split' && !isFallback
    if (canFallback) {
      const otherProvider: CodingProvider = provider === 'claude' ? 'opencode' : 'claude'
      console.log(`[webhook] Split-mode fallback: retrying event ${event.id} with ${otherProvider}`)

      // Supersede the original event so it doesn't show as 'error'.
      this.updateEventStatus(event.id, 'superseded', `Falling back from ${provider} to ${otherProvider} (${category})`)

      // Create a NEW event + session for the fallback. Reusing the same
      // eventId would be confusing and the workspace has to be re-created
      // anyway (the original one was just cleaned up above).
      const newEvent: WebhookEvent = {
        ...event,
        id: randomUUID(),
        receivedAt: new Date().toISOString(),
        status: 'processing',
      }
      // Clone the sessionId too so identity maps stay consistent.
      const newSessionId = randomUUID()
      newEvent.sessionId = newSessionId
      this.recordEvent(newEvent)

      this.processPullRequestAsync(payload, newEvent, newSessionId, {
        forceProvider: otherProvider,
        isFallback: true,
      }).catch(err => {
        console.error('[webhook] Fallback session error:', err)
        if (this.getEvent(newEvent.id)?.status !== 'superseded') {
          this.updateEventStatus(newEvent.id, 'error', String(err))
        }
      })
      return
    }

    // Fixed mode OR split-mode fallback also failed — backlog + PR comment.
    console.log(`[webhook] Backlogging event ${event.id} — ${category} on ${provider}${isFallback ? ' (fallback)' : ''}`)

    const entry = this.backlog.enqueue({
      repo: event.repo,
      prNumber: event.runId,
      headSha: event.headSha ?? payload.pull_request.head.sha,
      payload,
      reason: category,
      failedProvider: isFallback ? 'both' : provider,
    })

    // Mark the webhook event as error with a descriptive reason so /api/webhooks/events shows it.
    this.updateEventStatus(
      event.id,
      'error',
      `${category} on ${provider}${isFallback ? ' (after split fallback)' : ''} — backlogged, retryAfter=${entry.retryAfter}`,
    )

    // Post a user-visible comment to the PR explaining the failure and next retry time.
    const providerDisplay = provider === 'opencode' ? `OpenCode (${model})` : `Claude (${model})`
    await postProviderUnavailableComment({
      repo: event.repo,
      prNumber: event.runId,
      reason: category,
      providerDisplay,
      errorText,
      retryAfter: entry.retryAfter,
    })
  }

  /**
   * Periodically scans the backlog for retry-ready entries, drops those
   * whose PRs have closed/merged, and re-fires the rest through the normal
   * event flow (bypassing debounce). Called from a setInterval in the
   * constructor.
   */
  private async runRetryWorker(): Promise<void> {
    if (!this.ghHealthy) return  // gh CLI unavailable — can't check PR state

    const ready = this.backlog.getReady()
    if (ready.length === 0) return

    for (const entry of ready) {
      try {
        const state = await fetchPrState(entry.repo, entry.prNumber)
        if (state === 'closed') {
          console.log(`[webhook-backlog] Dropping ${entry.id} — PR ${entry.repo}#${entry.prNumber} is closed/merged`)
          this.backlog.remove(entry.id)
          continue
        }
        if (state === undefined) {
          // gh failed — leave the entry in place, try again next tick.
          console.warn(`[webhook-backlog] Could not determine PR state for ${entry.repo}#${entry.prNumber}, will retry next tick`)
          continue
        }

        // PR is still open — re-fire the event.
        console.log(`[webhook-backlog] Retrying ${entry.repo}#${entry.prNumber} (attempt ${entry.retryCount + 1})`)
        this.backlog.remove(entry.id)

        // Build a fresh WebhookEvent for the retry.
        const newEvent: WebhookEvent = {
          id: randomUUID(),
          idempotencyKey: computePrIdempotencyKey(entry.repo, entry.prNumber, entry.payload.action, entry.headSha),
          receivedAt: new Date().toISOString(),
          event: 'pull_request',
          action: entry.payload.action,
          repo: entry.repo,
          branch: entry.payload.pull_request.head.ref,
          workflow: 'PR Review',
          runId: entry.prNumber,
          runAttempt: 1,
          conclusion: entry.payload.action,
          status: 'processing',
          sessionId: undefined,  // will be set below
          prNumber: entry.prNumber,
          prTitle: entry.payload.pull_request.title,
          headSha: entry.headSha,
          baseBranch: entry.payload.pull_request.base.ref,
        }
        const newSessionId = randomUUID()
        newEvent.sessionId = newSessionId
        this.recordEvent(newEvent)

        // Don't await — let it run in the background. If it fails again,
        // handleReviewFailure will create a fresh backlog entry.
        this.processPullRequestAsync(entry.payload, newEvent, newSessionId).catch(err => {
          console.error('[webhook-backlog] Retry session error:', err)
          if (this.getEvent(newEvent.id)?.status !== 'superseded') {
            this.updateEventStatus(newEvent.id, 'error', String(err))
          }
        })
      } catch (err) {
        console.error(`[webhook-backlog] Failed to process retry for ${entry.id}:`, err)
      }
    }
  }

  /**
   * Handle a PR being closed or merged: kill active sessions and archive/delete cache.
   */
  private handlePrClosed(
    payload: PullRequestPayload,
    eventId: string,
  ): { statusCode: number; body: Record<string, unknown> } {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const merged = pr.merged

    console.log(`[webhook] PR ${repo}#${pr.number} ${merged ? 'merged' : 'closed'}, cleaning up`)

    // Record the event for observability
    this.recordEvent({
      id: eventId,
      idempotencyKey: computePrIdempotencyKey(repo, pr.number, 'closed', pr.head.sha),
      receivedAt: new Date().toISOString(),
      event: 'pull_request',
      action: 'closed',
      repo,
      branch: pr.head.ref,
      workflow: 'PR Review',
      runId: pr.number,
      runAttempt: 1,
      conclusion: merged ? 'merged' : 'closed',
      status: 'completed',
      prNumber: pr.number,
      prTitle: pr.title,
      headSha: pr.head.sha,
      baseBranch: pr.base.ref,
    })

    // Cancel pending debounce and kill any active review sessions for this PR
    this.cancelPendingDebounce(repo, pr.number, merged ? 'PR merged' : 'PR closed')
    this.supersedePrSessions(repo, pr.number, merged ? 'PR merged' : 'PR closed')

    // Archive or delete the cache file
    if (merged) {
      archivePrCache(repo, pr.number)
    } else {
      deletePrCache(repo, pr.number)
    }

    return {
      statusCode: 200,
      body: {
        accepted: true,
        eventId,
        status: 'processed',
        action: merged ? 'merged' : 'closed',
      },
    }
  }

  /**
   * Called when the debounce timer fires for a PR event.
   * Runs the deferred supersede → cap check → async processing pipeline.
   */
  private fireDebouncedPrEvent(
    payload: PullRequestPayload,
    event: WebhookEvent,
    sessionId: string,
  ): void {
    const pr = payload.pull_request
    const repo = payload.repository.full_name

    console.log(`[webhook] Debounce fired for ${repo}#${pr.number} (event ${event.id})`)

    // Supersede any active session for this PR
    this.supersedePrSessions(repo, pr.number)

    // Cap check — we already responded 202 so we can't return 429; mark as error instead
    if (this.isAtSessionCap()) {
      this.updateEventStatus(event.id, 'error', `Max concurrent webhook sessions reached (${this.config.maxConcurrentSessions})`)
      console.warn(`[webhook] Cap reached when debounce fired for ${repo}#${pr.number}, dropping event ${event.id}`)
      return
    }

    // Transition from debounced → processing.
    // Reset receivedAt so the watchdog timeout counts from processing start,
    // not from when the webhook originally arrived (which includes debounce time).
    this.updateEventStatus(event.id, 'processing')
    const liveEvent = this.getEvent(event.id)
    if (liveEvent) liveEvent.receivedAt = new Date().toISOString()

    this.processPullRequestAsync(payload, event, sessionId).catch(err => {
      console.error('[webhook] PR async processing error:', err)
      if (this.getEvent(event.id)?.status !== 'superseded') {
        this.updateEventStatus(event.id, 'error', String(err))
      }
    })
  }

  /**
   * Cancel a pending debounce timer for a PR, if one exists.
   * Used when the PR is closed/merged or the server is shutting down.
   */
  private cancelPendingDebounce(repo: string, prNumber: number, reason: string): void {
    const key = `${repo}#${prNumber}`
    const pending = this.pendingDebounce.get(key)
    if (pending) {
      clearTimeout(pending.timer)
      this.updateEventStatus(pending.event.id, 'superseded', reason)
      this.pendingDebounce.delete(key)
      console.log(`[webhook] Cancelled pending debounce for ${key}: ${reason}`)
    }
  }

  /**
   * Persist all currently-pending debounced events to disk so they survive a restart.
   * Called from shutdown(). GitHub already received a 202 for these, so we must not
   * lose them — they will be restored and fired on next startup.
   */
  private savePendingDebounces(): void {
    if (this.pendingDebounce.size === 0) {
      // Only delete a stale file if restore actually ran this lifecycle.
      // Otherwise an unhealthy-startup path (e.g. `gh` unavailable) would silently
      // drop events persisted by a prior healthy run — GitHub won't retry them.
      if (this.debounceFileConsumed && existsSync(PENDING_DEBOUNCE_FILE)) {
        try { unlinkSync(PENDING_DEBOUNCE_FILE) } catch { /* best effort */ }
      }
      return
    }

    const records: PendingDebounceRecord[] = []
    for (const [key, pending] of this.pendingDebounce) {
      records.push({
        key,
        payload: pending.payload,
        event: pending.event,
        sessionId: pending.sessionId,
      })
    }

    try {
      mkdirSync(dirname(PENDING_DEBOUNCE_FILE), { recursive: true })
      const tmp = PENDING_DEBOUNCE_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify({ records }, null, 2), { mode: 0o600 })
      renameSync(tmp, PENDING_DEBOUNCE_FILE)
      console.log(`[webhook] Saved ${records.length} pending debounce(s) to disk for recovery`)
    } catch (err) {
      console.error('[webhook] Failed to persist pending debounces:', err)
    }
  }

  /**
   * Restore pending debounced events from disk and fire them immediately.
   * Called from checkHealth() after gh is confirmed available. The events were
   * already 202'd to GitHub, so any delay risks further lag — fire now rather
   * than re-arming the debounce timer.
   */
  private restorePendingDebounces(): void {
    // Mark that restore has run this lifecycle, even if the file doesn't exist.
    // This lets savePendingDebounces() safely delete stale files later.
    this.debounceFileConsumed = true

    if (!existsSync(PENDING_DEBOUNCE_FILE)) return

    let records: PendingDebounceRecord[] = []
    try {
      const raw = readFileSync(PENDING_DEBOUNCE_FILE, 'utf-8')
      const data = JSON.parse(raw) as { records?: PendingDebounceRecord[] }
      if (Array.isArray(data.records)) records = data.records
    } catch (err) {
      console.error('[webhook] Failed to load pending debounces:', err)
      return
    }

    // Delete the file now — we're about to process these entries, and if
    // processing fails we don't want to retry-loop on the next startup.
    try { unlinkSync(PENDING_DEBOUNCE_FILE) } catch { /* best effort */ }

    if (records.length === 0) return

    console.log(`[webhook] Restoring ${records.length} pending debounce(s) from disk`)
    for (const rec of records) {
      // Per-record try/catch so one malformed entry can't throw through checkHealth()
      // and become an unhandled promise rejection in ws-server.ts.
      try {
        // Skip restore if the PR was reviewed during the downtime window
        // (e.g. via a manual review or a different Codekin instance).
        // Mirrors the smart SHA filter in handlePullRequestEvent.
        if (rec.event.headSha) {
          const cache = loadPrCache(rec.event.repo, rec.event.runId)
          if (cache && cache.lastReviewedSha === rec.event.headSha) {
            console.log(`[webhook] Skipping restored event ${rec.event.id} for ${rec.key} — SHA ${rec.event.headSha.slice(0, 7)} already reviewed`)
            this.recordEvent({
              ...rec.event,
              status: 'filtered',
              filterReason: `SHA ${rec.event.headSha.slice(0, 7)} already reviewed during downtime`,
            })
            continue
          }
        }

        // Re-record the event in the ring buffer (it was lost on shutdown)
        this.recordEvent(rec.event)
        // Fire immediately — no more waiting, GitHub has been waiting long enough
        console.log(`[webhook] Resuming debounced event ${rec.event.id} for ${rec.key}`)
        this.fireDebouncedPrEvent(rec.payload, rec.event, rec.sessionId)
      } catch (err) {
        console.error(`[webhook] Failed to restore debounce record ${rec.key}:`, err)
      }
    }
  }

  /**
   * Find and terminate any active sessions for the same PR.
   * Called before creating a new session so a new push supersedes the old review.
   */
  private supersedePrSessions(repo: string, prNumber: number, reason = 'Superseded by new push'): void {
    const activeStatuses: WebhookEventStatus[] = ['processing', 'session_created']
    const activeEvents = this.getEvents().filter(
      e => e.repo === repo && e.prNumber === prNumber && activeStatuses.includes(e.status)
    )

    for (const oldEvent of activeEvents) {
      console.log(`[webhook] Superseding PR session: event=${oldEvent.id} session=${oldEvent.sessionId} (PR ${repo}#${prNumber})`)

      // Mark superseded FIRST so the exit listener won't overwrite the status
      this.updateEventStatus(oldEvent.id, 'superseded', reason)

      // Delete the session (kills process, cleans up workspace)
      if (oldEvent.sessionId) {
        this.sessions.delete(oldEvent.sessionId)
      }
    }
  }

  /**
   * Check if the webhook session concurrency cap has been reached.
   */
  private isAtSessionCap(): boolean {
    const activeWebhookSessions = this.sessions.list().filter(s => s.source === 'webhook' && s.active).length
    const processingEvents = this.countByStatus('processing')
    const effectiveConcurrency = activeWebhookSessions + processingEvents
    return effectiveConcurrency >= this.config.maxConcurrentSessions
  }

  /**
   * Async background processing for workflow_run events:
   * fetch logs, create workspace, create session, send prompt.
   */
  private async processWebhookAsync(
    payload: WorkflowRunPayload,
    event: WebhookEvent,
    sessionId: string,
  ): Promise<void> {
    const wr = payload.workflow_run
    const repo = payload.repository.full_name
    const repoName = payload.repository.name
    const logLines = this.config.logLinesToInclude

    console.log(`[webhook] Processing: ${repo} / ${wr.name} run #${wr.run_number} (${wr.head_branch})`)

    // --- Fetch failure context (all calls degrade gracefully) ---
    const [failedLogs, jobs, annotations, commitMessage] = await Promise.all([
      fetchFailedLogs(repo, wr.id, logLines),
      fetchJobs(repo, wr.id),
      fetchAnnotations(repo, wr.check_suite_id),
      fetchCommitMessage(repo, wr.head_sha),
    ])

    // Fetch PR title if applicable
    let pullRequest: FailureContext['pullRequest'] | undefined
    if (wr.pull_requests.length > 0) {
      const pr = wr.pull_requests[0]
      const title = await fetchPRTitle(repo, pr.number)
      pullRequest = { number: pr.number, title: title || undefined }
    }

    const context: FailureContext = {
      repo,
      repoName,
      branch: wr.head_branch,
      headSha: wr.head_sha,
      workflowName: wr.name,
      runId: wr.id,
      runNumber: wr.run_number,
      runAttempt: wr.run_attempt,
      actor: wr.actor.login,
      event: wr.event,
      htmlUrl: wr.html_url,
      failedLogs,
      annotations,
      jobs,
      pullRequest,
      commitMessage: commitMessage || undefined,
    }

    // --- Create workspace ---
    let workspacePath: string
    try {
      workspacePath = await createWorkspace(
        sessionId,
        repo,
        payload.repository.clone_url,
        wr.head_branch,
        wr.head_sha,
      )
    } catch (err) {
      console.error(`[webhook] Failed to create workspace for ${repo}:`, err)
      this.updateEventStatus(event.id, 'error', `Workspace creation failed: ${err}`)
      return
    }

    // --- Create session ---
    const groupDir = `${REPOS_ROOT}/${repoName}`
    const sessionName = `webhook/${repoName}/${wr.head_branch}/${wr.name}`
    this.sessions.create(sessionName, workspacePath, {
      source: 'webhook',
      id: sessionId,
      groupDir,
    })

    console.log(`[webhook] Session created: ${sessionName} (${sessionId})`)
    this.updateEventStatus(event.id, 'session_created')

    // --- Broadcast webhook event to all connected WS clients ---
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrompt(context, logLines)
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] Prompt sent to session ${sessionId}, session is processing...`)
  }

  /**
   * Broadcast a webhook event notification to all connected WebSocket clients.
   * Sent globally (not scoped to the new session) so any open browser tab can
   * display the incoming webhook badge regardless of which session is active.
   */
  private broadcastWebhookEvent(event: WebhookEvent): void {
    const allSessions = this.sessions.list()
    const msg: WsServerMessage = {
      type: 'webhook_event',
      event: event.event,
      repo: event.repo,
      branch: event.branch,
      workflow: event.workflow,
      conclusion: event.conclusion,
      status: event.status,
      sessionId: event.sessionId,
    }

    for (const sessionInfo of allSessions) {
      const session = this.sessions.get(sessionInfo.id)
      if (session) {
        this.sessions.broadcast(session, msg)
      }
    }
  }

  getConfig(): WebhookConfig {
    return {
      enabled: this.config.enabled,
      maxConcurrentSessions: this.config.maxConcurrentSessions,
      logLinesToInclude: this.config.logLinesToInclude,
      actorAllowlist: this.config.actorAllowlist,
      prDebounceMs: this.config.prDebounceMs,
      prReviewProvider: this.config.prReviewProvider,
      prReviewClaudeModel: this.config.prReviewClaudeModel,
      prReviewOpencodeModel: this.config.prReviewOpencodeModel,
    }
  }

  shutdown(): void {
    // Persist pending debounces to disk BEFORE clearing timers — they were already
    // 202'd to GitHub, so losing them would drop the webhook silently.
    this.savePendingDebounces()

    // Cancel all pending debounce timers (state was saved above, so this is safe)
    for (const [, pending] of this.pendingDebounce) {
      clearTimeout(pending.timer)
    }
    this.pendingDebounce.clear()

    // Stop the backlog retry worker
    if (this.retryWorkerTimer) {
      clearInterval(this.retryWorkerTimer)
      this.retryWorkerTimer = null
    }

    // Flush the provider-health and backlog files
    this.providerHealth.shutdown()
    this.backlog.shutdown()

    super.shutdown()
    this.dedup.shutdown()
  }
}
