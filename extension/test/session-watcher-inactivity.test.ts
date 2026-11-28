/**
 * The VS Code extension's Claude session watcher: after INACTIVITY_TIMEOUT_MS without transcript lines it completes the
 * orchestrator with an `agent_complete`. That completion is the absence of activity and must carry `reason: 'quiet'`,
 * or the page's "last activity" age resets 5 minutes after the last real event (review finding F1). Same check for the
 * Codex watcher's inactivity completion.
 */
import { describe, it, mock } from 'node:test'
import * as assert from 'node:assert/strict'
import * as path from 'node:path'
import Module from 'node:module'

import type { SessionWatcher as SessionWatcherType } from '../src/session-watcher'
import type { CodexSessionWatcher as CodexSessionWatcherType } from '../src/codex-session-watcher'
import type { AgentEvent, WatchedSession } from '../src/protocol'
import { INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME } from '../src/constants'

// The watchers import `vscode`; point it at the shim the relay build uses.
function requireWithVscodeShim<T>(id: string): T {
  const shim = path.resolve(__dirname, '../../scripts/vscode-shim.js')
  const M = Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string }
  const original = M._resolveFilename
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? shim : original.call(this, request, ...rest)
  }
  try {
    return require(id) as T
  } finally {
    M._resolveFilename = original
  }
}

function makeSession(sessionId: string): WatchedSession {
  return {
    sessionId, filePath: '/nonexistent/session.jsonl',
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(), seenToolUseIds: new Set(), seenMessageHashes: new Set(),
    spendByAgent: new Map(), seenUsageIds: new Set(),
    sessionDetected: true, sessionCompleted: false,
    lastActivityTime: Date.now(), inactivityTimer: null,
    subagentWatchers: new Map(), spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null,
    label: 'quiet session', labelSet: false, model: null, modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
}

describe('inactivity completion is marked quiet', () => {
  it('SessionWatcher (Claude, VS Code extension)', () => {
    const { SessionWatcher } = requireWithVscodeShim<{ SessionWatcher: typeof SessionWatcherType }>('../src/session-watcher')
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const watcher = new SessionWatcher()
      const sid = 'quiet-session-0001'
      const session = makeSession(sid)
      const priv = watcher as unknown as { sessions: Map<string, WatchedSession>; resetInactivityTimer(id: string): void }
      priv.sessions.set(sid, session)
      const events: AgentEvent[] = []
      watcher.onEvent((e) => events.push(e))

      priv.resetInactivityTimer(sid)
      mock.timers.tick(INACTIVITY_TIMEOUT_MS - 1)
      assert.equal(events.length, 0, 'nothing is emitted before the timeout')
      mock.timers.tick(1)

      assert.equal(session.sessionCompleted, true)
      const completes = events.filter((e) => e.type === 'agent_complete')
      assert.equal(completes.length, 1)
      assert.deepEqual(completes[0].payload, { name: ORCHESTRATOR_NAME, reason: 'quiet' })
    } finally {
      mock.timers.reset()
    }
  })

  it('CodexSessionWatcher keeps sessionEnd and adds reason quiet', () => {
    const { CodexSessionWatcher } = requireWithVscodeShim<{ CodexSessionWatcher: typeof CodexSessionWatcherType }>('../src/codex-session-watcher')
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      const watcher = new CodexSessionWatcher()
      const sid = 'quiet-codex-0001'
      const session = makeSession(sid)
      const priv = watcher as unknown as { sessions: Map<string, WatchedSession>; resetInactivityTimer(id: string): void }
      priv.sessions.set(sid, session)
      const events: AgentEvent[] = []
      watcher.onEvent((e) => events.push(e))

      priv.resetInactivityTimer(sid)
      mock.timers.tick(INACTIVITY_TIMEOUT_MS)

      const completes = events.filter((e) => e.type === 'agent_complete')
      assert.equal(completes.length, 1)
      assert.deepEqual(completes[0].payload, { name: ORCHESTRATOR_NAME, sessionEnd: true, reason: 'quiet' })
    } finally {
      mock.timers.reset()
    }
  })
})
