/**
 * Task Board hook backed by the REST API.
 *
 * Polls the orchestrator's task board every 10 seconds when enabled.
 * Provides approve, sendMessage, and retry helpers that auto-refresh.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { TaskBoardEntry } from '../types'
import * as api from '../lib/ccApi'

export function useTaskBoard(token: string, enabled: boolean) {
  const [tasks, setTasks] = useState<TaskBoardEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!token || !enabled) return
    try {
      const list = await api.listTasks(token)
      setTasks(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    }
  }, [token, enabled])

  const approve = useCallback(async (taskId: string, requestId: string, value: string) => {
    if (!token) return
    setLoading(true)
    try {
      await api.approveTask(token, taskId, requestId, value)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve')
    } finally {
      setLoading(false)
    }
  }, [token, refresh])

  const sendMessage = useCallback(async (taskId: string, message: string) => {
    if (!token) return
    try {
      await api.sendTaskMessage(token, taskId, message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message')
    }
  }, [token])

  const retry = useCallback(async (taskId: string) => {
    if (!token) return
    setLoading(true)
    try {
      await api.retryTask(token, taskId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry task')
    } finally {
      setLoading(false)
    }
  }, [token, refresh])

  // Poll every 10s when enabled
  useEffect(() => {
    if (!token || !enabled) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      return
    }
    void refresh()
    intervalRef.current = setInterval(() => void refresh(), 10_000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [token, enabled, refresh])

  return { tasks, loading, error, refresh, approve, sendMessage, retry }
}
