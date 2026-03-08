/**
 * Pure utility functions and constants shared across workflow UI components.
 */

import type { WorkflowRun } from './workflowApi'

export type WorkflowCategory = 'assessment' | 'organizer' | 'executor'

export const WORKFLOW_KINDS = [
  { value: 'coverage.daily', label: 'Coverage Assessment', category: 'assessment' as WorkflowCategory },
  { value: 'code-review.daily', label: 'Code Review', category: 'assessment' as WorkflowCategory },
  { value: 'comment-assessment.daily', label: 'Comment Assessment', category: 'assessment' as WorkflowCategory },
  { value: 'dependency-health.daily', label: 'Dependency Health', category: 'assessment' as WorkflowCategory },
  { value: 'security-audit.weekly', label: 'Security Audit', category: 'assessment' as WorkflowCategory },
  { value: 'complexity.weekly', label: 'Complexity Report', category: 'assessment' as WorkflowCategory },
]

export const DAY_PATTERNS = [
  { label: 'Daily', dow: '*' },
  { label: 'Weekdays', dow: '1-5' },
  { label: 'Mon', dow: '1' },
  { label: 'Tue', dow: '2' },
  { label: 'Wed', dow: '3' },
  { label: 'Thu', dow: '4' },
  { label: 'Fri', dow: '5' },
  { label: 'Sat', dow: '6' },
  { label: 'Sun', dow: '0' },
]

/** Build a cron expression from an hour (0–23) and day-of-week pattern (e.g. "*", "1-5", "3"). */
export function buildCron(hour: number, dow: string): string {
  return `0 ${hour} * * ${dow}`
}

/** Parse a 5-field cron expression into hour and day-of-week components. Falls back to 6 AM daily. */
export function parseCron(expr: string): { hour: number; dow: string } {
  const parts = expr.trim().split(/\s+/)
  if (parts.length === 5) {
    return { hour: parseInt(parts[1]) || 0, dow: parts[4] }
  }
  return { hour: 6, dow: '*' }
}

/** Format a 24-hour integer (0–23) as a 12-hour time string, e.g. `6` → `"6:00 AM"`. */
export function formatHour(h: number): string {
  if (h === 0) return '12:00 AM'
  if (h < 12) return `${h}:00 AM`
  if (h === 12) return '12:00 PM'
  return `${h - 12}:00 PM`
}

/** Convert a 5-field cron expression into a human-readable description, e.g. `"Daily at 06:00"`. */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, , , dow] = parts
  const pad = (n: string) => n.length === 1 ? `0${n}` : n
  const time = `${pad(hour)}:${pad(min)}`
  if (dow === '*') return `Daily at ${time}`
  if (dow === '1-5') return `Weekdays at ${time}`
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dayName = days[parseInt(dow)] ?? dow
  return `Weekly ${dayName} at ${time}`
}

/** Look up the display label for a workflow kind, e.g. `"coverage.daily"` → `"Coverage Assessment"`. */
export function kindLabel(kind: string): string {
  return WORKFLOW_KINDS.find(k => k.value === kind)?.label ?? kind
}

/** Look up the category for a workflow kind. Defaults to `"assessment"` for unknown kinds. */
export function kindCategory(kind: string): WorkflowCategory {
  return WORKFLOW_KINDS.find(k => k.value === kind)?.category ?? 'assessment'
}

/** Convert a string to a URL-safe slug: lowercase, non-alphanumeric chars replaced with hyphens. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Format the elapsed time between two ISO timestamps as a compact duration (e.g. `"3m"`, `"45s"`). Uses wall-clock time if still running. */
export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—'
  const end = completedAt ? new Date(completedAt) : new Date()
  const ms = end.getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

/** Format an ISO timestamp as a short locale string, e.g. `"Mar 8, 06:00 AM"`. Returns `"—"` for null. */
export function formatTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Extract a display-friendly repo name from a workflow run's input, falling back to the kind. */
export function repoNameFromRun(run: WorkflowRun): string {
  return (run.input.repoName as string)
    || (run.input.repoPath as string)?.split('/').pop()
    || run.kind
}

/** Return Tailwind CSS classes for a status badge background and text color. */
export function statusBadge(status: string): string {
  switch (status) {
    case 'succeeded': return 'bg-success-7 text-success-2'
    case 'failed':    return 'bg-error-8 text-error-2'
    case 'running':   return 'bg-accent-8 text-accent-2 animate-pulse'
    case 'queued':    return 'bg-neutral-8 text-neutral-3'
    case 'canceled':  return 'bg-warning-8 text-warning-2'
    case 'skipped':   return 'bg-neutral-8 text-neutral-5'
    default:          return 'bg-neutral-8 text-neutral-3'
  }
}
