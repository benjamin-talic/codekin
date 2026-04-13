/**
 * GitHub webhook handler for automated CI failure triage and PR code review.
 *
 * Processes incoming webhook events:
 *   - `workflow_run` (completed+failed) → spawns Claude session for CI diagnosis
 *   - `pull_request` (opened/synchronize/reopened/ready_for_review) → spawns Claude session for code review
 *
 * Event lifecycle / state machine:
 *   received → (filtered/duplicate/capped)
 *   received → processing  — event accepted, async fetch started
 *            → session_created — workspace ready, session spawned, prompt sent
 *            → completed | error  — Claude exited 0 (success) or non-zero (failure)
 *
 * The 'processing' state bridges the async gap between accepting the webhook
 * (202 response) and the session being created.  A watchdog marks events stuck
 * in 'processing' as 'error' after PROCESSING_TIMEOUT_MS to prevent the
 * concurrency cap from leaking on partial failures.
 */

import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { CreateSessionOptions, SessionManager } from './session-manager.js'
import { verifyHmacSignature } from './crypto-utils.js'
import type { WsServerMessage } from './types.js'
import type { CodingProvider } from './coding-process.js'
import type { WebhookConfig, WebhookEvent, WebhookEventStatus, WorkflowRunPayload, FailureContext, PullRequestPayload, PullRequestContext, ProviderHealthFile } from './webhook-types.js'
import type { FullWebhookConfig } from './webhook-config.js'
import { WebhookDedup, computeIdempotencyKey, computePrIdempotencyKey } from './webhook-dedup.js'
import { checkGhHealth, fetchFailedLogs, fetchJobs, fetchAnnotations, fetchCommitMessage, fetchPRTitle } from './webhook-github.js'
import {
  fetchPrDiff, fetchPrFiles, fetchPrCommits, fetchPrReviewComments, fetchPrReviews,
  fetchExistingReviewComment, fetchPrState, postProviderUnavailableComment,
} from './webhook-pr-github.js'
import { buildPrReviewPrompt } from './webhook-pr-prompt.js'
import { loadPrCache, ensureCacheDir, archivePrCache, deletePrCache } from './webhook-pr-cache.js'
import { buildPrompt } from './webhook-prompt.js'
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

/** Tracking info for an active webhook review session. */
interface ReviewSessionInfo {
  eventId: string
  provider: CodingProvider
  model: string
  payload: PullRequestPayload
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
  private reviewSessions = new Map<string, ReviewSessionInfo>()
  private sessionLastError = new Map<string, string>()
  private retryWorkerTimer: ReturnType<typeof setInterval> | null = null
  /** Backlog entry IDs currently being retried — prevents double-processing if a worker tick overlaps. */
  private retryInProgress = new Set<string>()
  private debounceFileConsumed = false

  constructor(config: FullWebhookConfig, sessions: SessionManager) {
    super('webhook', PROCESSING_TIMEOUT_MS)

    this.config = config
    this.sessions = sessions
    this.dedup = new WebhookDedup()
    this.providerHealth = new ProviderHealthManager()
    this.backlog = new BacklogManager()

    // Buffer the latest error text per session for classification on exit.
    sessions.onSessionError((sessionId, errorText) => {
      this.sessionLastError.set(sessionId, errorText)
    })

    // Track session completion to update webhook event status.
    sessions.onSessionExit((sessionId, code, _signal, willRestart) => {
      if (willRestart) return

      const event = this.getEvents().find(e => e.sessionId === sessionId && (e.status === 'session_created' || e.status === 'processing'))
      if (!event) {
        this.sessionLastError.delete(sessionId)
        this.reviewSessions.delete(sessionId)
        return
      }

      if (code === 0) {
        this.updateEventStatus(event.id, 'completed')
        console.log(`[webhook] Event ${event.id} → completed (session ${sessionId}, code=0)`)
        this.reviewSessions.delete(sessionId)
        this.sessionLastError.delete(sessionId)
        cleanupWorkspace(sessionId)
        return
      }

      // Non-zero exit — classify the error.
      const errorText = this.sessionLastError.get(sessionId) ?? `Session exited with code ${code}`
      this.sessionLastError.delete(sessionId)
      const reviewInfo = this.reviewSessions.get(sessionId)
      this.reviewSessions.delete(sessionId)
      void this.handleReviewFailure(event, sessionId, errorText, reviewInfo)
    })

    // Auto-kill PR review sessions after Claude completes its turn.
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

      this.sessions.stopClaude(sessionId)
      setTimeout(() => {
        this.sessions.delete(sessionId)
      }, 2000)
    })

    // Start the backlog retry worker.
    this.retryWorkerTimer = setInterval(() => {
      void this.runRetryWorker()
    }, RETRY_WORKER_INTERVAL_MS)
    if (this.retryWorkerTimer.unref) this.retryWorkerTimer.unref()
  }

  /**
   * Check if we are at the session cap (for reuse across event types).
   */
  private isAtSessionCap(): boolean {
    const activeWebhookSessions = this.sessions.list().filter(s => s.source === 'webhook' && s.active).length
    const processingEvents = this.countByStatus('processing')
    return (activeWebhookSessions + processingEvents) >= this.config.maxConcurrentSessions
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

  /**
   * Async background processing: fetch logs, create workspace, create session, send prompt.
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
    // Use the canonical repo path as groupDir so the frontend groups webhook
    // sessions under the same tab as manual sessions for the same repo.
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
    // Re-fetch the event after status update to ensure broadcast uses current status
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrompt(context, logLines)
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] Prompt sent to session ${sessionId}, Claude is processing...`)
  }

  /**
   * Broadcast a webhook event notification to all connected WebSocket clients.
   * Sent globally (not scoped to the new session) so any open browser tab can
   * display the incoming webhook badge regardless of which session is active.
   */
  private broadcastWebhookEvent(event: WebhookEvent): void {
    // Iterate all active sessions as proxies to their connected WS clients
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

    // Broadcast to all active sessions
    for (const sessionInfo of allSessions) {
      const session = this.sessions.get(sessionInfo.id)
      if (session) {
        this.sessions.broadcast(session, msg)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // pull_request handling (PR code review)
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
        body: { accepted: false, eventId, status: 'filtered', filterReason: 'Draft PR — skipping review' },
      }
    }

    // --- Actor allowlist ---
    const actorLower = (payload.sender?.login ?? '').toLowerCase()
    if (this.config.actorAllowlist.length > 0 && !this.config.actorAllowlist.some(a => a.toLowerCase() === actorLower)) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'filtered', filterReason: `Actor '${payload.sender?.login}' not in allowlist` },
      }
    }

    // --- Deduplication ---
    const headSha = pr.head?.sha ?? ''
    const idempotencyKey = computePrIdempotencyKey(
      payload.repository.full_name,
      pr.number,
      payload.action,
      headSha,
    )

    if (this.dedup.isDuplicate(eventId, idempotencyKey)) {
      return {
        statusCode: 200,
        body: { accepted: false, eventId, status: 'duplicate' },
      }
    }

    // --- Smart SHA filter: skip if already reviewed at this SHA ---
    if (NO_CODE_CHANGE_ACTIONS.includes(payload.action)) {
      const cachedReview = loadPrCache(payload.repository.full_name, pr.number)
      if (cachedReview && cachedReview.lastReviewedSha === headSha) {
        return {
          statusCode: 200,
          body: {
            accepted: false,
            eventId,
            status: 'filtered',
            filterReason: `Already reviewed at SHA ${headSha.slice(0, 8)} (action=${payload.action}, no code change)`,
          },
        }
      }
    }

    // --- Pre-allocate session ID ---
    const sessionId = randomUUID()
    const repo = payload.repository.full_name
    const debounceMs = this.config.prDebounceMs

    const makeEvent = (status: WebhookEventStatus): WebhookEvent => ({
      id: eventId,
      idempotencyKey,
      receivedAt: new Date().toISOString(),
      event: 'pull_request',
      action: payload.action,
      repo,
      branch: pr.head?.ref ?? 'unknown',
      workflow: 'PR Review',
      runId: pr.number,
      runAttempt: 1,
      conclusion: payload.action,
      status,
      sessionId,
      prNumber: pr.number,
      prTitle: pr.title,
      headSha: pr.head.sha,
      baseBranch: pr.base?.ref ?? 'main',
    })

    // --- Evict any backlogged retry for this PR immediately ---
    this.backlog.removeByPr(payload.repository.full_name, pr.number)

    // --- Debounce: wait before processing to coalesce rapid events ---
    if (debounceMs > 0) {
      const webhookEvent = makeEvent('debounced')
      this.recordEvent(webhookEvent)
      // Record dedup early so GitHub retries during the debounce window are caught.
      this.dedup.recordProcessed(eventId, idempotencyKey)

      const debounceKey = `${repo}#${pr.number}`
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

    // --- No debounce: process immediately ---
    this.supersedePrSessions(repo, pr.number)

    if (this.isAtSessionCap()) {
      this.recordEvent(makeEvent('error'))
      this.updateEventStatus(eventId, 'error', `Max concurrent webhook sessions reached (${this.config.maxConcurrentSessions})`)
      return {
        statusCode: 429,
        body: { error: 'Max concurrent webhook sessions reached', max: this.config.maxConcurrentSessions },
      }
    }

    const webhookEvent = makeEvent('processing')
    this.recordEvent(webhookEvent)
    this.dedup.recordProcessed(eventId, idempotencyKey)

    this.processPrReviewAsync(payload, webhookEvent, sessionId).catch(err => {
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
   * Handle PR closed/merged — archive or delete the review cache and kill any
   * active review sessions for this PR.
   */
  private async handlePrClosed(
    payload: PullRequestPayload,
    eventId: string,
  ): Promise<{ statusCode: number; body: Record<string, unknown> }> {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const merged = pr.merged ?? false

    console.log(`[webhook] PR #${pr.number} ${merged ? 'merged' : 'closed'} in ${repo}`)

    // Archive (merged) or delete (closed without merge) the cache
    try {
      if (merged) {
        archivePrCache(repo, pr.number)
      } else {
        deletePrCache(repo, pr.number)
      }
    } catch (err) {
      console.warn(`[webhook] Failed to clean up PR cache for ${repo}#${pr.number}:`, err)
    }

    // Cancel any pending debounce for this PR
    const debounceKey = `${repo}#${pr.number}`
    const pending = this.pendingDebounce.get(debounceKey)
    if (pending) {
      clearTimeout(pending.timer)
      this.updateEventStatus(pending.event.id, 'superseded', merged ? 'PR merged' : 'PR closed')
      this.pendingDebounce.delete(debounceKey)
      console.log(`[webhook] Cancelled pending debounce for ${debounceKey} — PR ${merged ? 'merged' : 'closed'}`)
    }

    // Kill any active review sessions for this PR
    this.supersedePrSessions(repo, pr.number, merged ? 'PR merged' : 'PR closed')

    return {
      statusCode: 200,
      body: { accepted: true, eventId, status: 'completed', action: merged ? 'archived' : 'deleted' },
    }
  }

  /**
   * Async background processing for PR review: fetch PR context, create workspace,
   * create session, send review prompt.
   */
  private async processPrReviewAsync(
    payload: PullRequestPayload,
    event: WebhookEvent,
    sessionId: string,
    opts?: { forceProvider?: CodingProvider; isFallback?: boolean },
  ): Promise<void> {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const repoName = payload.repository.name
    const prNumber = pr.number
    const headSha = pr.head?.sha ?? ''
    const baseRef = pr.base?.ref ?? 'main'

    const { provider: reviewProvider, model: reviewModel } = opts?.forceProvider
      ? { provider: opts.forceProvider, model: opts.forceProvider === 'claude' ? this.config.prReviewClaudeModel : this.config.prReviewOpencodeModel }
      : this.resolvePrReviewProvider()
    const isFallback = !!opts?.isFallback
    console.log(`[webhook] Processing PR: ${repo} #${prNumber} "${pr.title}" (${payload.action}) — reviewer: ${reviewProvider} (${reviewModel})`)

    // --- Ensure cache dir ---
    const cachePath = ensureCacheDir(repo, prNumber)

    // --- Load prior review cache ---
    const priorCache = loadPrCache(repo, prNumber)

    // --- Fetch PR context (all calls degrade gracefully) ---
    const [diffResult, files, commits, reviewComments, reviews, existingComment] = await Promise.all([
      fetchPrDiff(repo, prNumber),
      fetchPrFiles(repo, prNumber),
      fetchPrCommits(repo, prNumber),
      fetchPrReviewComments(repo, prNumber),
      fetchPrReviews(repo, prNumber),
      fetchExistingReviewComment(repo, prNumber),
    ])

    // Check if superseded while fetching PR context
    if (this.getEvent(event.id)?.status === 'superseded') {
      console.log(`[webhook] Event ${event.id} was superseded, aborting PR processing`)
      return
    }

    const prContext: PullRequestContext = {
      repo,
      repoName,
      prNumber,
      prTitle: pr.title,
      prBody: pr.body ?? '',
      prUrl: pr.html_url ?? '',
      author: pr.user?.login ?? 'unknown',
      headBranch: pr.head?.ref ?? 'unknown',
      baseBranch: baseRef,
      headSha,
      baseSha: pr.base?.sha ?? '',
      beforeSha: payload.before,
      action: payload.action as PullRequestContext['action'],
      changedFiles: pr.changed_files ?? 0,
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      diff: diffResult.diff,
      fileList: files,
      commitMessages: commits,
      reviewComments,
      reviews,
      existingComment: existingComment != null ? String(existingComment) : null,
      priorCache: priorCache ?? null,
      reviewProvider,
      reviewModel,
    }

    // --- Create workspace ---
    let workspacePath: string
    const headRepo = pr.head?.repo?.clone_url ?? payload.repository.clone_url
    try {
      workspacePath = await createWorkspace(
        sessionId,
        repo,
        headRepo,
        pr.head?.ref ?? baseRef,
        headSha,
      )
    } catch (err) {
      console.error(`[webhook] Failed to create workspace for PR ${repo}#${prNumber}:`, err)
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
      sessionName = `PR #${prNumber}: ${pr.title} (update @${headSha.slice(0, 7)})`
    } else if (payload.action === 'reopened') {
      sessionName = `PR #${prNumber}: ${pr.title} (reopened)`
    } else {
      sessionName = `PR #${prNumber}: ${pr.title}`
    }

    const sessionOptions: CreateSessionOptions = {
      source: 'webhook',
      id: sessionId,
      groupDir,
      provider: reviewProvider,
      model: reviewModel,
    }

    if (reviewProvider === 'claude') {
      // Narrowed allowedTools: read-only git, PR-review-specific gh,
      // Write for cache, context7 MCP for library docs, no WebFetch/WebSearch.
      sessionOptions.skipDefaultBashGit = true
      sessionOptions.allowedTools = [
        // git read-only
        'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)',
        'Bash(git show:*)', 'Bash(git blame:*)', 'Bash(git rev-parse:*)',
        'Bash(git ls-files:*)', 'Bash(git branch:*)', 'Bash(git config:*)',
        // gh review-specific (Bash(gh api:*) is broader than OpenCode's
        // per-endpoint patterns — prompt provides secondary deny layer)
        'Bash(gh pr view:*)', 'Bash(gh pr diff:*)', 'Bash(gh pr review:*)',
        'Bash(gh api:*)',
        // file/cache write
        'Write',
        // library docs lookup
        'mcp__plugin_context7_context7__resolve-library-id',
        'mcp__plugin_context7_context7__query-docs',
      ]
      sessionOptions.addDirs = [dirname(cachePath)]
    } else {
      // OpenCode: workspace-local opencode.json with scoped permissions.
      const opencodeConfig = {
        $schema: 'https://opencode.ai/config.json',
        permission: {
          bash: {
            '*': 'deny',
            'gh pr view *': 'allow', 'gh pr diff *': 'allow', 'gh pr review *': 'allow',
            'gh api repos/*/issues/*/comments': 'allow', 'gh api repos/*/issues/*/comments *': 'allow',
            'gh api repos/*/issues/comments/*': 'allow', 'gh api repos/*/issues/comments/* *': 'allow',
            'gh api repos/*/pulls/*/comments': 'allow', 'gh api repos/*/pulls/*/comments *': 'allow',
            'gh api repos/*/pulls/*/reviews': 'allow', 'gh api repos/*/pulls/*/reviews *': 'allow',
            'gh api repos/*/pulls/*/reviews/*': 'allow', 'gh api repos/*/pulls/*/reviews/* *': 'allow',
            'gh api repos/*/pulls/*/reviews/*/dismissals': 'allow', 'gh api repos/*/pulls/*/reviews/*/dismissals *': 'allow',
            'git status': 'allow', 'git status *': 'allow',
            'git diff': 'allow', 'git diff *': 'allow',
            'git log': 'allow', 'git log *': 'allow',
            'git show': 'allow', 'git show *': 'allow',
            'git blame *': 'allow', 'git rev-parse *': 'allow',
            'git ls-files': 'allow', 'git ls-files *': 'allow',
            'git branch': 'allow', 'git branch --show-current': 'allow',
            'git config --get *': 'allow',
          },
          read: 'allow', edit: 'allow', write: 'allow', grep: 'allow',
          webfetch: 'deny',
          external_directory: { '*': 'deny', [dirname(cachePath) + '/**']: 'allow' },
          doom_loop: 'deny',
        },
      }
      writeFileSync(join(workspacePath, 'opencode.json'), JSON.stringify(opencodeConfig, null, 2))
      console.log(`[webhook] Wrote opencode.json permissions config to ${workspacePath}`)
      sessionOptions.permissionMode = 'bypassPermissions'
    }

    this.sessions.create(sessionName, workspacePath, sessionOptions)

    this.reviewSessions.set(sessionId, {
      eventId: event.id,
      provider: reviewProvider,
      model: reviewModel,
      payload,
      isFallback,
    })

    console.log(`[webhook] PR session created: ${sessionName} (${sessionId})`)
    this.updateEventStatus(event.id, 'session_created')

    // Broadcast
    const updatedEvent = this.getEvent(event.id)
    if (updatedEvent) this.broadcastWebhookEvent(updatedEvent)

    // --- Build and send prompt ---
    const prompt = buildPrReviewPrompt(prContext, workspacePath, {
      priorCache: priorCache ?? undefined,
      cachePath,
      existingCommentId: existingComment ?? undefined,
    })
    this.sessions.sendInput(sessionId, prompt)

    console.log(`[webhook] PR review prompt sent to session ${sessionId}, session is processing...`)
  }

  // ---------------------------------------------------------------------------
  // Provider resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve the provider and model for a PR review session based on config.
   *
   * `split` mode is **random A/B selection**: each review independently flips a
   * 50/50 coin between Claude and OpenCode.
   */
  private resolvePrReviewProvider(): { provider: 'claude' | 'opencode'; model: string } {
    if (this.config.prReviewProvider === 'opencode') {
      return { provider: 'opencode', model: this.config.prReviewOpencodeModel }
    }
    if (this.config.prReviewProvider === 'split') {
      return Math.random() < 0.5
        ? { provider: 'claude', model: this.config.prReviewClaudeModel }
        : { provider: 'opencode', model: this.config.prReviewOpencodeModel }
    }
    return { provider: 'claude', model: this.config.prReviewClaudeModel }
  }

  // ---------------------------------------------------------------------------
  // Provider health + backlog integration
  // ---------------------------------------------------------------------------

  getProviderHealth(): ProviderHealthFile {
    return this.providerHealth.getAll()
  }

  getBacklogSize(): number {
    return this.backlog.size()
  }

  private async handleReviewFailure(
    event: WebhookEvent,
    sessionId: string,
    errorText: string,
    reviewInfo: ReviewSessionInfo | undefined,
  ): Promise<void> {
    const category = classifyProviderError(errorText)
    cleanupWorkspace(sessionId)

    if (category === 'other' || !reviewInfo) {
      this.updateEventStatus(event.id, 'error', errorText.slice(0, 500))
      console.log(`[webhook] Event ${event.id} → error (session ${sessionId}, category=${category})`)
      return
    }

    const { provider, model, payload, isFallback } = reviewInfo
    this.providerHealth.markUnhealthy(provider, category, errorText)
    console.warn(`[webhook] Provider ${provider} (${model}) failed with ${category}: ${errorText.slice(0, 200)}`)

    // Split-mode fallback
    const canFallback = this.config.prReviewProvider === 'split' && !isFallback
    if (canFallback) {
      const otherProvider: CodingProvider = provider === 'claude' ? 'opencode' : 'claude'
      console.log(`[webhook] Split-mode fallback: retrying event ${event.id} with ${otherProvider}`)
      this.updateEventStatus(event.id, 'superseded', `Falling back from ${provider} to ${otherProvider} (${category})`)

      const newEvent: WebhookEvent = {
        ...event, id: randomUUID(), receivedAt: new Date().toISOString(), status: 'processing',
      }
      const newSessionId = randomUUID()
      newEvent.sessionId = newSessionId
      this.recordEvent(newEvent)

      this.processPrReviewAsync(payload, newEvent, newSessionId, {
        forceProvider: otherProvider, isFallback: true,
      }).catch(err => {
        console.error('[webhook] Fallback session error:', err)
        if (this.getEvent(newEvent.id)?.status !== 'superseded') {
          this.updateEventStatus(newEvent.id, 'error', String(err))
        }
      })
      return
    }

    // Fixed mode or split fallback also failed — backlog + PR comment.
    const entry = this.backlog.enqueue({
      repo: event.repo,
      prNumber: event.runId,
      headSha: event.headSha ?? payload.pull_request.head.sha,
      payload,
      reason: category,
      failedProvider: isFallback ? 'both' : provider,
    })

    this.updateEventStatus(
      event.id, 'error',
      `${category} on ${provider}${isFallback ? ' (after split fallback)' : ''} — backlogged, retryAfter=${entry.retryAfter}`,
    )

    const providerDisplay = provider === 'opencode' ? `OpenCode (${model})` : `Claude (${model})`
    await postProviderUnavailableComment({
      repo: event.repo, prNumber: event.runId, reason: category,
      providerDisplay, errorText, retryAfter: entry.retryAfter,
    })
  }

  private async runRetryWorker(): Promise<void> {
    if (!this.ghHealthy) return
    const ready = this.backlog.getReady()
    if (ready.length === 0) return

    for (const entry of ready) {
      if (this.retryInProgress.has(entry.id)) continue
      this.retryInProgress.add(entry.id)
      try {
        if (this.isAtSessionCap()) { this.retryInProgress.delete(entry.id); continue }

        const state = await fetchPrState(entry.repo, entry.prNumber)
        if (state === 'closed') {
          this.backlog.remove(entry.id)
          continue
        }
        if (state === undefined) continue

        this.backlog.bumpRetry(entry.id)
        console.log(`[webhook-backlog] Retrying ${entry.repo}#${entry.prNumber} (attempt ${entry.retryCount + 1})`)

        const newEvent: WebhookEvent = {
          id: randomUUID(),
          idempotencyKey: computePrIdempotencyKey(entry.repo, entry.prNumber, entry.payload.action, entry.headSha),
          receivedAt: new Date().toISOString(),
          event: 'pull_request', action: entry.payload.action, repo: entry.repo,
          branch: entry.payload.pull_request.head.ref, workflow: 'PR Review',
          runId: entry.prNumber, runAttempt: 1, conclusion: entry.payload.action,
          status: 'processing', sessionId: undefined,
          prNumber: entry.prNumber, prTitle: entry.payload.pull_request.title,
          headSha: entry.headSha, baseBranch: entry.payload.pull_request.base.ref,
        }
        const newSessionId = randomUUID()
        newEvent.sessionId = newSessionId
        this.recordEvent(newEvent)

        this.processPrReviewAsync(entry.payload, newEvent, newSessionId).then(() => {
          const status = this.getEvent(newEvent.id)?.status
          if (status === 'session_created' || status === 'completed') {
            this.backlog.remove(entry.id)
          }
        }).catch(err => {
          console.error('[webhook-backlog] Retry session error:', err)
          if (this.getEvent(newEvent.id)?.status !== 'superseded') {
            this.updateEventStatus(newEvent.id, 'error', String(err))
          }
        })
      } catch (err) {
        console.error(`[webhook-backlog] Failed to process retry for ${entry.id}:`, err)
      } finally {
        this.retryInProgress.delete(entry.id)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Debounce helpers
  // ---------------------------------------------------------------------------

  /**
   * Fire a debounced PR event after the timer expires.
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

    // Cap check
    if (this.isAtSessionCap()) {
      this.updateEventStatus(event.id, 'error', `Max concurrent webhook sessions reached (${this.config.maxConcurrentSessions})`)
      console.warn(`[webhook] Cap reached when debounce fired for ${repo}#${pr.number}, dropping event ${event.id}`)
      return
    }

    // Transition from debounced → processing
    this.updateEventStatus(event.id, 'processing')
    const liveEvent = this.getEvent(event.id)
    if (liveEvent) liveEvent.receivedAt = new Date().toISOString()

    this.processPrReviewAsync(payload, event, sessionId).catch(err => {
      console.error('[webhook] PR async processing error:', err)
      if (this.getEvent(event.id)?.status !== 'superseded') {
        this.updateEventStatus(event.id, 'error', String(err))
      }
    })
  }

  /**
   * Supersede any active review sessions for a PR (new push kills old review).
   */
  private supersedePrSessions(repo: string, prNumber: number, reason = 'Superseded by new push'): void {
    const activeStatuses: WebhookEventStatus[] = ['processing', 'session_created']
    const activeEvents = this.getEvents().filter(
      e => e.repo === repo && e.prNumber === prNumber && activeStatuses.includes(e.status)
    )

    for (const oldEvent of activeEvents) {
      console.log(`[webhook] Superseding PR session: event=${oldEvent.id} session=${oldEvent.sessionId} (PR ${repo}#${prNumber})`)
      this.updateEventStatus(oldEvent.id, 'superseded', reason)
      if (oldEvent.sessionId) {
        this.sessions.delete(oldEvent.sessionId)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Debounce persistence
  // ---------------------------------------------------------------------------

  /**
   * Persist pending debounces to disk so events survive server restart.
   * Called from shutdown().
   */
  private savePendingDebounces(): void {
    if (this.pendingDebounce.size === 0) {
      // Only delete the file if we actually consumed it this lifecycle.
      if (this.debounceFileConsumed && existsSync(PENDING_DEBOUNCE_FILE)) {
        try { unlinkSync(PENDING_DEBOUNCE_FILE) } catch { /* ignore */ }
      }
      return
    }

    const records: PendingDebounceRecord[] = []
    for (const [key, pending] of this.pendingDebounce) {
      records.push({ key, payload: pending.payload, event: pending.event, sessionId: pending.sessionId })
    }

    try {
      mkdirSync(join(homedir(), '.codekin'), { recursive: true })
      const tmpFile = PENDING_DEBOUNCE_FILE + '.tmp'
      writeFileSync(tmpFile, JSON.stringify(records, null, 2), { mode: 0o600 })
      renameSync(tmpFile, PENDING_DEBOUNCE_FILE)
      console.log(`[webhook] Saved ${records.length} pending debounce(s) to disk`)
    } catch (err) {
      console.warn('[webhook] Failed to save pending debounces:', err)
    }
  }

  /**
   * Restore pending debounces from a previous run and fire them immediately.
   * Called from checkHealth() on startup when gh is healthy.
   */
  private restorePendingDebounces(): void {
    this.debounceFileConsumed = true

    if (!existsSync(PENDING_DEBOUNCE_FILE)) return

    let records: PendingDebounceRecord[]
    try {
      const raw = readFileSync(PENDING_DEBOUNCE_FILE, 'utf-8')
      records = JSON.parse(raw) as PendingDebounceRecord[]
      unlinkSync(PENDING_DEBOUNCE_FILE)
    } catch (err) {
      console.warn('[webhook] Failed to restore pending debounces:', err)
      return
    }

    if (!Array.isArray(records) || records.length === 0) return
    console.log(`[webhook] Restoring ${records.length} pending debounce(s) from previous run`)

    for (const rec of records) {
      if (!rec.payload || !rec.event || !rec.sessionId) continue

      // Smart SHA filter on restored events
      const pr = rec.payload.pull_request
      if (pr && NO_CODE_CHANGE_ACTIONS.includes(rec.payload.action)) {
        const cached = loadPrCache(rec.payload.repository.full_name, pr.number)
        if (cached && cached.lastReviewedSha === pr.head?.sha) {
          console.log(`[webhook] Skipping restored debounce for ${rec.key} — already reviewed at SHA ${pr.head.sha.slice(0, 8)}`)
          continue
        }
      }

      // Re-record the event and mark as processed in dedup so GitHub retries
      // during the restart window are caught as duplicates.
      this.recordEvent(rec.event)
      this.dedup.recordProcessed(rec.event.id, rec.event.idempotencyKey)
      this.fireDebouncedPrEvent(rec.payload, rec.event, rec.sessionId)
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
    this.savePendingDebounces()

    for (const [, pending] of this.pendingDebounce) {
      clearTimeout(pending.timer)
    }
    this.pendingDebounce.clear()

    if (this.retryWorkerTimer) {
      clearInterval(this.retryWorkerTimer)
      this.retryWorkerTimer = null
    }

    this.providerHealth.shutdown()
    this.backlog.shutdown()

    super.shutdown()
    this.dedup.shutdown()
  }
}
