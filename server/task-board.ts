/**
 * Task Board — orchestrator task lifecycle, snapshot tracking, and event queue.
 *
 * Evolves OrchestratorChildManager into a proper task queue that supports
 * multiple task types (implement, explore, review, research), maintains
 * real-time snapshots from tool events, and delivers structured event
 * notifications to the orchestrator session.
 */

import { randomUUID } from 'crypto'
import type { SessionManager } from './session-manager.js'
import type { Session, WsServerMessage } from './types.js'
import { getAgentDisplayName } from './config.js'
import { AGENT_CHILD_ALLOWED_TOOLS } from './orchestrator-children.js'
import type {
  TaskStatus, TaskRequest, TaskSnapshot, TaskResult,
  TaskArtifacts, TaskEntry, TaskEvent, TaskEventType, ToolSequenceEntry,
} from './task-board-types.js'
import {
  MAX_CONCURRENT_TASKS, DEFAULT_TASK_TIMEOUT_MS, TASK_RETENTION_MS,
  MAX_RETAINED_TASKS, MAX_TOOL_SEQUENCE_LENGTH, MAX_FILES_TRACKED,
  MAX_SUMMARY_LENGTH, MAX_EVENTS, STUCK_TIMEOUT_MS,
} from './task-board-types.js'

// Re-export types and constants used by routes
export { AGENT_CHILD_ALLOWED_TOOLS } from './orchestrator-children.js'
export type { TaskEntry, TaskRequest, TaskEvent } from './task-board-types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeSnapshot(): TaskSnapshot {
  return {
    state: 'idle',
    activeTool: null,
    activeToolInput: null,
    turnCount: 0,
    lastToolSequence: [],
    filesRead: [],
    filesChanged: [],
    pendingApproval: null,
  }
}

/** Format milliseconds as a human-readable duration. */
function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  return `${mins}m ${remainSecs}s`
}

/** Regex to find GitHub PR URLs in text. */
const PR_URL_RE = /https:\/\/github\.com\/[^\s)]+\/pull\/\d+/g

// ---------------------------------------------------------------------------
// TaskBoard
// ---------------------------------------------------------------------------

export class TaskBoard {
  private tasks = new Map<string, TaskEntry>()
  private events: TaskEvent[] = []
  private stuckTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private sessions: SessionManager
  private orchestratorIdFn: () => string | null

  constructor(sessions: SessionManager, orchestratorIdFn: () => string | null) {
    this.sessions = sessions
    this.orchestratorIdFn = orchestratorIdFn

    // Register global listeners for snapshot tracking
    this.sessions.onToolActive((sessionId, toolName, toolInput) => {
      this.handleToolActive(sessionId, toolName, toolInput)
    })

    this.sessions.onToolDone((sessionId, toolName, summary) => {
      this.handleToolDone(sessionId, toolName, summary)
    })

    this.sessions.onSessionResult((sessionId, isError) => {
      this.handleSessionResult(sessionId, isError)
    })

    this.sessions.onSessionExit((sessionId, _code, _signal, willRestart) => {
      this.handleSessionExit(sessionId, willRestart)
    })

    this.sessions.onSessionPrompt((sessionId, _promptType, toolName, requestId) => {
      this.handleSessionPrompt(sessionId, toolName, requestId)
    })

    // Also listen for orchestrator result events to deliver pending events
    this.sessions.onSessionResult((sessionId) => {
      const orchestratorId = this.orchestratorIdFn()
      if (orchestratorId && sessionId === orchestratorId) {
        // Joe just finished a turn — deliver any pending events
        setTimeout(() => { this.deliverPendingEvents() }, 500)
      }
    })
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Get all active/recent tasks. */
  list(): TaskEntry[] {
    this.purgeStaleTasks()
    return Array.from(this.tasks.values())
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  }

  /** Get a task by ID. */
  get(id: string): TaskEntry | null {
    return this.tasks.get(id) ?? null
  }

  /** Count currently active (non-terminal) tasks. */
  activeCount(): number {
    return Array.from(this.tasks.values())
      .filter(t => t.status === 'starting' || t.status === 'running')
      .length
  }

  /** Count tasks waiting for approval. */
  needsApprovalCount(): number {
    return Array.from(this.tasks.values())
      .filter(t => t.snapshot.state === 'waiting_for_approval')
      .length
  }

  /** Spawn a new task. Returns the task entry or throws if at capacity. */
  async spawn(request: TaskRequest): Promise<TaskEntry> {
    this.purgeStaleTasks()
    if (this.activeCount() >= MAX_CONCURRENT_TASKS) {
      throw new Error(`Cannot spawn task: ${MAX_CONCURRENT_TASKS} concurrent tasks already running`)
    }

    const sessionId = randomUUID()
    const sessionName = `${getAgentDisplayName().toLowerCase()}:${request.branchName}`
    const now = new Date().toISOString()

    const task: TaskEntry = {
      id: sessionId,
      request,
      status: 'starting',
      snapshot: makeSnapshot(),
      result: null,
      error: null,
      startedAt: now,
      completedAt: null,
    }
    this.tasks.set(sessionId, task)

    try {
      // Create the session
      this.sessions.create(sessionName, request.repo, {
        source: 'agent',
        id: sessionId,
        groupDir: request.repo,
        model: request.model,
        permissionMode: 'acceptEdits',
        allowedTools: request.allowedTools ?? AGENT_CHILD_ALLOWED_TOOLS,
      })

      // Create a git worktree for isolation if requested
      let worktreeFailed = false
      if (request.useWorktree) {
        const wtPath = await this.sessions.createWorktree(sessionId, request.repo, request.branchName)
        if (!wtPath) {
          worktreeFailed = true
          console.warn(`[task-board] Failed to create worktree for ${sessionId}, falling back to main directory`)
        }
      }

      // Start the AI process
      this.sessions.startClaude(sessionId)
      task.status = 'running'
      task.snapshot.state = 'processing'

      // Build and send the task prompt
      const prompt = this.buildPrompt(request, worktreeFailed)
      this.sessions.sendInput(sessionId, prompt)

      // Monitor for timeout
      this.startTimeoutTimer(task)

      return task
    } catch (err) {
      task.status = 'failed'
      task.error = err instanceof Error ? err.message : String(err)
      task.completedAt = new Date().toISOString()
      this.queueEvent(task.id, 'failed', { error: task.error })
      return task
    }
  }

  /** Send a follow-up message to a running child session. */
  sendMessageToChild(taskId: string, message: string): void {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('Task not found')
    if (task.status !== 'running' && task.status !== 'starting') {
      throw new Error(`Task is not running (status: ${task.status})`)
    }
    this.sessions.sendInput(taskId, message)
  }

  /** Respond to a child's pending approval. */
  respondToApproval(taskId: string, requestId: string, value: string): void {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('Task not found')

    this.sessions.sendPromptResponse(taskId, value, requestId)

    // Clear the pending approval from the snapshot
    if (task.snapshot.pendingApproval?.requestId === requestId) {
      task.snapshot.pendingApproval = null
      task.snapshot.state = 'processing'
    }

    // Clear stuck timer
    const timer = this.stuckTimers.get(taskId)
    if (timer) {
      clearTimeout(timer)
      this.stuckTimers.delete(taskId)
    }
  }

  /** Stop a running task and mark it as cancelled. */
  stopTask(taskId: string): TaskEntry {
    const task = this.tasks.get(taskId)
    if (!task) throw new Error('Task not found')
    if (task.status !== 'starting' && task.status !== 'running') {
      throw new Error(`Cannot stop task with status: ${task.status}`)
    }

    // Kill the child process
    const session = this.sessions.get(taskId)
    if (session?.claudeProcess?.isAlive()) {
      session.claudeProcess.stop()
    }

    this.markTaskTerminal(task, 'cancelled', 'Task was manually stopped')
    return task
  }

  /** Re-spawn a failed, timed-out, or cancelled task with the same request. */
  async retryTask(taskId: string): Promise<TaskEntry> {
    const old = this.tasks.get(taskId)
    if (!old) throw new Error('Task not found')
    if (old.status !== 'failed' && old.status !== 'timed_out' && old.status !== 'cancelled') {
      throw new Error(`Cannot retry task with status: ${old.status}`)
    }
    return this.spawn(old.request)
  }

  /** Get all events, optionally filtered to pending only. */
  getEvents(pendingOnly = false): TaskEvent[] {
    if (pendingOnly) return this.events.filter(e => !e.delivered)
    return [...this.events]
  }

  // -------------------------------------------------------------------------
  // Event handlers (registered in constructor)
  // -------------------------------------------------------------------------

  private findTask(sessionId: string): TaskEntry | undefined {
    return this.tasks.get(sessionId)
  }

  private handleToolActive(sessionId: string, toolName: string, toolInput: string | undefined): void {
    const task = this.findTask(sessionId)
    if (!task || task.status !== 'running') return

    task.snapshot.activeTool = toolName
    task.snapshot.activeToolInput = toolInput ?? null
    task.snapshot.state = 'processing'

    // Track files from tool input
    this.trackFileFromTool(task, toolName, toolInput, 'active')
  }

  private handleToolDone(sessionId: string, toolName: string, summary: string | undefined): void {
    const task = this.findTask(sessionId)
    if (!task || task.status !== 'running') return

    task.snapshot.activeTool = null
    task.snapshot.activeToolInput = null

    // Add to tool sequence ring buffer
    const entry: ToolSequenceEntry = {
      toolName,
      summary: summary?.slice(0, 200),
      completedAt: new Date().toISOString(),
    }
    task.snapshot.lastToolSequence.push(entry)
    if (task.snapshot.lastToolSequence.length > MAX_TOOL_SEQUENCE_LENGTH) {
      task.snapshot.lastToolSequence.shift()
    }

    // Track files from tool summary
    this.trackFileFromTool(task, toolName, summary, 'done')
  }

  private handleSessionResult(sessionId: string, isError: boolean): void {
    const task = this.findTask(sessionId)
    if (!task || (task.status !== 'running' && task.status !== 'starting')) return

    task.snapshot.turnCount++
    task.snapshot.state = 'idle'
    task.snapshot.activeTool = null

    const session = this.sessions.get(sessionId)
    if (!session) {
      this.markTaskTerminal(task, 'failed', 'Session was deleted')
      return
    }

    // Don't mark as completed if there are pending approvals
    if (session.pendingToolApprovals.size > 0 || session.pendingControlRequests.size > 0) return

    // For implement tasks, check if the final step was done
    if (task.request.taskType === 'implement') {
      if (this.nudgeIfNeeded(task, session)) return
    }

    // Mark as completed
    const result = this.buildStructuredResult(task, session)
    task.result = result
    this.markTaskTerminal(task, isError ? 'failed' : 'completed',
      isError ? 'Claude returned an error' : null)
  }

  private handleSessionExit(sessionId: string, willRestart: boolean): void {
    const task = this.findTask(sessionId)
    if (!task || (task.status !== 'running' && task.status !== 'starting')) return
    if (willRestart) return // Will auto-restart, keep monitoring

    task.snapshot.state = 'exited'

    const session = this.sessions.get(sessionId)
    const result = session ? this.buildStructuredResult(task, session) : null
    const hasContent = result && result.summary.length > 100
    task.result = result
    this.markTaskTerminal(task, hasContent ? 'completed' : 'failed',
      hasContent ? null : 'Claude exited without sufficient output')
  }

  private handleSessionPrompt(sessionId: string, toolName: string | undefined, requestId: string | undefined): void {
    const task = this.findTask(sessionId)
    if (!task || task.status !== 'running') return

    const session = this.sessions.get(sessionId)
    const toolInput = this.getPendingToolInput(session, requestId)

    task.snapshot.state = 'waiting_for_approval'
    task.snapshot.pendingApproval = {
      requestId: requestId ?? '',
      toolName: toolName ?? 'unknown',
      toolInput: toolInput ?? {},
      since: new Date().toISOString(),
    }

    this.queueEvent(task.id, 'approval_needed', {
      approval: {
        requestId: requestId ?? '',
        toolName: toolName ?? 'unknown',
        since: task.snapshot.pendingApproval.since,
      },
    })

    this.startStuckTimer(task.id)
  }

  // -------------------------------------------------------------------------
  // Result extraction
  // -------------------------------------------------------------------------

  /** Build a structured result from the session's output history. */
  private buildStructuredResult(task: TaskEntry, session: Session): TaskResult {
    const fullOutput = this.extractLastTurnText(session.outputHistory)
    const summary = fullOutput.length > MAX_SUMMARY_LENGTH
      ? fullOutput.slice(0, MAX_SUMMARY_LENGTH - 3) + '...'
      : fullOutput
    const artifacts = this.extractArtifacts(task, session)
    const duration = Date.now() - new Date(task.startedAt).getTime()
    return { summary, fullOutput, artifacts, duration }
  }

  /**
   * Extract the full text of the last assistant turn.
   * Walks outputHistory in reverse from the last 'result' marker, collecting
   * 'output' messages to get only the final turn's text (untruncated).
   */
  private extractLastTurnText(history: WsServerMessage[]): string {
    // Find the last 'result' message index
    let lastResultIdx = -1
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].type === 'result') {
        lastResultIdx = i
        break
      }
    }

    // Find the second-to-last 'result' (or start of history) to get the last turn's output
    let prevResultIdx = -1
    if (lastResultIdx > 0) {
      for (let i = lastResultIdx - 1; i >= 0; i--) {
        if (history[i].type === 'result') {
          prevResultIdx = i
          break
        }
      }
    }

    // Collect output messages between prevResultIdx and lastResultIdx
    const startIdx = prevResultIdx + 1
    const endIdx = lastResultIdx >= 0 ? lastResultIdx : history.length
    let text = ''
    for (let i = startIdx; i < endIdx; i++) {
      const msg = history[i]
      if (msg.type === 'output') {
        text += (msg as { type: 'output'; data: string }).data
      }
    }

    return text.trim()
  }

  /** Extract structured artifacts from the task snapshot and session history. */
  private extractArtifacts(task: TaskEntry, session: Session): TaskArtifacts {
    // PR URL: search tool_done summaries and output messages
    let prUrl: string | null = null
    for (const msg of session.outputHistory) {
      if (prUrl) break
      const text = msg.type === 'output'
        ? (msg as { type: 'output'; data: string }).data
        : msg.type === 'tool_done'
          ? (msg as { type: 'tool_done'; summary?: string }).summary ?? ''
          : ''
      const match = text.match(PR_URL_RE)
      if (match) prUrl = match[0]
    }

    // Commit count: count tool_done events for git commit
    let commitCount = 0
    for (const msg of session.outputHistory) {
      if (msg.type === 'tool_done') {
        const toolDone = msg as { type: 'tool_done'; toolName: string; summary?: string }
        if (toolDone.toolName === 'Bash' && toolDone.summary?.includes('git commit')) {
          commitCount++
        }
      }
    }

    return {
      prUrl,
      branchName: task.request.branchName,
      filesChanged: [...task.snapshot.filesChanged],
      commitCount,
    }
  }

  // -------------------------------------------------------------------------
  // Prompt building
  // -------------------------------------------------------------------------

  private buildPrompt(request: TaskRequest, worktreeFailed: boolean): string {
    switch (request.taskType) {
      case 'implement':
        return this.buildImplementPrompt(request, worktreeFailed)
      case 'explore':
        return this.buildExplorePrompt(request)
      case 'review':
        return this.buildReviewPrompt(request)
      case 'research':
        return this.buildResearchPrompt(request)
    }
  }

  private buildImplementPrompt(request: TaskRequest, worktreeFailed: boolean): string {
    const inWorktree = request.useWorktree && !worktreeFailed
    const lines = [
      `# Task: ${request.task}`,
      '',
      '## Instructions',
      '',
      `You have been spawned by Agent ${getAgentDisplayName()} (the Codekin orchestrator) to implement a specific task in this repository.`,
      '',
      `**Task**: ${request.task}`,
      `**Branch**: \`${request.branchName}\``,
      '',
    ]

    if (inWorktree) {
      lines.push(
        '## Worktree Environment',
        '',
        `You are running in an **isolated git worktree** already on branch \`${request.branchName}\`.`,
        'You do NOT need to create or switch branches — just make your changes and commit directly.',
        '',
        '**IMPORTANT**: Do NOT use the `EnterWorktree` or `ExitWorktree` tools. This session is already managed in a worktree by Codekin. Using those tools will corrupt the worktree state and crash the session.',
        '',
      )
    }

    if (request.completionPolicy === 'pr') {
      if (inWorktree) {
        lines.push(
          '## Completion', '',
          '1. Make the necessary changes',
          '2. Commit your changes with a clear commit message',
          '3. Push the branch and create a Pull Request',
          '4. Include a clear PR description explaining what was changed and why', '',
        )
      } else {
        lines.push(
          '## Completion', '',
          `1. Create and switch to branch \`${request.branchName}\``,
          '2. Make the necessary changes',
          '3. Commit your changes with a clear commit message',
          '4. Push the branch and create a Pull Request',
          '5. Include a clear PR description explaining what was changed and why', '',
        )
      }
    } else if (request.completionPolicy === 'merge') {
      lines.push(
        '## Completion', '',
        '1. Make the necessary changes on the current branch',
        '2. Commit your changes with a clear commit message',
        '3. Push directly to the current branch', '',
      )
    } else {
      lines.push(
        '## Completion', '',
        '1. Make the necessary changes',
        '2. Commit your changes with a clear commit message',
        '3. Do NOT push — just commit locally', '',
      )
    }

    lines.push(
      '## Guidelines', '',
      '- Keep changes minimal and focused on the task',
      '- Do not refactor unrelated code',
      '- If you encounter issues that block the task, explain what went wrong',
      '- When done, provide a brief summary of what you changed',
    )

    if (worktreeFailed) {
      lines.push(
        '', '## Worktree Not Available', '',
        'A git worktree could not be created for isolation. You are working **directly in the main repository**.',
        'Be extra careful with git operations — do NOT force-push, reset, or make destructive changes to existing branches.',
        `Create branch \`${request.branchName}\` before making any changes.`,
        '',
        '**IMPORTANT**: Do NOT use the `EnterWorktree` or `ExitWorktree` tools — worktree creation already failed, and retrying will not help.',
      )
    }

    return lines.join('\n')
  }

  private buildExplorePrompt(request: TaskRequest): string {
    return [
      `# Task: ${request.task}`,
      '',
      '## Instructions',
      '',
      `You have been spawned by Agent ${getAgentDisplayName()} (the Codekin orchestrator) to explore and report on a codebase area.`,
      '',
      `**Task**: ${request.task}`,
      '',
      '## Guidelines',
      '',
      '- **Do NOT make any code changes.** This is a read-only exploration task.',
      '- Use Read, Glob, Grep, and other read-only tools to understand the codebase.',
      '- Be thorough but focused — explore what was asked, not the entire repo.',
      '- When done, provide a **structured summary** of your findings:',
      '  - Key files and their purposes',
      '  - Architecture patterns observed',
      '  - Notable findings, issues, or concerns',
      '  - Specific answers to any questions in the task description',
      '- Include file paths and line numbers for reference.',
    ].join('\n')
  }

  private buildReviewPrompt(request: TaskRequest): string {
    return [
      `# Task: ${request.task}`,
      '',
      '## Instructions',
      '',
      `You have been spawned by Agent ${getAgentDisplayName()} (the Codekin orchestrator) to review code.`,
      '',
      `**Task**: ${request.task}`,
      '',
      '## Guidelines',
      '',
      '- **Do NOT make any code changes.** This is a review task.',
      '- Read the relevant code and provide actionable feedback.',
      '- Organize feedback by severity: critical > important > minor > style',
      '- For each finding, include:',
      '  - File path and line number',
      '  - What the issue is',
      '  - Why it matters',
      '  - Suggested fix (if applicable)',
      '- Be pragmatic — focus on real issues, not nitpicks.',
    ].join('\n')
  }

  private buildResearchPrompt(request: TaskRequest): string {
    return [
      `# Task: ${request.task}`,
      '',
      '## Instructions',
      '',
      `You have been spawned by Agent ${getAgentDisplayName()} (the Codekin orchestrator) to research a question about this codebase.`,
      '',
      `**Question**: ${request.task}`,
      '',
      '## Guidelines',
      '',
      '- **Do NOT make any code changes.** This is a research task.',
      '- Search the codebase to find the answer.',
      '- Provide a clear, concise answer with references to specific files and line numbers.',
      '- If the answer requires understanding multiple files or systems, explain the connections.',
      '- If you cannot find a definitive answer, say so and explain what you did find.',
    ].join('\n')
  }

  // -------------------------------------------------------------------------
  // Event queue and delivery
  // -------------------------------------------------------------------------

  private queueEvent(taskId: string, type: TaskEventType, payload: TaskEvent['payload']): void {
    const event: TaskEvent = {
      id: makeEventId(),
      taskId,
      type,
      timestamp: new Date().toISOString(),
      delivered: false,
      payload,
    }
    this.events.push(event)

    // Cap events
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-MAX_EVENTS)
    }

    // Try immediate delivery if Joe is idle
    this.deliverPendingEvents()
  }

  /** Deliver pending events to the orchestrator session if it's idle. */
  private deliverPendingEvents(): void {
    const orchestratorId = this.orchestratorIdFn()
    if (!orchestratorId) return

    const session = this.sessions.get(orchestratorId)
    if (!session?.claudeProcess?.isAlive()) return
    if (session.isProcessing) return

    const pending = this.events.filter(e => !e.delivered)
    if (pending.length === 0) return

    const message = this.formatEventBatch(pending)
    this.sessions.sendInput(orchestratorId, message)
    for (const e of pending) e.delivered = true
  }

  /** Format a batch of events into a human-readable message for Joe. */
  private formatEventBatch(events: TaskEvent[]): string {
    const lines = [`[Task Board — ${events.length} update${events.length > 1 ? 's' : ''}]`, '']

    for (const event of events) {
      const task = this.tasks.get(event.taskId)
      const taskDesc = task ? `"${task.request.task}"` : event.taskId
      const repo = task ? task.request.repo.split('/').pop() : 'unknown'

      switch (event.type) {
        case 'completed': {
          const duration = task?.result?.duration ? formatDuration(task.result.duration) : '?'
          lines.push(`COMPLETED: ${taskDesc} (${repo}) — ${duration}`)
          if (event.payload.summary) {
            lines.push(`  ${event.payload.summary.slice(0, 300)}`)
          }
          if (event.payload.artifacts?.prUrl) {
            lines.push(`  PR: ${event.payload.artifacts.prUrl}`)
          }
          if (event.payload.artifacts?.filesChanged?.length) {
            lines.push(`  Files changed: ${event.payload.artifacts.filesChanged.length}`)
          }
          break
        }
        case 'failed':
          lines.push(`FAILED: ${taskDesc} (${repo})`)
          if (event.payload.error) {
            lines.push(`  Error: ${event.payload.error.slice(0, 300)}`)
          }
          break
        case 'stuck':
          lines.push(`STUCK: ${taskDesc} (${repo})`)
          if (event.payload.approval) {
            lines.push(`  Waiting for approval: ${event.payload.approval.toolName}`)
            lines.push(`  Blocked since: ${event.payload.approval.since}`)
            lines.push(`  Task ID: ${event.taskId} | Request ID: ${event.payload.approval.requestId}`)
          }
          break
        case 'timed_out':
          lines.push(`TIMED OUT: ${taskDesc} (${repo})`)
          if (event.payload.error) {
            lines.push(`  ${event.payload.error}`)
          }
          break
        case 'approval_needed':
          lines.push(`APPROVAL NEEDED: ${taskDesc} (${repo})`)
          if (event.payload.approval) {
            lines.push(`  Tool: ${event.payload.approval.toolName}`)
            lines.push(`  Task ID: ${event.taskId} | Request ID: ${event.payload.approval.requestId}`)
          }
          break
        case 'cancelled':
          lines.push(`CANCELLED: ${taskDesc} (${repo})`)
          if (event.payload.error) {
            lines.push(`  ${event.payload.error}`)
          }
          break
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  private startTimeoutTimer(task: TaskEntry): void {
    const timeoutMs = task.request.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
    setTimeout(() => {
      if (task.status !== 'running' && task.status !== 'starting') return
      const session = this.sessions.get(task.id)
      if (session?.claudeProcess?.isAlive()) {
        session.claudeProcess.stop()
      }
      this.markTaskTerminal(task, 'timed_out', `Timed out after ${formatDuration(timeoutMs)}`)
    }, timeoutMs)
  }

  private startStuckTimer(taskId: string): void {
    const existing = this.stuckTimers.get(taskId)
    if (existing) clearTimeout(existing)

    this.stuckTimers.set(taskId, setTimeout(() => {
      const task = this.tasks.get(taskId)
      if (!task || task.snapshot.state !== 'waiting_for_approval') return
      this.queueEvent(taskId, 'stuck', {
        approval: task.snapshot.pendingApproval
          ? { requestId: task.snapshot.pendingApproval.requestId, toolName: task.snapshot.pendingApproval.toolName, since: task.snapshot.pendingApproval.since }
          : undefined,
        error: 'Pending approval timed out after 5 minutes',
      })
    }, STUCK_TIMEOUT_MS))
  }

  // -------------------------------------------------------------------------
  // File tracking from tool events
  // -------------------------------------------------------------------------

  private trackFileFromTool(task: TaskEntry, toolName: string, input: string | undefined, phase: 'active' | 'done'): void {
    if (!input) return

    // On tool_active: track files being read or written
    if (phase === 'active') {
      const readTools = new Set(['Read', 'Glob', 'Grep'])
      const writeTools = new Set(['Write', 'Edit'])

      if (readTools.has(toolName)) {
        const path = this.extractFilePath(input)
        if (path && task.snapshot.filesRead.length < MAX_FILES_TRACKED && !task.snapshot.filesRead.includes(path)) {
          task.snapshot.filesRead.push(path)
        }
      } else if (writeTools.has(toolName)) {
        const path = this.extractFilePath(input)
        if (path && task.snapshot.filesChanged.length < MAX_FILES_TRACKED && !task.snapshot.filesChanged.includes(path)) {
          task.snapshot.filesChanged.push(path)
        }
      }
    }
  }

  /** Try to extract a file path from a tool input string. */
  private extractFilePath(input: string): string | null {
    // Tool input is typically JSON-ish. Try to parse.
    try {
      const parsed: unknown = JSON.parse(input)
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as Record<string, unknown>
        // Common patterns: { file_path: "..." }, { path: "..." }, { file: "..." }
        const val = obj.file_path ?? obj.path ?? obj.file
        return typeof val === 'string' ? val : null
      }
    } catch {
      // Not JSON — try to find a path-like string
      const match = input.match(/(?:^|\s)(\/[^\s]+)/)?.[1]
      return match ?? null
    }
    return null
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private markTaskTerminal(task: TaskEntry, status: TaskStatus, error: string | null): void {
    // Only transition to terminal if not already terminal
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'timed_out' || task.status === 'cancelled') return

    task.status = status
    task.error = error
    task.completedAt = new Date().toISOString()

    // Clear stuck timer
    const timer = this.stuckTimers.get(task.id)
    if (timer) {
      clearTimeout(timer)
      this.stuckTimers.delete(task.id)
    }

    // Clear processing flag on the session
    this.sessions.clearProcessingFlag(task.id)

    // Queue event
    const eventType: TaskEventType = status === 'completed' ? 'completed'
      : status === 'timed_out' ? 'timed_out'
      : status === 'cancelled' ? 'cancelled' : 'failed'
    this.queueEvent(task.id, eventType, {
      summary: task.result?.summary,
      error: task.error ?? undefined,
      artifacts: task.result?.artifacts,
    })
  }

  /**
   * For implement tasks: check if the completion step was done.
   * If not, send a nudge. Returns true if a nudge was sent (keep monitoring).
   */
  private nudgeIfNeeded(task: TaskEntry, session: Session): boolean {
    // Only nudge once (check if we've already sent more than the initial prompt)
    if (task.snapshot.turnCount > 2) return false

    const history = session.outputHistory
    const text = history
      .filter((m): m is Extract<WsServerMessage, { type: 'output' }> => m.type === 'output')
      .map(m => m.data)
      .join('')
      .toLowerCase()

    const policy = task.request.completionPolicy

    if (policy === 'pr') {
      const prCreated = text.includes('pull request') || text.includes('created a pr') || text.includes('gh pr create')
      if (!prCreated && session.claudeProcess?.isAlive()) {
        this.sessions.sendInput(task.id, 'You completed the code changes but did not create a Pull Request. Please push your branch and create a PR now with a clear description of what was changed and why.')
        return true
      }
    } else if (policy === 'merge') {
      const pushed = text.includes('git push') || text.includes('pushed')
      if (!pushed && session.claudeProcess?.isAlive()) {
        this.sessions.sendInput(task.id, 'You completed the code changes but did not push them. Please push your changes to the remote now.')
        return true
      }
    }

    return false
  }

  /** Get tool input for a pending approval from the session. */
  private getPendingToolInput(session: Session | undefined, requestId: string | undefined): Record<string, unknown> | undefined {
    if (!session || !requestId) return undefined
    const toolApproval = session.pendingToolApprovals.get(requestId)
    if (toolApproval) return toolApproval.toolInput
    const controlReq = session.pendingControlRequests.get(requestId)
    if (controlReq) return controlReq.toolInput
    return undefined
  }

  /** Purge completed/failed tasks older than the retention period. */
  private purgeStaleTasks(): void {
    const now = Date.now()
    for (const [id, task] of this.tasks) {
      if (task.status === 'starting' || task.status === 'running') continue
      if (task.completedAt && now - new Date(task.completedAt).getTime() > TASK_RETENTION_MS) {
        this.tasks.delete(id)
      }
    }
    // Hard cap
    if (this.tasks.size > MAX_RETAINED_TASKS) {
      const completed = Array.from(this.tasks.entries())
        .filter(([, t]) => t.status !== 'starting' && t.status !== 'running')
        .sort((a, b) => (a[1].completedAt ?? '').localeCompare(b[1].completedAt ?? ''))
      while (this.tasks.size > MAX_RETAINED_TASKS && completed.length > 0) {
        const [id] = completed.shift()!
        this.tasks.delete(id)
      }
    }
  }
}
