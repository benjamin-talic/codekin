/**
 * Polls orchestrator child sessions for the task board panel.
 *
 * Returns a list of TaskBoardEntry objects, refreshing every 10 seconds.
 * Only polls while the orchestrator view is active (token is truthy).
 */

import { useState, useEffect, useCallback } from 'react'
import type { TaskBoardEntry } from '../types'
import { listTaskBoardEntries } from '../lib/ccApi'

const POLL_INTERVAL_MS = 10_000

export function useTaskBoard(token: string | undefined) {
  const [entries, setEntries] = useState<TaskBoardEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const data = await listTaskBoardEntries(token)
      setEntries(data)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch tasks')
    } finally {
      setLoading(false)
    }
  }, [token])

  // Initial fetch + polling
  useEffect(() => {
    if (!token) return

    void refresh()
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [token, refresh])

  return { entries, loading, error, refresh }
}
