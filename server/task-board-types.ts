/**
 * Type definitions for the Task Board system.
 *
 * The Task Board is an evolution of OrchestratorChildManager that supports
 * multiple task types, structured results, real-time snapshots, and
 * event-based delivery to the orchestrator session.
 */

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

/** The kind of work a task performs. */
export type TaskType = 'implement' | 'explore' | 'review' | 'research'

/** Lifecycle status of a task. */
export type TaskStatus = 'starting' | 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled'

/** Real-time state of the child session behind a task. */
export type TaskState = 'idle' | 'processing' | 'waiting_for_approval' | 'exited'

// ---------------------------------------------------------------------------
// Task request (what the caller provides)
// ---------------------------------------------------------------------------

export interface TaskRequest {
  /** Absolute path to the target repository. */
  repo: string
  /** Human-readable description of the work to do. */
  task: string
  /** Git branch name. Required for 'implement', auto-generated for others. */
  branchName: string
  /** What kind of work this is. */
  taskType: TaskType
  /** How changes should land. 'none' for explore/research tasks. */
  completionPolicy: 'pr' | 'merge' | 'commit-only' | 'none'
  /** Use a git worktree for isolation (default true for implement). */
  useWorktree: boolean
  /** Timeout in ms (default 10 minutes). */
  timeoutMs?: number
  /** Optional model override (e.g. 'claude-sonnet-4-6'). */
  model?: string
  /** Optional allowedTools override. */
  allowedTools?: string[]
}

// ---------------------------------------------------------------------------
// Snapshot (real-time progress, updated from session events)
// ---------------------------------------------------------------------------

export interface ToolSequenceEntry {
  toolName: string
  summary?: string
  completedAt: string
}

export interface PendingApproval {
  requestId: string
  toolName: string
  toolInput: Record<string, unknown>
  since: string
}

export interface TaskSnapshot {
  /** Current state of the child session. */
  state: TaskState
  /** Tool currently being executed, or null. */
  activeTool: string | null
  /** Tool input for the active tool (display hint). */
  activeToolInput: string | null
  /** Number of completed Claude turns. */
  turnCount: number
  /** Last 5 tool completions (ring buffer). */
  lastToolSequence: ToolSequenceEntry[]
  /** Files read by the child session (deduplicated, capped at 50). */
  filesRead: string[]
  /** Files changed by the child session (deduplicated, capped at 50). */
  filesChanged: string[]
  /** Pending approval details, if the child is blocked. */
  pendingApproval: PendingApproval | null
}

// ---------------------------------------------------------------------------
// Result (structured output, replaces raw text dump)
// ---------------------------------------------------------------------------

export interface TaskArtifacts {
  /** URL of the pull request, if created. */
  prUrl: string | null
  /** Branch name used for changes. */
  branchName: string | null
  /** List of files that were modified. */
  filesChanged: string[]
  /** Number of git commits made. */
  commitCount: number
}

export interface TaskResult {
  /** Last assistant message, capped at MAX_SUMMARY_LENGTH chars. */
  summary: string
  /** Full untruncated output from the last assistant turn. */
  fullOutput: string
  /** Structured artifacts parsed from session events. */
  artifacts: TaskArtifacts
  /** Duration from start to completion in milliseconds. */
  duration: number
}

// ---------------------------------------------------------------------------
// Task entry (the main record)
// ---------------------------------------------------------------------------

export interface TaskEntry {
  /** Session ID of the child session. */
  id: string
  /** What was requested. */
  request: TaskRequest
  /** Current lifecycle status. */
  status: TaskStatus
  /** Real-time progress snapshot. */
  snapshot: TaskSnapshot
  /** Structured result (set on completion). */
  result: TaskResult | null
  /** Error message (set on failure). */
  error: string | null
  /** ISO timestamp when the task was created. */
  startedAt: string
  /** ISO timestamp when the task reached a terminal state. */
  completedAt: string | null
}

// ---------------------------------------------------------------------------
// Events (queued for delivery to the orchestrator)
// ---------------------------------------------------------------------------

export type TaskEventType = 'completed' | 'failed' | 'stuck' | 'timed_out' | 'approval_needed' | 'cancelled'

export interface TaskEvent {
  /** Unique event ID. */
  id: string
  /** The task this event relates to. */
  taskId: string
  /** What happened. */
  type: TaskEventType
  /** ISO timestamp. */
  timestamp: string
  /** Whether this event has been delivered to the orchestrator. */
  delivered: boolean
  /** Event-specific data. */
  payload: {
    summary?: string
    error?: string
    artifacts?: TaskArtifacts
    approval?: { requestId: string; toolName: string; since: string }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_CONCURRENT_TASKS = 5
export const DEFAULT_TASK_TIMEOUT_MS = 600_000        // 10 minutes
export const TASK_RETENTION_MS = 3_600_000             // 1 hour
export const MAX_RETAINED_TASKS = 100
export const MAX_TOOL_SEQUENCE_LENGTH = 5
export const MAX_FILES_TRACKED = 50
export const MAX_SUMMARY_LENGTH = 1000
export const MAX_EVENTS = 100
export const STUCK_TIMEOUT_MS = 5 * 60 * 1000         // 5 minutes
