import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  parseHermesLogLine,
  parseGatewayInbound,
  displayProfileName,
  displayToolName,
  shortSessionTag,
  shortSessionName,
  readSessionTitle,
  resolveHermesRoot,
  HermesLogWatcher,
} from './hermes-logs'
import type { AgentEvent } from '../extension/src/protocol'
import type { SqliteCtor } from './hermes-logs'

const TOOL_TAGGED = '2026-11-23 12:06:13,000 INFO [20261123_103037_d0ddaef5] agent.tool_executor: tool terminal completed (0.10s, 588 chars)'
const TOOL_UNTAGGED = '2026-11-23 12:06:12,989 INFO agent.tool_executor: tool skill_view completed (0.04s, 5457 chars)'
const TOOL_FAILED = '2026-11-23 12:07:00,000 INFO [20261123_103037_d0ddaef5] agent.tool_executor: tool patch failed (1.5s, error)'
const API_LINE = '2026-11-23 12:06:45,094 INFO [20261123_103037_d0ddaef5] agent.conversation_loop: API call #25: model=claude-haiku-5-5 provider=claude-subscription-directsdk-experimental in=249062 out=1999 total=251061 latency=15.8s cache=245280/249062 (98%) write=3780 id=claude-native'
const API_NO_CACHE = '2026-11-23 12:06:45,094 INFO agent.conversation_loop: API call #1: model=gpt-5 provider=x in=100 out=5 total=105 latency=1s'
const OTHER = '2026-11-23 12:06:45,094 INFO [20261123_103037_d0ddaef5] agent.conversation_loop: Turn ended: reason=text_response'
const INBOUND = '2026-11-23 10:27:47,089 INFO gateway.run: inbound message: platform=matrix user=Webbugt chat=!room:matrix.org msg=\'secret text\' reply_to_id=None reply_to_text=\'\''

test('parses tool completions with and without a session tag', () => {
  assert.deepEqual(parseHermesLogLine(TOOL_TAGGED), {
    sid: '20261123_103037_d0ddaef5',
    event: { kind: 'tool', tool: 'terminal', status: 'completed', seconds: 0.1 },
  })
  assert.deepEqual(parseHermesLogLine(TOOL_UNTAGGED)?.sid, undefined)
  assert.deepEqual(parseHermesLogLine(TOOL_FAILED)?.event, { kind: 'tool', tool: 'patch', status: 'failed', seconds: 1.5 })
})

test('parses API calls with cache read and write counts', () => {
  assert.deepEqual(parseHermesLogLine(API_LINE)?.event, {
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

test('parses inbound messages to platform and sender only, never the text', () => {
  assert.deepEqual(parseGatewayInbound(INBOUND), { platform: 'matrix', user: 'Webbugt' })
  assert.equal(parseGatewayInbound('2026-11-23 10:27:47,089 INFO gateway.run: reaction ok'), null)
})

test('names: profiles, tools, session tags and short session names', () => {
  assert.equal(displayProfileName('default'), 'Hermes')
  assert.equal(displayProfileName('omh-coder'), 'OMH Coder')
  assert.equal(displayProfileName('sophia'), 'Sophia')
  assert.equal(displayToolName('terminal'), 'Bash')
  assert.equal(displayToolName('some_new_tool'), 'some_new_tool')
  assert.equal(shortSessionTag('20261123_103037_d0ddaef5'), 'd0ddaef5')
  assert.equal(shortSessionName('Agentic system visualisation options PDF report'), 'Agentic System')
  assert.equal(shortSessionName('Fix the PDF export bug'), 'Fix PDF')
  assert.equal(shortSessionName('Introduce yourself'), 'Introduce Yourself')
  assert.equal(shortSessionName('Supercalifragilisticexpialidocious words'), 'Supercalifragilist')
  assert.equal(shortSessionName('the of and'), 'The Of')
})

test('reads a session title from a state database, read-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-state-'))
  const db = path.join(dir, 'state.db')
  const writer = new (openSqlite())(db)
  writer.exec('create table sessions (id text primary key, title text)')
  writer.prepare('insert into sessions values (?, ?)').run('20261123_082951_1c240c9e', 'Agentic system visualisation options PDF report')
  writer.prepare('insert into sessions values (?, ?)').run('20261123_000000_untitled', null)
  writer.close()
  assert.equal(readSessionTitle(db, '20261123_082951_1c240c9e'), 'Agentic system visualisation options PDF report')
  assert.equal(readSessionTitle(db, '20261123_000000_untitled'), undefined)
  assert.equal(readSessionTitle(db, 'missing'), undefined)
  assert.equal(readSessionTitle(path.join(dir, 'nope.db'), 'x'), undefined)
})

function openSqlite(): SqliteCtor {
  return (require('node:sqlite') as { DatabaseSync: SqliteCtor }).DatabaseSync
}

/** Build a temp Hermes home with one profile whose agent.log already has old lines. */
function fixture(profile: string, initial: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-logs-'))
  const profilesRoot = path.join(root, 'profiles')
  const logDir = path.join(profilesRoot, profile, 'logs')
  const logFile = path.join(logDir, 'agent.log')
  const gatewayFile = path.join(logDir, 'gateway.log')
  fs.mkdirSync(logDir, { recursive: true })
  fs.writeFileSync(logFile, initial)
  return { root, profilesRoot, logFile, gatewayFile }
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

const TITLES: Record<string, string> = {
  d0ddaef5: 'Fix the PDF export bug',
  aaaaaaaa: 'Write release notes',
}

test('does not replay history; one profile session with a main node and a child node per Hermes session', () => {
  const { profilesRoot, logFile } = fixture('omh-coder', TOOL_TAGGED + '\n')
  let clock = 1_000_000
  const c = collector()
  const w = new HermesLogWatcher({
    profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock,
    titleFor: (_p, _db, sid) => TITLES[sid.slice(-8)],
  })

  w.poll()
  assert.equal(c.events.length, 0, 'existing lines must not be replayed')

  const other = '2026-11-23 12:10:00,000 INFO [20261123_999999_aaaaaaaa] agent.tool_executor: tool read_file completed (0.02s, 10 chars)'
  fs.appendFileSync(logFile, TOOL_TAGGED + '\n' + API_LINE + '\n' + other + '\n')
  clock += 1000
  w.poll()

  // Every event belongs to the one profile session.
  assert.deepEqual([...new Set(c.events.map(e => e.sessionId))], ['hermes-omh-coder'])
  assert.deepEqual(c.lifecycle.map(l => [l.type, l.sessionId]), [['started', 'hermes-omh-coder']])

  // Main node first, then one child per Hermes session, named by its title.
  const spawns = c.events.filter(e => e.event.type === 'agent_spawn').map(e => e.event.payload)
  assert.equal(spawns[0].name, 'OMH Coder')
  assert.equal(spawns[0].isMain, true)
  const children = spawns.slice(1).map(p => [p.name, p.parent])
  assert.deepEqual(children.sort(), [
    ['OMH Coder · Fix PDF', 'OMH Coder'],
    ['OMH Coder · Write Release', 'OMH Coder'],
  ])
  assert.deepEqual(w.nodesOf('omh-coder'), ['OMH Coder · Fix PDF', 'OMH Coder · Write Release'])

  // Tool and usage events go to the matching child node.
  const pdf = 'OMH Coder · Fix PDF'
  const ctx = c.events.find(e => e.event.type === 'context_update' && e.event.payload.agent === pdf)
  assert.ok(ctx)
  const spend = (ctx!.event.payload as { spend: Record<string, unknown> }).spend
  assert.equal(spend.inputTokens, 249062 - 245280 - 3780)
  assert.equal(spend.outputTokens, 1999)
  assert.equal(spend.cacheReadTokens, 245280)
  assert.equal(spend.cacheWrite5mTokens, 3780)
  assert.equal(spend.model, 'claude-haiku-5-5')

  const start = c.events.find(e => e.event.type === 'tool_call_start' && e.event.payload.agent === pdf)
  const end = c.events.find(e => e.event.type === 'tool_call_end' && e.event.payload.agent === pdf)
  assert.ok(start && end)
  assert.equal(start!.event.payload.tool, 'Bash')
  assert.equal(start!.event.payload.toolUseId, end!.event.payload.toolUseId)
})

test('a node waits for its title, then appears with a tag name if none comes', () => {
  const { profilesRoot, logFile } = fixture('omh-coder', '')
  let clock = 0
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock, titleFor: () => undefined })
  w.poll()
  fs.appendFileSync(logFile, TOOL_TAGGED + '\n')
  w.poll()
  assert.equal(c.events.filter(e => e.event.type === 'agent_spawn' && !e.event.payload.isMain).length, 0, 'no child node before the wait ends')
  assert.equal(c.events.filter(e => e.event.type === 'tool_call_start').length, 0, 'events are buffered, not dropped')

  clock += 46_000
  w.poll()
  const child = c.events.find(e => e.event.type === 'agent_spawn' && !e.event.payload.isMain)
  assert.equal(child?.event.payload.name, 'OMH Coder · d0ddaef5')
  const start = c.events.find(e => e.event.type === 'tool_call_start')
  assert.equal(start?.event.payload.agent, 'OMH Coder · d0ddaef5', 'buffered events arrive once the node exists')
})

test('partial trailing lines wait for their newline; child idle and complete follow quiet time', () => {
  const { profilesRoot, logFile } = fixture('sophia', '')
  let clock = 0
  const c = collector()
  const w = new HermesLogWatcher({
    profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock,
    idleMs: 60_000, endMs: 600_000, titleFor: () => 'Partial test',
  })
  w.poll()

  fs.appendFileSync(logFile, TOOL_TAGGED.slice(0, 40))
  w.poll()
  assert.equal(c.events.length, 0, 'an unfinished line is not parsed yet')
  fs.appendFileSync(logFile, TOOL_TAGGED.slice(40) + '\n')
  w.poll()
  assert.ok(c.events.some(e => e.event.type === 'tool_call_start'))

  clock += 70_000
  w.poll()
  assert.ok(c.events.some(e => e.event.type === 'agent_idle' && e.event.payload.name === 'Sophia · Partial Test'))

  clock += 600_000
  w.poll()
  assert.ok(c.events.some(e => e.event.type === 'agent_complete' && e.event.payload.name === 'Sophia · Partial Test'))
  // The profile's main node completes when all its sessions have.
  assert.ok(c.events.some(e => e.event.type === 'agent_complete' && e.event.payload.name === 'Sophia'))
  assert.deepEqual(c.lifecycle.map(l => l.type), ['started', 'ended'])
})

test('untagged lines attach to the profile\'s most recent tagged session', () => {
  const { profilesRoot, logFile } = fixture('taxis', '')
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => 0, titleFor: () => 'Route tasks' })
  w.poll()
  fs.appendFileSync(logFile, TOOL_TAGGED + '\n' + TOOL_UNTAGGED + '\n')
  w.poll()
  assert.deepEqual(w.nodesOf('taxis'), ['Taxis · Route Tasks'])
  const agents = new Set(c.events.filter(e => e.event.type === 'tool_call_start').map(e => e.event.payload.agent))
  assert.deepEqual([...agents], ['Taxis · Route Tasks'])
})

test('an inbound message appears as a message from the sender, on the active child node', () => {
  const { profilesRoot, logFile, gatewayFile } = fixture('hestia', '')
  let clock = 0
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock, titleFor: () => 'Introduce yourself' })
  w.poll()

  // Message arrives before any node exists: held until the node appears.
  fs.writeFileSync(gatewayFile, INBOUND + '\n')
  w.poll()
  assert.equal(c.events.filter(e => e.event.type === 'message').length, 0)

  fs.appendFileSync(logFile, TOOL_TAGGED + '\n')
  w.poll()
  const msg = c.events.find(e => e.event.type === 'message')
  assert.ok(msg, 'held message is delivered once the node exists')
  assert.deepEqual(msg!.event.payload, { agent: 'Hestia · Introduce Yourself', role: 'user', content: 'Message from Webbugt via matrix' })
  assert.ok(!JSON.stringify(c.events).includes('secret text'), 'message text never reaches the page')
})

test('reports the profile in the session list so late page loads see it', () => {
  const { profilesRoot, logFile } = fixture('taxis', '')
  let clock = 0
  const c = collector()
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock, titleFor: () => undefined })
  w.poll()
  assert.deepEqual(w.getActiveSessions(), [])
  fs.appendFileSync(logFile, TOOL_TAGGED + '\n')
  w.poll()
  const list = w.getActiveSessions()
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'hermes-taxis')
  assert.equal(list[0].label, 'Taxis')
  assert.equal(list[0].status, 'active')
})

test('resolves the Hermes root from a profile-shell HERMES_HOME', () => {
  assert.equal(resolveHermesRoot('/home/u/.hermes'), '/home/u/.hermes')
  assert.equal(resolveHermesRoot('/home/u/.hermes/profiles'), '/home/u/.hermes')
  assert.equal(resolveHermesRoot('/home/u/.hermes/profiles/taxis'), '/home/u/.hermes')
  assert.equal(resolveHermesRoot('/home/u/.hermes/profiles/taxis/'), '/home/u/.hermes')
})
