import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseHermesLogLine,
  displayProfileName,
  displayToolName,
  shortSessionTag,
  resolveHermesRoot,
  HermesLogWatcher,
} from './hermes-logs'
import type { AgentEvent } from '../extension/src/protocol'

const TOOL_TAGGED = '2026-11-23 12:06:13,000 INFO [20261123_103037_d0ddaef5] agent.tool_executor: tool terminal completed (0.10s, 588 chars)'
const TOOL_UNTAGGED = '2026-11-23 12:06:12,989 INFO agent.tool_executor: tool skill_view completed (0.04s, 5457 chars)'
const TOOL_FAILED = '2026-11-23 12:07:00,000 INFO [20261123_103037_d0ddaef5] agent.tool_executor: tool patch failed (1.5s, error)'
const API_LINE = '2026-11-23 12:06:45,094 INFO [20261123_103037_d0ddaef5] agent.conversation_loop: API call #25: model=claude-haiku-5-5 provider=claude-subscription-directsdk-experimental in=249062 out=1999 total=251061 latency=15.8s cache=245280/249062 (98%) write=3780 id=claude-native'
const API_NO_CACHE = '2026-11-23 12:06:45,094 INFO agent.conversation_loop: API call #1: model=gpt-5 provider=x in=100 out=5 total=105 latency=1s'
const OTHER = '2026-11-23 12:06:45,094 INFO [20261123_103037_d0ddaef5] agent.conversation_loop: Turn ended: reason=text_response'

test('parses tool completions with and without a session tag', () => {
  assert.deepEqual(parseHermesLogLine(TOOL_TAGGED), {
    sid: '20261123_103037_d0ddaef5',
    event: { kind: 'tool', tool: 'terminal', status: 'completed', seconds: 0.1 },
  })
  assert.deepEqual(parseHermesLogLine(TOOL_UNTAGGED)?.sid, undefined)
  assert.deepEqual(parseHermesLogLine(TOOL_FAILED)?.event, { kind: 'tool', tool: 'patch', status: 'failed', seconds: 1.5 })
})

test('parses API calls with cache read and write counts', () => {
  const parsed = parseHermesLogLine(API_LINE)
  assert.deepEqual(parsed?.event, {
    kind: 'api',
    model: 'claude-haiku-5-5',
    inputTokens: 249062,
    outputTokens: 1999,
    cacheReadTokens: 245280,
    cacheWriteTokens: 3780,
  })
  assert.deepEqual(parseHermesLogLine(API_NO_CACHE)?.event, {
    kind: 'api', model: 'gpt-5', inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('ignores lines the watcher does not use', () => {
  assert.equal(parseHermesLogLine(OTHER), null)
  assert.equal(parseHermesLogLine('2026-11-02 08:47:36,935 WARNING hermes_plugins.platforms__matrix.adapter: sync error'), null)
})

test('names: profiles, tools and session tags', () => {
  assert.equal(displayProfileName('default'), 'Hermes')
  assert.equal(displayProfileName('omh-coder'), 'OMH Coder')
  assert.equal(displayProfileName('sophia'), 'Sophia')
  assert.equal(displayToolName('terminal'), 'Bash')
  assert.equal(displayToolName('some_new_tool'), 'some_new_tool')
  assert.equal(shortSessionTag('20261123_103037_d0ddaef5'), 'd0ddaef5')
})

/** Build a temp Hermes home with one profile whose log already has old lines. */
function fixture(profile: string, initial: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-logs-'))
  const profilesRoot = path.join(root, 'profiles')
  const logFile = path.join(profilesRoot, profile, 'logs', 'agent.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  fs.writeFileSync(logFile, initial)
  return { root, profilesRoot, logFile }
}

function collector() {
  const events: Array<{ event: AgentEvent; sessionId?: string }> = []
  const lifecycle: Array<{ type: string; sessionId: string; label: string }> = []
  return {
    events,
    lifecycle,
    emit: (event: AgentEvent, sessionId?: string) => { events.push({ event, sessionId }) },
    lifecycleFn: (type: 'started' | 'ended' | 'updated', sessionId: string, label: string) => { lifecycle.push({ type, sessionId, label }) },
  }
}

test('does not replay history, then groups each Hermes session under its profile', () => {
  const { profilesRoot, logFile } = fixture('omh-coder', TOOL_TAGGED + '\n')
  let clock = 1_000_000
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock })

  w.poll()
  assert.equal(c.events.length, 0, 'existing lines must not be replayed')

  const other = '2026-11-23 12:10:00,000 INFO [20261123_999999_aaaaaaaa] agent.tool_executor: tool read_file completed (0.02s, 10 chars)'
  fs.appendFileSync(logFile, TOOL_TAGGED + '\n' + API_LINE + '\n' + other + '\n')
  clock += 1000
  w.poll()

  const sessionIds = [...new Set(c.events.map(e => e.sessionId))].sort()
  assert.deepEqual(sessionIds, ['hermes-omh-coder-aaaaaaaa', 'hermes-omh-coder-d0ddaef5'])
  assert.deepEqual(w.sessionsOf('omh-coder'), ['20261123_103037_d0ddaef5', '20261123_999999_aaaaaaaa'])

  const spawns = c.events.filter(e => e.event.type === 'agent_spawn')
  assert.equal(spawns.length, 2)
  for (const s of spawns) {
    assert.equal(s.event.payload.group, 'OMH Coder', 'every node carries its profile group')
    assert.equal(s.event.payload.profile, 'omh-coder')
  }
  assert.deepEqual(c.lifecycle.map(l => l.type), ['started', 'started'])

  const ctx = c.events.find(e => e.event.type === 'context_update' && e.sessionId === 'hermes-omh-coder-d0ddaef5')
  assert.ok(ctx)
  const spend = (ctx!.event.payload as { spend: Record<string, unknown> }).spend
  assert.equal(spend.inputTokens, 249062 - 245280 - 3780)
  assert.equal(spend.outputTokens, 1999)
  assert.equal(spend.cacheReadTokens, 245280)
  assert.equal(spend.cacheWrite5mTokens, 3780)
  assert.equal(spend.model, 'claude-haiku-5-5')

  const starts = c.events.filter(e => e.event.type === 'tool_call_start' && e.sessionId === 'hermes-omh-coder-d0ddaef5')
  const ends = c.events.filter(e => e.event.type === 'tool_call_end' && e.sessionId === 'hermes-omh-coder-d0ddaef5')
  assert.equal(starts.length, 1)
  assert.equal(ends.length, 1)
  assert.equal(starts[0].event.payload.tool, 'Bash')
  assert.equal(starts[0].event.payload.toolUseId, ends[0].event.payload.toolUseId)
})

test('partial trailing lines wait for their newline; idle and ended follow quiet time', () => {
  const { profilesRoot, logFile } = fixture('sophia', '')
  let clock = 0
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock, idleMs: 60_000, endMs: 600_000 })
  w.poll()

  fs.appendFileSync(logFile, TOOL_TAGGED.slice(0, 40))
  w.poll()
  assert.equal(c.events.length, 0, 'an unfinished line is not parsed yet')
  fs.appendFileSync(logFile, TOOL_TAGGED.slice(40) + '\n')
  w.poll()
  assert.ok(c.events.some(e => e.event.type === 'tool_call_start'))

  clock += 70_000
  w.poll()
  assert.ok(c.events.some(e => e.event.type === 'agent_idle'))

  clock += 600_000
  w.poll()
  assert.ok(c.events.some(e => e.event.type === 'agent_complete'))
  assert.deepEqual(c.lifecycle.map(l => l.type), ['started', 'ended'])
})

test('untagged lines attach to the profile\'s most recent tagged session', () => {
  const { profilesRoot, logFile } = fixture('taxis', '')
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => 0 })
  w.poll()
  fs.appendFileSync(logFile, TOOL_TAGGED + '\n' + TOOL_UNTAGGED + '\n')
  w.poll()
  const sessions = new Set(c.events.map(e => e.sessionId))
  assert.deepEqual([...sessions], ['hermes-taxis-d0ddaef5'])
})

test('reports Hermes sessions for the session list, so late page loads see them', () => {
  const { profilesRoot, logFile } = fixture('taxis', '')
  let clock = 0
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock })
  w.poll()
  assert.deepEqual(w.getActiveSessions(), [])
  fs.appendFileSync(logFile, TOOL_TAGGED + '\n')
  w.poll()
  const list = w.getActiveSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'hermes-taxis-d0ddaef5')
  assert.equal(list[0].status, 'active')
  assert.equal(list[0].label, 'Taxis · d0ddaef5')
})

test('resolves the Hermes root from a profile-shell HERMES_HOME', () => {
  assert.equal(resolveHermesRoot('/home/u/.hermes'), '/home/u/.hermes')
  assert.equal(resolveHermesRoot('/home/u/.hermes/profiles'), '/home/u/.hermes')
  assert.equal(resolveHermesRoot('/home/u/.hermes/profiles/taxis'), '/home/u/.hermes')
  assert.equal(resolveHermesRoot('/home/u/.hermes/profiles/taxis/'), '/home/u/.hermes')
})
