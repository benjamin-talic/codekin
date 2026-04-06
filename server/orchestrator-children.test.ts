/** Tests for orchestrator-children — verifies child session spawning, allowedTools defaults and overrides. */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/test-data',
  AGENT_DISPLAY_NAME: 'TestAgent',
  getAgentDisplayName: () => 'TestAgent',
}))

import { OrchestratorChildManager, AGENT_CHILD_ALLOWED_TOOLS } from './orchestrator-children.js'
import type { ChildSessionRequest } from './orchestrator-children.js'

function fakeSessionManager() {
  return {
    get: vi.fn(() => ({
      claudeProcess: { isAlive: () => true },
      outputHistory: [],
      pendingToolApprovals: new Map(),
      pendingControlRequests: new Map(),
    })),
    create: vi.fn((_name: string, _dir: string, opts?: any) => ({
      id: opts?.id ?? 'child-id',
      ...opts,
    })),
    startClaude: vi.fn(),
    sendInput: vi.fn(),
    createWorktree: vi.fn(async () => '/tmp/worktree'),
    onSessionResult: vi.fn(() => vi.fn()),
    onSessionExit: vi.fn(() => vi.fn()),
    clearProcessingFlag: vi.fn(),
  } as any
}

function baseRequest(overrides?: Partial<ChildSessionRequest>): ChildSessionRequest {
  return {
    repo: '/tmp/repo',
    task: 'Test task',
    branchName: 'fix/test',
    completionPolicy: 'pr',
    deployAfter: false,
    useWorktree: false,
    ...overrides,
  }
}

describe('OrchestratorChildManager', () => {
  let sm: ReturnType<typeof fakeSessionManager>
  let children: OrchestratorChildManager

  beforeEach(() => {
    sm = fakeSessionManager()
    children = new OrchestratorChildManager(sm)
  })

  describe('spawn() allowedTools', () => {
    it('uses AGENT_CHILD_ALLOWED_TOOLS by default when no override provided', async () => {
      await children.spawn(baseRequest())

      expect(sm.create).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/repo',
        expect.objectContaining({
          allowedTools: AGENT_CHILD_ALLOWED_TOOLS,
        }),
      )
    })

    it('uses custom allowedTools when override is provided', async () => {
      const custom = ['Read', 'Bash(python:*)']
      await children.spawn(baseRequest({ allowedTools: custom }))

      expect(sm.create).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/repo',
        expect.objectContaining({
          allowedTools: custom,
        }),
      )
    })

    it('sets source to agent for child sessions', async () => {
      await children.spawn(baseRequest())

      expect(sm.create).toHaveBeenCalledWith(
        expect.any(String),
        '/tmp/repo',
        expect.objectContaining({
          source: 'agent',
          permissionMode: 'acceptEdits',
        }),
      )
    })
  })

  describe('AGENT_CHILD_ALLOWED_TOOLS', () => {
    it('includes core dev tools', () => {
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Read')
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Write')
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Edit')
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Glob')
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Grep')
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Bash(git:*)')
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Bash(gh:*)')
      expect(AGENT_CHILD_ALLOWED_TOOLS).toContain('Bash(npm:*)')
    })

    it('does not include destructive commands', () => {
      const dangerous = ['Bash(rm:*)', 'Bash(sudo:*)', 'Bash(docker:*)', 'Bash(echo:*)']
      for (const tool of dangerous) {
        expect(AGENT_CHILD_ALLOWED_TOOLS).not.toContain(tool)
      }
    })

    it('does not include filesystem traversal tools', () => {
      const traversal = ['Bash(find:*)', 'Bash(du:*)', 'Bash(stat:*)']
      for (const tool of traversal) {
        expect(AGENT_CHILD_ALLOWED_TOOLS).not.toContain(tool)
      }
    })
  })
})
