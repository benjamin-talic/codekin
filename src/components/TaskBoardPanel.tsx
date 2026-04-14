/**
 * TaskBoardPanel — right sidebar panel showing orchestrator child sessions.
 *
 * Displays task cards grouped by status (active first, then completed/failed).
 * Each card shows the task description, repo, branch, elapsed time, status
 * badge, and action buttons (stop for running, retry for failed).
 */

import { useState } from 'react'
import {
  IconCheck, IconX, IconLoader2, IconClock,
  IconPlayerStop, IconMinus, IconRefresh, IconAlertTriangle,
} from '@tabler/icons-react'
import type { TaskBoardEntry, TaskBoardStatus } from '../types'
import { stopTask } from '../lib/ccApi'

interface Props {
  entries: TaskBoardEntry[]
  onRefresh: () => void
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

function TaskStatusBadge({ status }: { status: TaskBoardStatus }) {
  switch (status) {
    case 'starting':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-7/60 bg-neutral-9/40 px-2.5 py-0.5 text-[13px] font-medium text-neutral-4">
          <IconClock size={12} stroke={2} />
          starting
        </span>
      )
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-7/60 bg-accent-9/40 px-2.5 py-0.5 text-[13px] font-medium text-accent-4">
          <IconLoader2 size={12} stroke={2} className="animate-spin" />
          running
        </span>
      )
    case 'completed':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success-7/60 bg-success-8/40 px-2.5 py-0.5 text-[13px] font-medium text-success-4">
          <IconCheck size={12} stroke={2.5} />
          completed
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-error-7/60 bg-error-9/40 px-2.5 py-0.5 text-[13px] font-medium text-error-4">
          <IconX size={12} stroke={2.5} />
          failed
        </span>
      )
    case 'timed_out':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-7/60 bg-warning-9/40 px-2.5 py-0.5 text-[13px] font-medium text-warning-4">
          <IconAlertTriangle size={12} stroke={2} />
          timed out
        </span>
      )
    case 'cancelled':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-7/60 bg-warning-9/40 px-2.5 py-0.5 text-[13px] font-medium text-warning-4">
          <IconMinus size={12} stroke={2} />
          cancelled
        </span>
      )
  }
}

// ---------------------------------------------------------------------------
// Elapsed time helper
// ---------------------------------------------------------------------------

function formatElapsed(startedAt: string, completedAt: string | null): string {
  const start = new Date(startedAt).getTime()
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const seconds = Math.floor((end - start) / 1000)
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

function repoShortName(repo: string): string {
  const parts = repo.split('/')
  return parts[parts.length - 1] || repo
}

// ---------------------------------------------------------------------------
// Status ordering for grouping
// ---------------------------------------------------------------------------

const STATUS_ORDER: Record<TaskBoardStatus, number> = {
  running: 0,
  starting: 1,
  failed: 2,
  timed_out: 3,
  cancelled: 4,
  completed: 5,
}

// ---------------------------------------------------------------------------
// Task card
// ---------------------------------------------------------------------------

function TaskCard({ entry, onRefresh }: { entry: TaskBoardEntry; onRefresh: () => void }) {
  const [stopping, setStopping] = useState(false)
  const [confirmStop, setConfirmStop] = useState(false)
  const isActive = entry.status === 'running' || entry.status === 'starting'

  async function handleStop() {
    if (!confirmStop) {
      setConfirmStop(true)
      return
    }
    setStopping(true)
    try {
      await stopTask(entry.id)
      onRefresh()
    } catch {
      // Refresh anyway to get latest state
      onRefresh()
    } finally {
      setStopping(false)
      setConfirmStop(false)
    }
  }

  return (
    <div className="rounded-lg border border-neutral-8/60 bg-neutral-11/80 p-3">
      {/* Header: repo + badge */}
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-[12px] text-neutral-5 font-medium truncate">
          {repoShortName(entry.repo)}
        </span>
        <TaskStatusBadge status={entry.status} />
      </div>

      {/* Task description */}
      <p className="text-[14px] text-neutral-2 leading-snug mb-2 line-clamp-2">
        {entry.task}
      </p>

      {/* Branch + timer */}
      <div className="flex items-center justify-between text-[12px] text-neutral-5 mb-2">
        <span className="truncate max-w-[60%]" title={entry.branchName}>
          {entry.branchName}
        </span>
        <span>{formatElapsed(entry.startedAt, entry.completedAt)}</span>
      </div>

      {/* Error message for failed tasks */}
      {entry.error && (
        <div className="text-[12px] text-error-4 bg-error-9/20 rounded px-2 py-1 mb-2 line-clamp-2">
          {entry.error}
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-1.5">
        {isActive && (
          <button
            onClick={handleStop}
            disabled={stopping}
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium transition-colors ${
              confirmStop
                ? 'bg-error-9/60 text-error-3 border border-error-7/60 hover:bg-error-8/60'
                : 'text-neutral-4 hover:text-error-4 hover:bg-neutral-9'
            }`}
            title={confirmStop ? 'Click again to confirm' : 'Stop task'}
          >
            {stopping ? (
              <IconLoader2 size={13} stroke={2} className="animate-spin" />
            ) : (
              <IconPlayerStop size={13} stroke={2} />
            )}
            {confirmStop ? 'Confirm stop' : 'Stop'}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function TaskBoardPanel({ entries, onRefresh }: Props) {
  if (entries.length === 0) return null

  const sorted = [...entries].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
  const activeCount = entries.filter(e => e.status === 'running' || e.status === 'starting').length

  return (
    <div className="w-72 border-l border-neutral-10 bg-neutral-12 flex flex-col overflow-hidden shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-neutral-10">
        <span className="text-[13px] font-semibold text-neutral-2 uppercase tracking-wider flex items-center gap-1.5">
          {activeCount > 0 && <span className="inline-block h-1.5 w-1.5 rounded-full bg-accent-5 animate-pulse" />}
          Tasks
          <span className={`text-[13px] font-medium ml-1 ${activeCount > 0 ? 'text-accent-4' : 'text-neutral-5'}`}>
            {entries.length}
          </span>
        </span>
        <button
          onClick={onRefresh}
          className="rounded p-1 text-neutral-4 hover:text-neutral-2 hover:bg-neutral-9 transition-colors"
          title="Refresh"
        >
          <IconRefresh size={14} stroke={2} />
        </button>
      </div>

      {/* Task list */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {sorted.map(entry => (
          <TaskCard key={entry.id} entry={entry} onRefresh={onRefresh} />
        ))}
      </div>
    </div>
  )
}
