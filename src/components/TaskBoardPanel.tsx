/**
 * Task Board panel — right sidebar showing orchestrator sub-agent tasks.
 * Follows the DiffPanel resize/layout pattern.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import { IconX, IconCheck, IconAlertTriangle, IconLoader2, IconPlayerPlay, IconSend, IconRefresh, IconExternalLink, IconClock } from '@tabler/icons-react'
import type { TaskBoardEntry, TaskBoardStatus } from '../types'
import { useTaskBoard } from '../hooks/useTaskBoard'

const MIN_WIDTH = 320
const MAX_WIDTH = 800
const DEFAULT_WIDTH = 400
const STORAGE_KEY = 'codekin-taskboard-width'

interface TaskBoardPanelProps {
  isOpen: boolean
  onClose: () => void
  token: string
  onViewSession: (sessionId: string) => void
}

/** Format ms as "Xm Ys" */
function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const rem = secs % 60
  return `${mins}m ${rem}s`
}

/** Live timer that counts up from a start time. */
function LiveTimer({ since }: { since: string }) {
  const [elapsed, setElapsed] = useState(() => Date.now() - new Date(since).getTime())
  useEffect(() => {
    const interval = setInterval(() => setElapsed(Date.now() - new Date(since).getTime()), 1000)
    return () => clearInterval(interval)
  }, [since])
  return <span>{formatDuration(elapsed)}</span>
}

/** Get a short repo name from a full path. */
function repoName(path: string): string {
  return path.split('/').pop() || path
}

/** Status badge component. */
function StatusBadge({ status }: { status: TaskBoardStatus }) {
  const config: Record<TaskBoardStatus, { label: string; className: string }> = {
    starting: { label: 'Starting', className: 'bg-neutral-9 text-neutral-3' },
    running: { label: 'Running', className: 'bg-primary-9 text-primary-1' },
    completed: { label: 'Completed', className: 'bg-success-9 text-success-1' },
    failed: { label: 'Failed', className: 'bg-error-9 text-error-1' },
    timed_out: { label: 'Timed Out', className: 'bg-warning-9 text-warning-1' },
  }
  const c = config[status]
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${c.className}`}>{c.label}</span>
}

/** Task type badge. */
function TypeBadge({ type }: { type: string }) {
  return <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-10 text-neutral-4">{type}</span>
}

/** A single task card. */
function TaskCard({
  task,
  onApprove,
  onDeny,
  onViewSession,
  onRetry,
  onSendMessage,
}: {
  task: TaskBoardEntry
  onApprove: (taskId: string, requestId: string) => void
  onDeny: (taskId: string, requestId: string) => void
  onViewSession: (sessionId: string) => void
  onRetry: (taskId: string) => void
  onSendMessage: (taskId: string, message: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [messageInput, setMessageInput] = useState('')
  const [showMessageInput, setShowMessageInput] = useState(false)

  const isTerminal = task.status === 'completed' || task.status === 'failed' || task.status === 'timed_out'
  const needsApproval = task.snapshot.state === 'waiting_for_approval' && task.snapshot.pendingApproval

  return (
    <div className={`rounded-lg border p-3 mb-2 ${
      needsApproval
        ? 'border-warning-7 bg-warning-12/50'
        : task.status === 'running'
          ? 'border-primary-8 bg-neutral-11/50'
          : task.status === 'completed'
            ? 'border-success-8/50 bg-neutral-11/50'
            : task.status === 'failed' || task.status === 'timed_out'
              ? 'border-error-8/50 bg-neutral-11/50'
              : 'border-neutral-9 bg-neutral-11/50'
    }`}>
      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-1">
        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
          <StatusBadge status={task.status} />
          <TypeBadge type={task.request.taskType} />
          <span className="text-xs text-neutral-5">{repoName(task.request.repo)}</span>
        </div>
        <button
          onClick={() => onViewSession(task.id)}
          className="text-neutral-5 hover:text-neutral-2 flex-shrink-0"
          title="View in session"
        >
          <IconExternalLink size={14} />
        </button>
      </div>

      {/* Task description */}
      <p className="text-sm text-neutral-2 mb-2 line-clamp-2">{task.request.task}</p>

      {/* Running state: snapshot info */}
      {task.status === 'running' && (
        <div className="text-xs text-neutral-5 space-y-0.5 mb-2">
          <div className="flex items-center gap-1">
            <IconClock size={12} />
            <LiveTimer since={task.startedAt} />
            <span className="mx-1">|</span>
            Turn {task.snapshot.turnCount}
            {task.snapshot.filesChanged.length > 0 && (
              <><span className="mx-1">|</span>{task.snapshot.filesChanged.length} files changed</>
            )}
          </div>
          {task.snapshot.activeTool && (
            <div className="flex items-center gap-1">
              <IconLoader2 size={12} className="animate-spin" />
              <span className="truncate">{task.snapshot.activeTool}</span>
            </div>
          )}
        </div>
      )}

      {/* Needs approval */}
      {needsApproval && task.snapshot.pendingApproval && (
        <div className="mb-2">
          <div className="text-xs text-warning-4 mb-1.5 flex items-center gap-1">
            <IconAlertTriangle size={12} />
            <span className="font-medium">{task.snapshot.pendingApproval.toolName}</span>
          </div>
          <div className="flex gap-1.5">
            <button
              onClick={() => onApprove(task.id, task.snapshot.pendingApproval!.requestId)}
              className="text-xs px-2 py-1 rounded bg-success-9 text-success-1 hover:bg-success-8 transition-colors"
            >
              Approve
            </button>
            <button
              onClick={() => onDeny(task.id, task.snapshot.pendingApproval!.requestId)}
              className="text-xs px-2 py-1 rounded bg-error-9 text-error-1 hover:bg-error-8 transition-colors"
            >
              Deny
            </button>
          </div>
        </div>
      )}

      {/* Completed: result summary */}
      {task.status === 'completed' && task.result && (
        <div className="text-xs text-neutral-4 space-y-1 mb-2">
          <div className="flex items-center gap-1">
            <IconCheck size={12} className="text-success-5" />
            <span>{formatDuration(task.result.duration)}</span>
            {task.result.artifacts.filesChanged.length > 0 && (
              <><span className="mx-1">|</span>{task.result.artifacts.filesChanged.length} files</>
            )}
            {task.result.artifacts.prUrl && (
              <a
                href={task.result.artifacts.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary-5 hover:text-primary-4 ml-1"
              >
                PR
              </a>
            )}
          </div>
          {task.result.summary && (
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-neutral-5 hover:text-neutral-3 underline-offset-2 hover:underline"
            >
              {expanded ? 'Hide summary' : 'Show summary'}
            </button>
          )}
          {expanded && task.result.summary && (
            <pre className="text-xs text-neutral-4 bg-neutral-12 rounded p-2 mt-1 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {task.result.summary}
            </pre>
          )}
        </div>
      )}

      {/* Failed: error */}
      {(task.status === 'failed' || task.status === 'timed_out') && task.error && (
        <div className="text-xs text-error-4 mb-2 flex items-start gap-1">
          <IconAlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          <span className="line-clamp-3">{task.error}</span>
        </div>
      )}

      {/* Actions for terminal tasks */}
      {isTerminal && (
        <div className="flex gap-1.5">
          {(task.status === 'failed' || task.status === 'timed_out') && (
            <button
              onClick={() => onRetry(task.id)}
              className="text-xs px-2 py-1 rounded border border-neutral-8 text-neutral-4 hover:bg-neutral-10 transition-colors flex items-center gap-1"
            >
              <IconRefresh size={12} /> Retry
            </button>
          )}
        </div>
      )}

      {/* Send message (for running tasks) */}
      {task.status === 'running' && !needsApproval && (
        <>
          {!showMessageInput ? (
            <button
              onClick={() => setShowMessageInput(true)}
              className="text-xs text-neutral-5 hover:text-neutral-3 flex items-center gap-1"
            >
              <IconSend size={12} /> Send message
            </button>
          ) : (
            <div className="flex gap-1.5 mt-1">
              <input
                type="text"
                value={messageInput}
                onChange={(e) => setMessageInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && messageInput.trim()) {
                    onSendMessage(task.id, messageInput.trim())
                    setMessageInput('')
                    setShowMessageInput(false)
                  }
                  if (e.key === 'Escape') setShowMessageInput(false)
                }}
                placeholder="Type a message..."
                className="flex-1 text-xs px-2 py-1 rounded bg-neutral-11 border border-neutral-8 text-neutral-2 placeholder:text-neutral-6 focus:outline-none focus:border-primary-7"
                autoFocus
              />
              <button
                onClick={() => {
                  if (messageInput.trim()) {
                    onSendMessage(task.id, messageInput.trim())
                    setMessageInput('')
                    setShowMessageInput(false)
                  }
                }}
                className="text-xs px-2 py-1 rounded bg-primary-9 text-primary-1 hover:bg-primary-8"
              >
                <IconSend size={12} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function TaskBoardPanel({ isOpen, onClose, token, onViewSession }: TaskBoardPanelProps) {
  const { tasks, approve, sendMessage: sendMsg, retry } = useTaskBoard(token, isOpen)
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(stored))) : DEFAULT_WIDTH
  })

  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // Persist width
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(width))
  }, [width])

  // Resize drag handler
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = startX.current - ev.clientX
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta)))
    }
    const onMouseUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [width])

  // Escape to close
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isOpen, onClose])

  if (!isOpen) return null

  // Group tasks by status priority
  const needsApproval = tasks.filter(t => t.snapshot.state === 'waiting_for_approval')
  const running = tasks.filter(t => (t.status === 'running' || t.status === 'starting') && t.snapshot.state !== 'waiting_for_approval')
  const completed = tasks.filter(t => t.status === 'completed')
  const failed = tasks.filter(t => t.status === 'failed' || t.status === 'timed_out')

  const handleApprove = (taskId: string, requestId: string) => void approve(taskId, requestId, 'allow')
  const handleDeny = (taskId: string, requestId: string) => void approve(taskId, requestId, 'deny')
  const handleRetry = (taskId: string) => void retry(taskId)
  const handleSendMessage = (taskId: string, message: string) => void sendMsg(taskId, message)

  const totalActive = needsApproval.length + running.length

  return (
    <div
      className="relative flex flex-col h-full bg-neutral-12 border-l border-neutral-9 overflow-hidden"
      style={{ width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent-6/40 z-20"
        onMouseDown={onDragStart}
      />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-neutral-9">
        <div className="flex items-center gap-2">
          <IconPlayerPlay size={16} className="text-accent-5" />
          <span className="text-sm font-medium text-neutral-2">Task Board</span>
          {totalActive > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-accent-9 text-accent-1">
              {totalActive}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-neutral-5 hover:text-neutral-2">
          <IconX size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-3 py-2">
        {tasks.length === 0 && (
          <div className="text-center text-neutral-6 text-sm py-8">
            No tasks yet. Ask the orchestrator to spawn tasks.
          </div>
        )}

        {needsApproval.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-medium text-warning-4 uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <IconAlertTriangle size={12} />
              Needs Approval ({needsApproval.length})
            </div>
            {needsApproval.map(t => (
              <TaskCard key={t.id} task={t} onApprove={handleApprove} onDeny={handleDeny} onViewSession={onViewSession} onRetry={handleRetry} onSendMessage={handleSendMessage} />
            ))}
          </div>
        )}

        {running.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-medium text-primary-4 uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <IconLoader2 size={12} className="animate-spin" />
              Running ({running.length})
            </div>
            {running.map(t => (
              <TaskCard key={t.id} task={t} onApprove={handleApprove} onDeny={handleDeny} onViewSession={onViewSession} onRetry={handleRetry} onSendMessage={handleSendMessage} />
            ))}
          </div>
        )}

        {completed.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-medium text-success-5 uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <IconCheck size={12} />
              Completed ({completed.length})
            </div>
            {completed.map(t => (
              <TaskCard key={t.id} task={t} onApprove={handleApprove} onDeny={handleDeny} onViewSession={onViewSession} onRetry={handleRetry} onSendMessage={handleSendMessage} />
            ))}
          </div>
        )}

        {failed.length > 0 && (
          <div className="mb-3">
            <div className="text-xs font-medium text-error-4 uppercase tracking-wider mb-1.5 flex items-center gap-1">
              <IconAlertTriangle size={12} />
              Failed ({failed.length})
            </div>
            {failed.map(t => (
              <TaskCard key={t.id} task={t} onApprove={handleApprove} onDeny={handleDeny} onViewSession={onViewSession} onRetry={handleRetry} onSendMessage={handleSendMessage} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
