/**
 * REST routes for the orchestrator session.
 *
 * Provides status, start, report scanning, child session management,
 * memory querying, and trust record endpoints.
 */

import { Router } from 'express'
import type { Request } from 'express'
import { resolve } from 'path'
import { existsSync, statSync } from 'fs'
import type { SessionManager } from './session-manager.js'
import { ensureOrchestratorRunning, getOrchestratorSessionId, getOrCreateOrchestratorId } from './orchestrator-manager.js'
import { getAgentDisplayName, REPOS_ROOT } from './config.js'
import { scanRepoReports, readReport, getReportsSince } from './orchestrator-reports.js'
import { OrchestratorMemory } from './orchestrator-memory.js'
import { OrchestratorChildManager } from './orchestrator-children.js'
import type { OrchestratorMonitor } from './orchestrator-monitor.js'
import type { TaskBoard } from './task-board.js'
import type { TaskType } from './task-board-types.js'
import {
  extractMemoryCandidates, smartUpsert, runAgingCycle,
  recordFindingOutcome, getTriageRecommendation,
  loadSkillProfile, updateSkillLevel, getGuidanceStyle,
  recordDecision, assessDecisionOutcome, getPendingOutcomeAssessments,
  type FindingOutcome,
} from './orchestrator-learning.js'

type VerifyFn = (token: string | undefined) => boolean
type VerifySessionFn = (token: string | undefined, sessionId: string | undefined) => boolean
type ExtractFn = (req: Request) => string | undefined

export function createOrchestratorRouter(
  verifyToken: VerifyFn,
  extractToken: ExtractFn,
  sessions: SessionManager,
  monitorRef?: { current: OrchestratorMonitor | null },
  verifyTokenOrSessionToken?: VerifySessionFn,
  injectedMemory?: OrchestratorMemory,
  injectedChildren?: OrchestratorChildManager,
  injectedTaskBoard?: TaskBoard,
): Router {
  const router = Router()
  const memory = injectedMemory ?? new OrchestratorMemory()
  const children = injectedChildren ?? new OrchestratorChildManager(sessions)
  const taskBoard = injectedTaskBoard

  /**
   * Verify that the request is authorized — accepts either the master auth
   * token OR the orchestrator session's scoped token.  This allows the
   * orchestrator's Claude process (which only has a session-scoped token)
   * to call its own management endpoints (spawn children, update memory, etc.).
   */
  function verifyOrchestratorAuth(req: Request): boolean {
    const token = extractToken(req)
    if (verifyToken(token)) return true
    if (verifyTokenOrSessionToken) {
      const orchestratorId = getOrCreateOrchestratorId()
      return verifyTokenOrSessionToken(token, orchestratorId)
    }
    return false
  }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /** Get orchestrator session status. */
  router.get('/api/orchestrator/status', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const sessionId = getOrchestratorSessionId(sessions)
    if (!sessionId) {
      return res.json({ sessionId: null, status: 'stopped', agentName: getAgentDisplayName() })
    }

    const session = sessions.get(sessionId)
    const status = session?.claudeProcess?.isAlive() ? 'active' : 'idle'
    res.json({
      sessionId,
      status,
      childSessions: children.activeCount(),
      agentName: getAgentDisplayName(),
    })
  })

  /** Ensure orchestrator is running and return its session ID. */
  router.post('/api/orchestrator/start', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    try {
      const sessionId = ensureOrchestratorRunning(sessions)
      res.json({ sessionId, status: 'active', agentName: getAgentDisplayName() })
    } catch (err) {
      console.error('[orchestrator] Failed to start:', err)
      res.status(500).json({ error: `Failed to start Agent ${getAgentDisplayName()}` })
    }
  })

  // -------------------------------------------------------------------------
  // Reports
  // -------------------------------------------------------------------------

  /** Scan reports for a single repo. */
  router.get('/api/orchestrator/reports', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const repoPath = req.query.repo as string | undefined
    const since = req.query.since as string | undefined

    if (repoPath) {
      const reports = scanRepoReports(repoPath)
      res.json({ reports })
    } else if (since) {
      // Scan all managed repos — get paths from memory
      const repoItems = memory.list({ memoryType: 'repo_context' })
      const repoPaths = repoItems.map(r => r.scope).filter((s): s is string => !!s)
      const reports = getReportsSince(repoPaths, since)
      res.json({ reports })
    } else {
      res.status(400).json({ error: 'Provide ?repo=<path> or ?since=<YYYY-MM-DD>' })
    }
  })

  /** Read a specific report's content. */
  router.get('/api/orchestrator/reports/read', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const filePath = req.query.path as string | undefined
    if (!filePath) return res.status(400).json({ error: 'Provide ?path=<filePath>' })

    const report = readReport(filePath)
    if (!report) return res.status(404).json({ error: 'Report not found' })

    res.json({ report })
  })

  // -------------------------------------------------------------------------
  // Child sessions
  // -------------------------------------------------------------------------

  /** List child sessions. */
  router.get('/api/orchestrator/children', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ children: children.list() })
  })

  /** Spawn a child session. */
  router.post('/api/orchestrator/children', async (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { repo, task, branchName, completionPolicy, deployAfter, useWorktree, model, allowedTools } = req.body
    if (!repo || !task || !branchName) {
      return res.status(400).json({ error: 'Missing required fields: repo, task, branchName' })
    }

    // Validate branchName to prevent prompt injection
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(branchName)) {
      return res.status(400).json({ error: 'Invalid branchName: only alphanumeric, /, _, ., and - are allowed' })
    }

    // Validate allowedTools if provided: must be an array of strings
    if (allowedTools !== undefined) {
      if (!Array.isArray(allowedTools) || !allowedTools.every((t: unknown) => typeof t === 'string')) {
        return res.status(400).json({ error: 'Invalid allowedTools: must be an array of strings' })
      }
    }

    // Validate repo path: must resolve under REPOS_ROOT and be an existing directory
    const resolvedRepo = resolve(repo)
    if (!resolvedRepo.startsWith(REPOS_ROOT + '/') && resolvedRepo !== REPOS_ROOT) {
      return res.status(400).json({ error: 'Invalid repo path: must be under configured repos root' })
    }
    if (!existsSync(resolvedRepo) || !statSync(resolvedRepo).isDirectory()) {
      return res.status(400).json({ error: 'Invalid repo path: directory does not exist' })
    }

    try {
      const child = await children.spawn({
        repo,
        task,
        branchName,
        completionPolicy: completionPolicy ?? 'pr',
        deployAfter: deployAfter ?? false,
        useWorktree: useWorktree ?? true,
        model,
        allowedTools,
      })
      res.json({ child })
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Failed to spawn child session' })
    }
  })

  /** Get a specific child session. */
  router.get('/api/orchestrator/children/:id', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const child = children.get(req.params.id)
    if (!child) return res.status(404).json({ error: 'Child session not found' })

    res.json({ child })
  })

  // -------------------------------------------------------------------------
  // Task Board
  // -------------------------------------------------------------------------

  /** List all tasks. */
  router.get('/api/orchestrator/tasks', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (!taskBoard) return res.status(501).json({ error: 'Task board not available' })

    res.json({ tasks: taskBoard.list() })
  })

  /** Get task events (optionally pending only). */
  router.get('/api/orchestrator/tasks/events', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (!taskBoard) return res.status(501).json({ error: 'Task board not available' })

    const pendingOnly = req.query.pending === 'true'
    res.json({ events: taskBoard.getEvents(pendingOnly) })
  })

  /** Get a specific task. */
  router.get('/api/orchestrator/tasks/:id', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (!taskBoard) return res.status(501).json({ error: 'Task board not available' })

    const task = taskBoard.get(req.params.id)
    if (!task) return res.status(404).json({ error: 'Task not found' })

    res.json({ task })
  })

  /** Spawn a new task. */
  router.post('/api/orchestrator/tasks', async (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (!taskBoard) return res.status(501).json({ error: 'Task board not available' })

    const { repo, task, branchName, taskType, completionPolicy, useWorktree, timeoutMs, model, allowedTools } = req.body
    if (!repo || !task || !taskType) {
      return res.status(400).json({ error: 'Missing required fields: repo, task, taskType' })
    }

    // Validate taskType
    const validTypes: TaskType[] = ['implement', 'explore', 'review', 'research']
    if (!validTypes.includes(taskType)) {
      return res.status(400).json({ error: `Invalid taskType: must be one of ${validTypes.join(', ')}` })
    }

    // branchName required for implement, auto-generate for others
    const effectiveBranch = branchName
      || (taskType === 'implement' ? null : `${taskType}/${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`)
    if (!effectiveBranch) {
      return res.status(400).json({ error: 'Missing required field: branchName (required for implement tasks)' })
    }

    // Validate branchName
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(effectiveBranch)) {
      return res.status(400).json({ error: 'Invalid branchName: only alphanumeric, /, _, ., and - are allowed' })
    }

    // Validate allowedTools if provided
    if (allowedTools !== undefined) {
      if (!Array.isArray(allowedTools) || !allowedTools.every((t: unknown) => typeof t === 'string')) {
        return res.status(400).json({ error: 'Invalid allowedTools: must be an array of strings' })
      }
    }

    // Validate repo path
    const resolvedRepo = resolve(repo)
    if (!resolvedRepo.startsWith(REPOS_ROOT + '/') && resolvedRepo !== REPOS_ROOT) {
      return res.status(400).json({ error: 'Invalid repo path: must be under configured repos root' })
    }
    if (!existsSync(resolvedRepo) || !statSync(resolvedRepo).isDirectory()) {
      return res.status(400).json({ error: 'Invalid repo path: directory does not exist' })
    }

    // Default completionPolicy based on taskType
    const effectivePolicy = completionPolicy
      ?? (taskType === 'implement' ? 'pr' : 'none')

    try {
      const spawned = await taskBoard.spawn({
        repo,
        task,
        branchName: effectiveBranch,
        taskType,
        completionPolicy: effectivePolicy,
        useWorktree: useWorktree ?? (taskType === 'implement'),
        timeoutMs,
        model,
        allowedTools,
      })
      res.json({ task: spawned })
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Failed to spawn task' })
    }
  })

  /** Send a follow-up message to a running task's child session. */
  router.post('/api/orchestrator/tasks/:id/message', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (!taskBoard) return res.status(501).json({ error: 'Task board not available' })

    const { message } = req.body
    if (!message) return res.status(400).json({ error: 'Missing required field: message' })

    try {
      taskBoard.sendMessageToChild(req.params.id, message)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to send message' })
    }
  })

  /** Approve or deny a task's pending approval. */
  router.post('/api/orchestrator/tasks/:id/approve', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (!taskBoard) return res.status(501).json({ error: 'Task board not available' })

    const { requestId, value } = req.body
    if (!requestId || !value) {
      return res.status(400).json({ error: 'Missing required fields: requestId, value' })
    }

    try {
      taskBoard.respondToApproval(req.params.id, requestId, value)
      res.json({ ok: true })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to respond to approval' })
    }
  })

  /** Re-spawn a failed or timed-out task. */
  router.post('/api/orchestrator/tasks/:id/retry', async (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })
    if (!taskBoard) return res.status(501).json({ error: 'Task board not available' })

    try {
      const retried = await taskBoard.retryTask(req.params.id)
      res.json({ task: retried })
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to retry task' })
    }
  })

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  /** Search memory. */
  router.get('/api/orchestrator/memory', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const query = req.query.q as string | undefined
    const type = req.query.type as string | undefined
    const limit = parseInt(req.query.limit as string || '20', 10)

    if (query) {
      const items = memory.search(query, limit)
      res.json({ items })
    } else {
      const items = memory.list({
        memoryType: type as import('./orchestrator-memory.js').MemoryType | undefined,
        limit,
      })
      res.json({ items })
    }
  })

  /** Add or update a memory item. */
  router.post('/api/orchestrator/memory', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { id, memoryType, scope, title, content, sourceRef, confidence, expiresAt, isPinned, tags } = req.body
    if (!memoryType || !content) {
      return res.status(400).json({ error: 'Missing required fields: memoryType, content' })
    }

    const itemId = memory.upsert({
      id,
      memoryType,
      scope: scope ?? null,
      title: title ?? null,
      content,
      sourceRef: sourceRef ?? null,
      confidence: confidence ?? 0.8,
      expiresAt: expiresAt ?? null,
      isPinned: isPinned ?? false,
      tags: tags ?? [],
    })

    res.json({ id: itemId })
  })

  /** Delete a memory item. */
  router.delete('/api/orchestrator/memory/:id', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const deleted = memory.delete(req.params.id)
    res.json({ deleted })
  })

  // -------------------------------------------------------------------------
  // Trust
  // -------------------------------------------------------------------------

  /** List all trust records. */
  router.get('/api/orchestrator/trust', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ records: memory.listTrustRecords() })
  })

  /** Compute trust level for an action. */
  router.get('/api/orchestrator/trust/level', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, severity, repo } = req.query as Record<string, string>
    if (!action || !category) {
      return res.status(400).json({ error: 'Provide ?action=X&category=Y' })
    }

    const level = memory.computeTrustLevel(action, category, severity ?? 'medium', repo ?? null)
    res.json({ level })
  })

  /** Record an approval. */
  router.post('/api/orchestrator/trust/approve', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo } = req.body
    if (!action || !category) {
      return res.status(400).json({ error: 'Missing required fields: action, category' })
    }

    const record = memory.recordApproval(action, category, repo ?? null)
    res.json({ record })
  })

  /** Record a rejection (resets trust to ASK). */
  router.post('/api/orchestrator/trust/reject', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo } = req.body
    if (!action || !category) {
      return res.status(400).json({ error: 'Missing required fields: action, category' })
    }

    const record = memory.recordRejection(action, category, repo ?? null)
    res.json({ record })
  })

  /** Pin trust to a specific level (user override). */
  router.post('/api/orchestrator/trust/pin', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo, level } = req.body
    if (!action || !category || !level) {
      return res.status(400).json({ error: 'Missing required fields: action, category, level' })
    }

    memory.pinTrust(action, category, repo ?? null, level)
    res.json({ ok: true })
  })

  /** Reset all trust records. */
  router.post('/api/orchestrator/trust/reset', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    memory.resetAllTrust()
    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** Get pending notifications from the monitor. */
  router.get('/api/orchestrator/notifications', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const monitor = monitorRef?.current
    if (!monitor) return res.json({ notifications: [] })

    const all = req.query.all === 'true'
    res.json({ notifications: all ? monitor.getAll() : monitor.getPending() })
  })

  /** Mark notifications as delivered. */
  router.post('/api/orchestrator/notifications/mark-delivered', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const monitor = monitorRef?.current
    if (!monitor) return res.json({ ok: true })

    const { ids } = req.body
    if (Array.isArray(ids)) monitor.markDelivered(ids)
    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Dashboard stats
  // -------------------------------------------------------------------------

  /** Get summary stats for the dashboard header. */
  router.get('/api/orchestrator/dashboard', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const repoItems = memory.list({ memoryType: 'repo_context' })
    const pendingNotifications = monitorRef?.current?.getPending() ?? []
    const activeChildren = taskBoard ? taskBoard.activeCount() : children.activeCount()
    const trustRecords = memory.listTrustRecords()
    const autoApproved = trustRecords.filter(t => t.effectiveLevel !== 'ask').length

    res.json({
      stats: {
        managedRepos: repoItems.length,
        pendingNotifications: pendingNotifications.length,
        activeChildSessions: activeChildren,
        totalChildSessions: taskBoard ? taskBoard.list().length : children.list().length,
        needsApproval: taskBoard ? taskBoard.needsApprovalCount() : 0,
        trustRecords: trustRecords.length,
        autoApprovedActions: autoApproved,
        memoryItems: memory.list().length,
      },
    })
  })

  // -------------------------------------------------------------------------
  // Memory extraction & learning (Phase 4)
  // -------------------------------------------------------------------------

  /** Extract memory candidates from a session interaction. */
  router.post('/api/orchestrator/memory/extract', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { userMessage, assistantResponse, repo, sourceRef } = req.body
    if (!userMessage || !assistantResponse) {
      return res.status(400).json({ error: 'Missing required fields: userMessage, assistantResponse' })
    }

    const candidates = extractMemoryCandidates(userMessage, assistantResponse, repo ?? null)
    const results = candidates.map(c => smartUpsert(memory, c, sourceRef ?? null))

    res.json({ candidates: candidates.length, results })
  })

  /** Run the aging/decay cycle. */
  router.post('/api/orchestrator/memory/age', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const result = runAgingCycle(memory)
    res.json(result)
  })

  // -------------------------------------------------------------------------
  // Finding outcomes & triage recommendations
  // -------------------------------------------------------------------------

  /** Record a finding outcome. */
  router.post('/api/orchestrator/findings/outcome', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { findingId, repo, category, severity, action, reason, sessionId, outcome } = req.body
    if (!findingId || !repo || !category || !action) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    const id = recordFindingOutcome(memory, {
      findingId, repo, category,
      severity: severity ?? 'medium',
      action, reason: reason ?? '',
      sessionId: sessionId ?? null,
      outcome: outcome ?? null,
      timestamp: new Date().toISOString(),
    } as FindingOutcome)

    res.json({ id })
  })

  /** Get triage recommendation based on historical patterns. */
  router.get('/api/orchestrator/findings/recommend', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { category, severity, repo } = req.query as Record<string, string>
    if (!category) return res.status(400).json({ error: 'Provide ?category=X' })

    const recommendation = getTriageRecommendation(memory, category, severity ?? 'medium', repo ?? null)
    res.json(recommendation)
  })

  // -------------------------------------------------------------------------
  // User skill model
  // -------------------------------------------------------------------------

  /** Get the user's skill profile. */
  router.get('/api/orchestrator/skills', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({
      profile: loadSkillProfile(),
      guidanceStyle: getGuidanceStyle(),
    })
  })

  /** Update a skill level based on an observed signal. */
  router.post('/api/orchestrator/skills', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { domain, signal, level } = req.body
    if (!domain || !signal || !level) {
      return res.status(400).json({ error: 'Missing required fields: domain, signal, level' })
    }

    const updated = updateSkillLevel(domain, signal, level)
    res.json({ skill: updated, guidanceStyle: getGuidanceStyle() })
  })

  // -------------------------------------------------------------------------
  // Decision history
  // -------------------------------------------------------------------------

  /** Record a decision. */
  router.post('/api/orchestrator/decisions', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { decision, rationale, repo, relatedFinding, expectedOutcome } = req.body
    if (!decision || !rationale) {
      return res.status(400).json({ error: 'Missing required fields: decision, rationale' })
    }

    const id = recordDecision(memory, {
      decision, rationale,
      repo: repo ?? null,
      relatedFinding: relatedFinding ?? null,
      expectedOutcome: expectedOutcome ?? '',
    })
    res.json({ id })
  })

  /** Assess a decision's outcome. */
  router.post('/api/orchestrator/decisions/:id/assess', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { actualOutcome } = req.body
    if (!actualOutcome) return res.status(400).json({ error: 'Missing required field: actualOutcome' })

    const updated = assessDecisionOutcome(memory, req.params.id, actualOutcome)
    res.json({ updated })
  })

  /** Get decisions pending outcome assessment. */
  router.get('/api/orchestrator/decisions/pending', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ decisions: getPendingOutcomeAssessments(memory) })
  })

  // -------------------------------------------------------------------------
  // Session prompts & approvals
  // -------------------------------------------------------------------------

  /** Get all sessions with pending prompts (waiting for approval or answer). */
  router.get('/api/orchestrator/sessions/pending-prompts', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ sessions: sessions.getPendingPrompts() })
  })

  /** Approve or deny a pending prompt in any session. */
  router.post('/api/orchestrator/sessions/:id/respond', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const sessionId = req.params.id
    const { requestId, value } = req.body
    if (!value) {
      return res.status(400).json({ error: 'Missing required field: value (e.g. "allow", "deny", or answer text)' })
    }

    const session = sessions.get(sessionId)
    if (!session) return res.status(404).json({ error: 'Session not found' })

    // Verify there's actually a pending prompt (optionally for the specific requestId)
    const hasPending = requestId
      ? (session.pendingToolApprovals.has(requestId) || session.pendingControlRequests.has(requestId))
      : (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0)

    if (!hasPending) {
      return res.status(409).json({ error: 'No pending prompt to respond to' })
    }

    // Capture prompt details before responding (response clears them)
    let promptToolName = 'unknown'
    let promptType: 'permission' | 'question' = 'permission'
    if (requestId) {
      const toolApproval = session.pendingToolApprovals.get(requestId)
      const controlReq = session.pendingControlRequests.get(requestId)
      if (toolApproval) {
        promptToolName = toolApproval.toolName
        promptType = toolApproval.toolName === 'AskUserQuestion' ? 'question' : 'permission'
      } else if (controlReq) {
        promptToolName = controlReq.toolName
        promptType = controlReq.toolName === 'AskUserQuestion' ? 'question' : 'permission'
      }
    }

    sessions.sendPromptResponse(sessionId, value, requestId)

    // Broadcast a notification to the orchestrator channel so users can see
    // what the orchestrator approved/denied/answered.
    const orchestratorId = getOrCreateOrchestratorId()
    const orchestratorSession = sessions.get(orchestratorId)
    if (orchestratorSession && orchestratorSession.clients.size > 0) {
      const actionLabel = promptType === 'question'
        ? `answered question from ${promptToolName}`
        : `responded "${value}" to ${promptToolName}`
      const notifMsg = {
        type: 'system_message' as const,
        subtype: 'info' as const,
        text: `[${getAgentDisplayName()}] ${actionLabel} in session "${session.name}"`,
      }
      for (const ws of orchestratorSession.clients) {
        ws.send(JSON.stringify(notifMsg))
      }
    }

    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Session cleanup
  // -------------------------------------------------------------------------

  /** List all sessions (unfiltered, includes source field). */
  router.get('/api/orchestrator/sessions', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ sessions: sessions.listAll() })
  })

  /** Delete all automated sessions (source: workflow, webhook, stepflow, agent). */
  router.delete('/api/orchestrator/sessions/cleanup', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const automatedSources = new Set(['workflow', 'webhook', 'stepflow', 'agent'])
    const toDelete = sessions.listAll().filter((s) => automatedSources.has(s.source ?? ''))

    let deleted = 0
    for (const s of toDelete) {
      if (sessions.delete(s.id)) deleted++
    }

    res.json({ deleted })
  })

  /** Delete a specific session by ID. */
  router.delete('/api/orchestrator/sessions/:id', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const success = sessions.delete(req.params.id)
    if (!success) return res.status(404).json({ error: 'Session not found' })

    res.json({ deleted: true })
  })

  return router
}
