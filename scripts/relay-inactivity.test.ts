/**
 * The relay's Claude transcript inactivity timer: after INACTIVITY_TIMEOUT_MS without transcript lines it completes the
 * session with an `agent_complete`. That completion is the ABSENCE of activity, so it must carry `reason: 'quiet'`;
 * without it the page's top bar reads the completion as activity and resets "last activity" to 0 s five minutes after
 * the last real event (review finding F1). The test fires the real timer (mock clock) and checks the payload, then
 * feeds that payload to the page's own freshness rule.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import * as path from 'node:path'
import Module from 'node:module'
import type { WatchedSession, AgentEvent } from '../extension/src/protocol'
import { INACTIVITY_TIMEOUT_MS, ORCHESTRATOR_NAME } from '../extension/src/constants'
import { showsLiveActivity, stampStreamMessage } from '../web/lib/data-freshness'

// relay.ts pulls in modules that import `vscode`; point it at the shim the relay build uses.
function requireWithVscodeShim<T>(id: string): T {
  const shim = path.resolve(__dirname, 'vscode-shim.js')
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

test('inactivity completion carries reason "quiet" and does not count as activity on the page', (t) => {
  const { __testing } = requireWithVscodeShim<typeof import('./relay')>('./relay')
  const sid = 'quiet-session-0001'
  const session = makeSession(sid)
  __testing.sessions.set(sid, session)
  t.after(() => { __testing.sessions.delete(sid); __testing.eventBuffer.delete(sid); mock.timers.reset() })
  mock.timers.enable({ apis: ['setTimeout', 'Date'] })

  __testing.resetInactivityTimer(sid)
  mock.timers.tick(INACTIVITY_TIMEOUT_MS - 1)
  assert.equal(__testing.eventBuffer.get(sid), undefined, 'nothing is emitted before the timeout')
  assert.equal(session.sessionCompleted, false)

  mock.timers.tick(1)
  assert.equal(session.sessionCompleted, true)
  const events: AgentEvent[] = __testing.eventBuffer.get(sid) ?? []
  const completes = events.filter((e) => e.type === 'agent_complete')
  assert.equal(completes.length, 1)
  assert.deepEqual(completes[0].payload, { name: ORCHESTRATOR_NAME, reason: 'quiet' })

  // The page's own rule: this is not live activity, so the age stamp stays where the last real event left it.
  const payload = completes[0].payload as Record<string, unknown>
  assert.equal(showsLiveActivity('agent_complete', payload, undefined), false)
  const before = { lastEventAt: 1_000, lastActivityAt: 1_000 }
  const after = stampStreamMessage(before, 1_000 + INACTIVITY_TIMEOUT_MS + 5_000, showsLiveActivity('agent_complete', payload, undefined))
  assert.equal(after.lastActivityAt, 1_000, 'the activity stamp did not move')
})
