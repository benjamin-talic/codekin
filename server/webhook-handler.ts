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
import { dirname } from 'path'
import type { CreateSessionOptions, SessionManager } from './session-manager.js'
import { verifyHmacSignature } from './crypto-utils.js'
import type { WsServerMessage } from './types.js'
import type { WebhookConfig, WebhookEvent, WebhookEventStatus, WorkflowRunPayload, FailureContext, PullRequestPayload, PullRequestContext } from './webhook-types.js'
import type { FullWebhookConfig } from './webhook-config.js'
import { WebhookDedup, computeIdempotencyKey, computePrIdempotencyKey } from './webhook-dedup.js'
import { checkGhHealth, fetchFailedLogs, fetchJobs, fetchAnnotations, fetchCommitMessage, fetchPRTitle } from './webhook-github.js'
import { fetchPrDiff, fetchPrFiles, fetchPrCommits, fetchPrReviewComments, fetchPrReviews, fetchExistingReviewComment } from './webhook-pr-github.js'
import { buildPrompt } from './webhook-prompt.js'
import { buildPrReviewPrompt } from './webhook-pr-prompt.js'
import { loadPrCache, ensureCacheDir, archivePrCache, deletePrCache } from './webhook-pr-cache.js'
import { createWorkspace, cleanupWorkspace } from './webhook-workspace.js'
import { WebhookHandlerBase } from './webhook-handler-base.js'
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

export class WebhookHandler extends WebhookHandlerBase<WebhookEvent, WebhookEventStatus> {
  private config: FullWebhookConfig
  private sessions: SessionManager
  private dedup: WebhookDedup
  private ghHealthy = false
  /** Pending debounce timers keyed by `repo#prNumber`. */
  private pendingDebounce = new Map<string, PendingDebounce>()

  constructor(config: FullWebhookConfig, sessions: SessionManager) {
    super('webhook', PROCESSING_TIMEOUT_MS)

    this.config = config
    this.sessions = sessions
    this.dedup = new WebhookDedup()

    // Track session completion to update webhook event status.
    // Only update on final exit (willRestart=false) to avoid prematurely
    // marking events as 'error' when auto-restart will retry.
    sessions.onSessionExit((sessionId, code, _signal, willRestart) => {
      if (willRestart) return  // Don't update status — Claude will retry

      // Match any non-terminal status — covers both 'processing' (if Claude
      // exits before status reaches 'session_created') and 'session_created'.
      const event = this.getEvents().find(e => e.sessionId === sessionId && (e.status === 'session_created' || e.status === 'processing'))
      if (event) {
        const status: WebhookEventStatus = (code === 0) ? 'completed' : 'error'
        this.updateEventStatus(event.id, status, code !== 0 ? `Claude exited with code ${code}` : undefined)
        console.log(`[webhook] Event ${event.id} → ${status} (session ${sessionId}, code=${code})`)

        // Clean up the workspace for completed/errored webhook sessions
        cleanupWorkspace(sessionId)
      }
    })

    // Auto-kill webhook sessions after Claude completes its turn so they don't
    // sit idle waiting for more input and consume memory indefinitely.
    sessions.onSessionResult((sessionId, isError) => {
      if (isError) return

      const event = this.getEvents().find(
        e => e.sessionId === sessionId && (e.status === 'session_created' || e.status === 'processing'),
      )
      if (!event) return

      this.updateEventStatus(event.id, 'completed')
      console.log(`[webhook] Session ${sessionId} completed review, scheduling cleanup`)

      this.sessions.stopClaude(sessionId) // suppress auto-restart
      setTimeout(() => {
        this.sessions.delete(sessionId)
      }, 2000)
    })
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
  ): Promise<void> {
    const pr = payload.pull_request
    const repo = payload.repository.full_name
    const repoName = payload.repository.name

    const { provider: reviewProvider, model: reviewModel } = this.resolvePrReviewProvider()
    console.log(`[webhook] Processing PR: ${repo} #${pr.number} "${pr.title}" (${payload.action}) — reviewer: ${reviewProvider} (${reviewModel})`)

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
      // Claude uses allowedTools and addDirs for sandboxed tool access
      sessionOptions.allowedTools = [
        'Bash(gh:*)',
        'Write',
        'mcp__plugin_context7_context7__resolve-library-id',
        'mcp__plugin_context7_context7__query-docs',
        'WebFetch',
        'WebSearch',
      ]
      sessionOptions.addDirs = [dirname(cachePath)]
    } else {
      // OpenCode doesn't support allowedTools/addDirs — it uses its own permission system.
      // Auto-approve permissions for automated webhook sessions to avoid interactive prompts.
      sessionOptions.permissionMode = 'bypassPermissions'
    }

    this.sessions.create(sessionName, workspacePath, sessionOptions)

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
   * For 'split' mode, performs a random coin flip per event.
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
    // Cancel all pending debounce timers and mark events as non-terminal
    for (const [, pending] of this.pendingDebounce) {
      clearTimeout(pending.timer)
      this.updateEventStatus(pending.event.id, 'superseded', 'Server shutdown')
    }
    this.pendingDebounce.clear()

    super.shutdown()
    this.dedup.shutdown()
  }
}
