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
  readRecentSessions,
  idleWindowFromEnv,
} from './hermes-logs'
import type { AgentEvent } from '../extension/src/protocol'
import type { SqliteCtor, RecentSession } from './hermes-logs'

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

test('parses API calls with provider, latency, cache read and write counts', () => {
  assert.deepEqual(parseHermesLogLine(API_LINE)?.event, {
    kind: 'api',
    model: 'claude-haiku-5-5',
    provider: 'claude-subscription-directsdk-experimental',
    latencySeconds: 15.8,
    inputTokens: 249062,
    outputTokens: 1999,
    cacheReadTokens: 245280,
    cacheWriteTokens: 3780,
  })
  assert.deepEqual(parseHermesLogLine(API_NO_CACHE)?.event, {
    kind: 'api', model: 'gpt-5', provider: 'x', latencySeconds: 1, inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

// Copilot lines as they appear in real agent.log files (dotted model ids; ids redacted).
const API_COPILOT_NO_CACHE = '2026-11-02 09:00:48,096 INFO [20261102_090036_68da8bd7] agent.conversation_loop: API call #1: model=claude-sonnet-5.5 provider=copilot in=20344 out=130 total=20474 latency=2.3s id=<redacted>'
const API_COPILOT_CACHE = '2026-11-02 09:31:19,250 INFO [20261102_090036_68da8bd7] agent.conversation_loop: API call #2: model=claude-sonnet-5.5 provider=copilot in=22566 out=98 total=22664 latency=1.8s cache=21992/22566 (97%) id=<redacted>'
const API_COPILOT_WRITE = '2026-11-01 20:57:05,771 INFO [local-04eb23fc] agent.conversation_loop: API call #1: model=gpt-6.1-sol provider=copilot in=15728 out=5 total=15733 latency=2.6s write=15725 id=mJ/0mS0E+6fo/Q=='
const API_NO_LATENCY = '2026-11-23 12:06:45,094 INFO agent.conversation_loop: API call #3: model=gemini-3.8-flash provider=copilot in=39905 out=229 total=40134 cache=34956/39905 (88%)'
const API_LOCAL_MS = '2026-11-23 22:00:01,000 INFO [20261123_220000_aaaaaaaa] agent.conversation_loop: API call #1: model=llama3.1:8b provider=ollama in=900 out=40 total=940 latency=850ms'

test('P2: Copilot lines keep provider=copilot, latency, cache= and write=', () => {
  assert.deepEqual(parseHermesLogLine(API_COPILOT_NO_CACHE)?.event, {
    kind: 'api', model: 'claude-sonnet-5.5', provider: 'copilot', latencySeconds: 2.3,
    inputTokens: 20344, outputTokens: 130, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
  assert.deepEqual(parseHermesLogLine(API_COPILOT_CACHE)?.event, {
    kind: 'api', model: 'claude-sonnet-5.5', provider: 'copilot', latencySeconds: 1.8,
    inputTokens: 22566, outputTokens: 98, cacheReadTokens: 21992, cacheWriteTokens: 0,
  })
  // Copilot GPT lines do carry write=; the opaque trailing id= is ignored.
  assert.deepEqual(parseHermesLogLine(API_COPILOT_WRITE)?.event, {
    kind: 'api', model: 'gpt-6.1-sol', provider: 'copilot', latencySeconds: 2.6,
    inputTokens: 15728, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 15725,
  })
})

function apiOf(line: string) {
  const ev = parseHermesLogLine(line)?.event
  if (!ev || ev.kind !== 'api') throw new Error('not an API line: ' + line)
  return ev
}

test('P2: a line without latency has no latencySeconds; ms latencies are converted; local providers are kept', () => {
  const noLatency = apiOf(API_NO_LATENCY)
  assert.equal('latencySeconds' in noLatency, false)
  assert.equal(noLatency.provider, 'copilot')
  assert.equal(noLatency.cacheReadTokens, 34956)
  const local = apiOf(API_LOCAL_MS)
  assert.equal(local.provider, 'ollama')
  assert.equal(local.latencySeconds, 0.85)
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
  // Child nodes carry the epoch time base of their event times, so the fleet view can place them.
  for (const child of spawns.slice(1)) assert.equal(typeof child.startedAt, 'number')

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

// ─── Idle profiles (fleet view) ─────────────────────────────────────────────

const H = 3_600_000

/** A temp state.db with `sessions` and `messages`, like Hermes' own (only the columns the reader uses). */
function stateDb(rows: Array<{ id: string; title: string | null; startedS: number; lastMsgS?: number }>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-recent-'))
  const file = path.join(dir, 'state.db')
  const db = new (openSqlite())(file)
  db.exec('create table sessions (id text primary key, title text, started_at real)')
  db.exec('create table messages (id integer primary key, session_id text, timestamp real)')
  for (const r of rows) {
    db.prepare('insert into sessions values (?, ?, ?)').run(r.id, r.title, r.startedS)
    if (r.lastMsgS !== undefined) db.prepare('insert into messages (session_id, timestamp) values (?, ?)').run(r.id, r.lastMsgS)
  }
  db.close()
  return file
}

test('reads recent sessions from a state database: window, newest first, last message time', () => {
  const now = 1_800_000_000_000
  const file = stateDb([
    { id: 'old', title: 'Old one', startedS: (now - 30 * H) / 1000, lastMsgS: (now - 29 * H) / 1000 },
    { id: 'a', title: 'Recent A', startedS: (now - 5 * H) / 1000, lastMsgS: (now - 4 * H) / 1000 },
    { id: 'b', title: null, startedS: (now - 2 * H) / 1000 }, // no messages: its start counts
    { id: 'long', title: 'Started long ago, active now', startedS: (now - 40 * H) / 1000, lastMsgS: (now - 1 * H) / 1000 },
  ])
  const found = readRecentSessions(file, now - 24 * H)
  assert.deepEqual(found.map(s => s.id), ['long', 'b', 'a'])
  assert.equal(found[2].title, 'Recent A')
  assert.equal(found[2].startedAt, now - 5 * H)
  assert.equal(found[2].lastActivityAt, now - 4 * H)
  assert.equal(found[1].title, undefined)
  assert.deepEqual(readRecentSessions(path.join(os.tmpdir(), 'no-such-state.db'), 0), [])
  assert.equal(readRecentSessions(file, now - 24 * H, 1).length, 1)
})

test('idle window: AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS, default 24 h, 0 turns it off', () => {
  assert.equal(idleWindowFromEnv({}), 24 * H)
  assert.equal(idleWindowFromEnv({ AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS: '6' }), 6 * H)
  assert.equal(idleWindowFromEnv({ AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS: '0.5' }), H / 2)
  assert.equal(idleWindowFromEnv({ AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS: '0' }), 0)
  assert.equal(idleWindowFromEnv({ AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS: 'abc' }), 24 * H)
  assert.equal(idleWindowFromEnv({ AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS: '-3' }), 24 * H)
})

/** Hermes home with two profiles; sophia has a quiet log, taxis one line appended later. */
function twoProfiles() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-fleet-'))
  const profilesRoot = path.join(root, 'profiles')
  const logs: Record<string, string> = {}
  for (const p of ['sophia', 'taxis', 'hestia']) {
    const dir = path.join(profilesRoot, p, 'logs')
    fs.mkdirSync(dir, { recursive: true })
    logs[p] = path.join(dir, 'agent.log')
    fs.writeFileSync(logs[p], '')
  }
  return { profilesRoot, logs }
}

test('session list carries idle profiles (recent sessions, no live log line) marked idle', () => {
  const { profilesRoot } = twoProfiles()
  const now = 1_800_000_000_000
  const recent: Record<string, RecentSession[]> = {
    sophia: [
      { id: '20261123_082951_1c240c9e', title: 'Agentic system visualisation options', startedAt: now - 5 * H, lastActivityAt: now - 4 * H },
      { id: '20261123_170201_74050890', title: 'Cost estimate explanation', startedAt: now - 2 * H, lastActivityAt: now - H },
    ],
    taxis: [{ id: '20261123_103647_c9c036f8', title: 'Plan fleet timeline', startedAt: now - 3 * H, lastActivityAt: now - 2 * H }],
    // hestia has nothing inside the window
  }
  const asked: Array<[string, number]> = []
  const c = collector()
  const w = new HermesLogWatcher({
    profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => now, titleFor: () => undefined,
    recentSessionsFor: (profile, _db, sinceMs) => { asked.push([profile, sinceMs]); return recent[profile] ?? [] },
  })
  w.poll()

  // Window: 24 h back from now, asked once per profile.
  assert.deepEqual(asked.map(a => a[1]), [now - 24 * H, now - 24 * H, now - 24 * H])
  const list = w.getActiveSessions()
  assert.deepEqual(list.map(s => s.id).sort(), ['hermes-sophia', 'hermes-taxis'], 'hestia has no recent session and is not listed')
  for (const s of list) {
    assert.equal(s.idle, true)
    assert.equal(s.status, 'completed')
  }
  const sophia = list.find(s => s.id === 'hermes-sophia')!
  assert.equal(sophia.label, 'Sophia')
  assert.equal(sophia.startTime, now - 5 * H)
  assert.equal(sophia.lastActivityTime, now - H)

  // Nothing is live: no lifecycle, so no session-started goes to pages.
  assert.deepEqual(c.lifecycle, [])
  // Per session: a main node, one child per session placed by its real times, completed as idle.
  const sophiaEvents = c.events.filter(e => e.sessionId === 'hermes-sophia').map(e => e.event)
  const spawns = sophiaEvents.filter(e => e.type === 'agent_spawn').map(e => e.payload)
  assert.equal(spawns[0].name, 'Sophia')
  assert.equal(spawns[0].isMain, true)
  assert.deepEqual(spawns.slice(1).map(p => [p.name, p.startedAt]), [
    ['Sophia · Agentic System', now - 5 * H],
    ['Sophia · Cost Estimate', now - 2 * H],
  ])
  const done = sophiaEvents.filter(e => e.type === 'agent_complete' && e.payload.idle === true)
  assert.deepEqual(done.map(e => [e.payload.name, e.time]), [
    ['Sophia · Agentic System', H / 1000],
    ['Sophia · Cost Estimate', H / 1000],
    ['Sophia', 0],
  ])
  assert.deepEqual(w.nodesOf('sophia'), ['Sophia · Agentic System', 'Sophia · Cost Estimate'])
})

test('an idle profile turns live on its first log line; other profiles stay idle', () => {
  const { profilesRoot, logs } = twoProfiles()
  const now = 1_800_000_000_000
  let clock = now
  const c = collector()
  const w = new HermesLogWatcher({
    profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock, titleFor: () => undefined,
    recentSessionsFor: profile => profile === 'hestia' ? [] : [{ id: '20261123_103037_d0ddaef5', title: 'Fix the PDF export bug', startedAt: now - 3 * H, lastActivityAt: now - 2 * H }],
  })
  w.poll()
  assert.deepEqual(w.getActiveSessions().map(s => [s.id, s.idle]).sort(), [['hermes-sophia', true], ['hermes-taxis', true]])

  fs.appendFileSync(logs.taxis, TOOL_TAGGED + '\n')
  clock += 1000
  w.poll()
  const byId = Object.fromEntries(w.getActiveSessions().map(s => [s.id, s]))
  assert.equal(byId['hermes-taxis'].status, 'active')
  assert.equal(byId['hermes-taxis'].idle, undefined, 'live profile is no longer idle')
  assert.equal(byId['hermes-sophia'].idle, true)
  assert.deepEqual(c.lifecycle.map(l => [l.type, l.sessionId]), [['started', 'hermes-taxis']])
  // The restored session is reactivated, not duplicated.
  assert.deepEqual(w.nodesOf('taxis'), ['Taxis · Fix PDF'])
})

test('a profile that was live and then finished is not idle (it stays a normal completed tab)', () => {
  const { profilesRoot, logs } = twoProfiles()
  let clock = 1_800_000_000_000
  const c = collector()
  const w = new HermesLogWatcher({
    profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock, titleFor: () => 'T', recentSessionsFor: () => [],
    endMs: 5_000,
  })
  w.poll()
  fs.appendFileSync(logs.taxis, TOOL_TAGGED + '\n')
  clock += 1000
  w.poll()
  clock += 10_000
  w.poll()
  const s = w.getActiveSessions().find(x => x.id === 'hermes-taxis')!
  assert.equal(s.status, 'completed')
  assert.equal(s.idle, undefined)
})

// ─── P2: provider, latency and prompt-size buckets through the watcher ──────

function apiLine(n: number, o: { provider: string; model: string; inTok: number; out: number; cache?: number; write?: number; latency?: string }): string {
  const parts = [`in=${o.inTok}`, `out=${o.out}`, `total=${o.inTok + o.out}`]
  if (o.latency) parts.push(`latency=${o.latency}`)
  if (o.cache) parts.push(`cache=${o.cache}/${o.inTok} (${Math.round((100 * o.cache) / o.inTok)}%)`)
  if (o.write) parts.push(`write=${o.write}`)
  return `2026-11-23 12:06:${String(10 + (n % 50)).padStart(2, '0')},000 INFO [20261123_103037_d0ddaef5] agent.conversation_loop: API call #${n}: model=${o.model} provider=${o.provider} ${parts.join(' ')} id=<redacted>`
}

type Counts = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number }
type Spend = Counts & {
  provider?: string; model?: string; calls?: number; timedCalls?: number; latencySeconds?: number
  byBucket?: Record<string, Counts>
}

/** Feed API lines to a fresh watcher and return the spend of the last context_update. */
function lastSpend(lines: string[], profile = 'sophia'): Spend {
  const { profilesRoot, logFile } = fixture(profile, '')
  const c = collector()
  let clock = 0
  const w = new HermesLogWatcher({ profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => clock, titleFor: () => 'Costs', transcriptFor: false, recentSessionsFor: () => [] })
  w.poll()
  fs.appendFileSync(logFile, lines.join('\n') + '\n')
  clock += 1000
  w.poll()
  const ctx = c.events.filter(e => e.event.type === 'context_update')
  assert.equal(ctx.length, lines.length, 'one context_update per API line')
  return (ctx[ctx.length - 1].event.payload as { spend: Spend }).spend
}

test('P2: Hermes context_update carries provider, calls and latency (Copilot, with a call without latency)', () => {
  const spend = lastSpend([
    apiLine(1, { provider: 'copilot', model: 'claude-sonnet-5.5', inTok: 20344, out: 130, latency: '2.3s' }),
    apiLine(2, { provider: 'copilot', model: 'claude-sonnet-5.5', inTok: 22566, out: 98, cache: 21992, latency: '1.8s' }),
    apiLine(3, { provider: 'copilot', model: 'gemini-3.8-flash', inTok: 39905, out: 229, cache: 34956 }),
  ])
  assert.equal(spend.provider, 'copilot')
  assert.equal(spend.model, 'gemini-3.8-flash')
  assert.equal(spend.calls, 3)
  assert.equal(spend.timedCalls, 2)
  assert.ok(Math.abs((spend.latencySeconds ?? 0) - 4.1) < 1e-9)
  assert.equal(spend.cacheReadTokens, 21992 + 34956)
  assert.equal(spend.inputTokens, 20344 + (22566 - 21992) + (39905 - 34956))
})

test('P2: prompt-size buckets follow the whole prompt (cache included) per request', () => {
  const p = 'claude-subscription-directsdk-experimental'
  const spend = lastSpend([
    apiLine(1, { provider: p, model: 'claude-haiku-5-5', inTok: 99_000, out: 10, cache: 90_000, write: 4_000 }),
    apiLine(2, { provider: p, model: 'claude-haiku-5-5', inTok: 249_062, out: 1999, cache: 245_280, write: 3_780, latency: '15.8s' }),
    apiLine(3, { provider: p, model: 'claude-haiku-5-5', inTok: 300_000, out: 5 }),
  ])
  assert.equal(spend.provider, p)
  assert.deepEqual(Object.keys(spend.byBucket ?? {}).sort(), ['gt272000', 'le100000', 'le272000'])
  assert.equal(spend.byBucket!.le100000.inputTokens, 99_000 - 90_000 - 4_000)
  assert.equal(spend.byBucket!.le272000.cacheReadTokens, 245_280)
  assert.equal(spend.byBucket!.le272000.cacheWrite5mTokens, 3_780)
  assert.equal(spend.byBucket!.gt272000.inputTokens, 300_000)
})

test('P2: property: the byBucket totals always equal the flat totals (deterministic pseudo-random Hermes lines)', () => {
  let seed = 20261125
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32 }
  const providers = ['copilot', 'claude-subscription-directsdk-experimental', 'ollama', 'custom']
  for (let run = 0; run < 25; run++) {
    const n = 1 + Math.floor(rnd() * 12)
    const lines: string[] = []
    for (let i = 1; i <= n; i++) {
      const inTok = 1 + Math.floor(rnd() * 420_000)
      const cache = rnd() < 0.5 ? Math.floor(rnd() * inTok) : 0
      const write = rnd() < 0.3 ? Math.floor(rnd() * (inTok - cache)) : 0
      lines.push(apiLine(i, {
        provider: providers[Math.floor(rnd() * providers.length)], model: 'claude-sonnet-5.5',
        inTok, out: Math.floor(rnd() * 5000), cache, write, latency: rnd() < 0.8 ? `${(rnd() * 20).toFixed(1)}s` : undefined,
      }))
    }
    const s = lastSpend(lines, `p${run}`)
    const sum: Counts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }
    for (const b of Object.values(s.byBucket ?? {})) {
      for (const k of Object.keys(sum) as Array<keyof Counts>) sum[k] += b[k]
    }
    assert.deepEqual(sum, {
      inputTokens: s.inputTokens, outputTokens: s.outputTokens, cacheReadTokens: s.cacheReadTokens,
      cacheWrite5mTokens: s.cacheWrite5mTokens, cacheWrite1hTokens: s.cacheWrite1hTokens,
    }, `run ${run}`)
    assert.equal(s.calls, n)
  }
})

test('idle window 0 keeps to live activity only', () => {
  const { profilesRoot } = twoProfiles()
  const c = collector()
  let asked = 0
  const w = new HermesLogWatcher({
    profilesRoot, emit: c.emit, lifecycle: c.lifecycleFn, now: () => 1_800_000_000_000, titleFor: () => undefined,
    idleWindowMs: 0, recentSessionsFor: () => { asked++; return [] },
  })
  w.poll()
  assert.equal(asked, 0)
  assert.deepEqual(w.getActiveSessions(), [])
  assert.equal(c.events.length, 0)
})
