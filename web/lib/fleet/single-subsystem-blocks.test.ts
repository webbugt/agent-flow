import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { BashUseTracker, buildBashBlocks } from './bash-blocks'
import {
  EventUseTracker, buildUseBlocks, buildUseNodes, innerCalls, normaliseContainerTag, useCountsLine, usesOfCall, usesOfMessage,
  type UseEventLike, type UseNode,
} from './event-uses'
import { buildFleetGraph } from './fleet-graph'
import { inspectResource } from './fleet-inspect'
import { instancesFromSessionEvents, type SessionEventLike, type SessionLike } from './fleet-model'
import { defaultOptions, type AgentFlowOptions } from './options-registry'
import { agentsInWindow, recordUse, setPinned, type BlockStore, type ResourceBlock } from './resource-block'
import { SingleSessionTracker, buildSingleBlocks } from './single-blocks'
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'
import { buildFleetScene, FleetReplay } from '@/hooks/simulation/fleet-scene'

const S = 1000
const T0 = Date.UTC(2026, 11, 1, 12, 0, 0)
const NOW = T0
const all = { isSelected: () => true }

const live = (profile: string): SessionLike => ({ id: `hermes-${profile}`, label: profile, status: 'active', startTime: T0 - 3600 * S, lastActivityTime: T0 })
const spawn = (name: string): SessionEventLike => ({ time: 0, type: 'agent_spawn', payload: { name, parent: 'x', startedAt: T0 - 3600 * S } })

type Ev = UseEventLike & { payload: Record<string, unknown> }
const tool = (agent: string, toolName: string, input: Record<string, unknown>, agoSec: number, id: string): Ev => ({
  time: 0, type: 'tool_call_start',
  payload: { agent, tool: toolName, toolUseId: id, args: JSON.stringify(input).slice(0, 80), inputData: input, at: T0 - agoSec * S },
})
const bashCall = (agent: string, command: string, agoSec: number, id: string): Ev => tool(agent, 'Bash', { command }, agoSec, id)
const message = (agent: string, role: string, platform: string | undefined, content: string, agoSec: number): Ev => ({
  time: 0, type: 'message', payload: { agent, role, content, at: T0 - agoSec * S, ...(platform ? { platform } : {}) },
})

const PRIVATE_QUERY = 'what did we decide about the salary of Ana Horvat'
const PRIVATE_BODY = 'Task body: rotate the production db password'
const PRIVATE_PROMPT = 'IMPORTANT: summarise the inbox of the CEO'

/** Two sessions with deliberately different use, so a leak from one into the other is visible. */
function twoSessions() {
  const events: Record<string, Ev[]> = {
    'hermes-taxis': [
      bashCall('taxis · Plan', 'git status', 5, 'a1'),
      tool('taxis · Plan', 'supermemory_search', { container_tag: 'omh-family', query: PRIVATE_QUERY }, 8, 'a2'),
      tool('taxis · Plan', 'cronjob_manage', { action: 'list', name: 'secret-job' }, 12, 'a3'),
      message('taxis · Plan', 'user', 'matrix', 'hello from the room', 15),
    ],
    'hermes-sophia': [
      bashCall('sophia · Report', 'pnpm test', 6, 'b1'),
      bashCall('sophia · Report', 'git log', 7, 'b2'),
      tool('sophia · Report', 'supermemory_store', { container_tag: 'matrix_org', content: PRIVATE_QUERY }, 9, 'b3'),
      tool('sophia · Report', 'kanban_show', { board: 'agent-flow', task_id: 't_1' }, 11, 'b4'),
      message('sophia · Report', 'user', 'cron', PRIVATE_PROMPT, 13),
    ],
  }
  return {
    sessions: [live('taxis'), live('sophia')],
    events,
    eventsOf: (id: string): Ev[] => events[id] ?? [],
    instances: () => instancesFromSessionEvents([live('taxis'), live('sophia')], id => (id === 'hermes-taxis' ? [spawn('taxis · Plan')] : [spawn('sophia · Report')])),
  }
}

const sessionOf = (profile: string) => ({ id: `hermes-${profile}`, label: profile })

// ─── event-uses: what a call or a message may turn into ─────────────────────

test('uses: a memory call yields the container tag and the verb, normalised; arguments are not kept', () => {
  const [call] = innerCalls({ tool: 'supermemory_search', inputData: { container_tag: 'Omh-Family', query: PRIVATE_QUERY } })
  const uses = usesOfCall(call)
  assert.deepEqual(uses, [{ kind: 'memory', key: 'omh_family', action: 'search' }])
  assert.ok(!JSON.stringify(uses).includes('salary'))
  assert.equal(normaliseContainerTag(' Webbugt-Video-Memory '), 'webbugt_video_memory')
  // aliases and the MCP prefix
  assert.equal(usesOfCall({ name: 'supermemory_save', input: { containerTag: 'matrix_org' } })[0].action, 'store')
  assert.equal(innerCalls({ tool: 'mcp__hermes__supermemory_forget', inputData: { container_tag: 'matrix_org' } })[0].name, 'supermemory_forget')
})

test('uses: a deferred call inside the tool_call wrapper is unwrapped (arguments as an object or a JSON string)', () => {
  const calls = innerCalls({
    tool: 'mcp__hermes__tool_call',
    inputData: { calls: [
      { name: 'supermemory_store', arguments: { container_tag: 'matrix_org', content: 'x' } },
      { name: 'cronjob_manage', arguments: '{"action":"list"}' },
      { name: 'kanban_show', arguments: '{"board":"agent-flow"}' },
    ] },
  })
  assert.deepEqual(calls.flatMap(usesOfCall), [
    { kind: 'memory', key: 'matrix_org', action: 'store' },
    { kind: 'subsystem', key: 'cron', action: 'manage' },
    { kind: 'kanban', key: 'agent-flow', action: 'show' },
  ])
})

test('uses: no tag, a free-text tag and every personal-* tag are NOT memory uses (the browser has no owner, so it fails closed)', () => {
  const memory = (input: Record<string, unknown>) => usesOfCall({ name: 'supermemory_search', input })
  assert.deepEqual(memory({ query: 'x' }), [], 'unattributed')
  assert.deepEqual(memory({ container_tag: 'a free text that is not a tag, with spaces' }), [])
  for (const t of ['personal-webbugt', 'personal_webbugt', 'PERSONAL-X', ' Personal-Y ']) assert.deepEqual(memory({ container_tag: t }), [], t)
  assert.equal(memory({ container_tag: 'my-personal-notes' }).length, 1, 'only a name that STARTS with personal is hidden')
})

test('uses: personal tags are not memory uses in any separator form (- _ . :), whatever the case', () => {
  const memory = (tag: string) => usesOfCall({ name: 'supermemory_store', input: { container_tag: tag } })
  assert.deepEqual(memory('personal-idv'), [], 'hyphen')
  assert.deepEqual(memory('personal_idv'), [], 'underscore')
  assert.deepEqual(memory('personal.idv'), [], 'dot')
  assert.deepEqual(memory('personal:idv'), [], 'colon')
  assert.deepEqual(memory('Personal.IDV'), [], 'dot, upper case')
  assert.deepEqual(memory('PERSONAL:idv'), [], 'colon, upper case')
  assert.deepEqual(memory('personalities'), [], 'starts with personal: hidden (fail closed)')
})

test('uses: kanban needs a board in the call; it keeps the slug and the verb, never a task id or body', () => {
  const uses = usesOfCall({ name: 'kanban_comment', input: { board: 'agent-flow', task_id: 't_1', body: PRIVATE_BODY } })
  assert.deepEqual(uses, [{ kind: 'kanban', key: 'agent-flow', action: 'comment' }])
  assert.ok(!JSON.stringify(uses).includes('t_1') && !JSON.stringify(uses).includes('password'))
  assert.deepEqual(usesOfCall({ name: 'kanban_show', input: { task_id: 't_1' } }), [], 'no board: cannot be attributed, so skipped')
  assert.deepEqual(usesOfCall({ name: 'kanban_show', input: { board: '../etc/passwd' } }), [], 'not a slug')
})

test('uses: a user message is a cron or gateway touch by its platform only; the text is never read', () => {
  assert.deepEqual(usesOfMessage({ role: 'user', platform: 'cron', content: PRIVATE_PROMPT }), { kind: 'subsystem', key: 'cron', action: 'run' })
  assert.deepEqual(usesOfMessage({ role: 'user', platform: 'Matrix', content: 'x' }), { kind: 'subsystem', key: 'gateway', action: 'matrix' })
  assert.equal(usesOfMessage({ role: 'user', platform: 'cli', content: 'x' }), null, 'a CLI turn is not the gateway')
  assert.equal(usesOfMessage({ role: 'user', platform: 'something-new', content: 'x' }), null, 'an unknown source is not counted')
  assert.equal(usesOfMessage({ role: 'assistant', platform: 'matrix', content: 'x' }), null, 'only inbound turns')
  assert.equal(usesOfMessage({ role: 'user', content: 'x' }), null)
})

test('tracker: reads each buffer once, counts a call that arrives twice (hook and transcript) once', () => {
  const events: Ev[] = [tool('a', 'supermemory_search', { container_tag: 'omh_family' }, 5, 'dup'), tool('a', 'supermemory_search', { container_tag: 'omh_family' }, 5, 'dup')]
  const tracker = new EventUseTracker()
  const uses = tracker.update([sessionOf('taxis')], () => events, NOW)
  assert.equal(uses.length, 1)
  const more = [...events, tool('a', 'supermemory_store', { container_tag: 'omh_family' }, 1, 'n1')]
  assert.equal(tracker.update([sessionOf('taxis')], () => more, NOW).length, 2, 'only the new event was read')
})

test('tracker: replayed history without a time is skipped, live events without a time get the page clock', () => {
  const noTime = (history: boolean): Ev => ({ time: 3, type: 'tool_call_start', ...(history ? { history: true } : {}), payload: { agent: 'nobody', tool: 'cronjob_manage', toolUseId: `x${history}`, inputData: {} } })
  const uses = new EventUseTracker().update([sessionOf('taxis')], () => [noTime(true), noTime(false)], NOW)
  assert.equal(uses.length, 1)
  assert.equal(uses[0].at, NOW)
})

// ─── single view: one session's use only ────────────────────────────────────

test('single view: the tracker reads only the open session, and a block shows only its use (two-session fixture)', () => {
  const f = twoSessions()
  const read: string[] = []
  const tracker = new SingleSessionTracker()
  const sources = tracker.update(sessionOf('taxis'), id => { read.push(id); return f.eventsOf(id) }, NOW)
  assert.deepEqual([...new Set(read)], ['hermes-taxis'], 'the other session buffer is never touched')
  const views = buildSingleBlocks({ sources, now: NOW, options: defaultOptions() })
  assert.deepEqual(views.map(v => v.id).sort(), ['bash:git', 'memory:omh_family', 'subsystem:cron', 'subsystem:gateway'].sort())
  const git = views.find(v => v.id === 'bash:git')!
  assert.equal(git.sublabel, '1 call', 'sophia ran git log too: not counted here')
  assert.ok(!views.some(v => v.id === 'bash:pnpm' || v.id === 'memory:matrix_org' || v.id === 'kanban:agent-flow'), 'sophia-only blocks are absent')
  assert.ok(!views.some(v => v.inspection.items.some(i => i.profile !== 'taxis')), 'every row of every inspection is taxis')

  // Switching to the other session drops everything of the first.
  const other = buildSingleBlocks({ sources: tracker.update(sessionOf('sophia'), f.eventsOf, NOW), now: NOW, options: defaultOptions() })
  assert.deepEqual(other.map(v => v.id).sort(), ['bash:git', 'bash:pnpm', 'kanban:agent-flow', 'memory:matrix_org', 'subsystem:cron'].sort())
  assert.equal(other.find(v => v.id === 'bash:git')!.sublabel, '1 call')
  assert.ok(!other.some(v => v.id === 'memory:omh_family' || v.id === 'subsystem:gateway'), 'taxis-only blocks are gone')
  assert.deepEqual(buildSingleBlocks({ sources: tracker.update(null, f.eventsOf, NOW), now: NOW, options: defaultOptions() }), [], 'no session, no blocks')
})

test('single view: no memory content, query, task id, prompt, job name or room text reaches a block or an inspection', () => {
  const f = twoSessions()
  for (const profile of ['taxis', 'sophia']) {
    const views = buildSingleBlocks({ sources: new SingleSessionTracker().update(sessionOf(profile), f.eventsOf, NOW), now: NOW, options: defaultOptions() })
    const wire = JSON.stringify(views)
    for (const secret of [PRIVATE_QUERY, 'salary', PRIVATE_BODY, PRIVATE_PROMPT, 'secret-job', 'hello from the room', 't_1']) {
      assert.ok(!wire.includes(secret), `${profile}: ${secret}`)
    }
  }
})

test('single view: linger per kind, fade, pin, linger 0 and the single show toggle (the fleet toggle does not hide it)', () => {
  const f = twoSessions()
  const o = defaultOptions()
  const sources = new SingleSessionTracker().update(sessionOf('taxis'), f.eventsOf, NOW)
  const at = (agoSec: number, options: AgentFlowOptions = o, pins?: ReadonlySet<string>) =>
    buildSingleBlocks({ sources, now: NOW + agoSec * S, options, pins }).map(v => v.id)
  // git: 5 s old at NOW, bash linger 20 s, fade 15 s. cron: 12 s old, subsystem linger 45 s. omh_family: 8 s old, memory linger 60 s.
  assert.ok(at(0).includes('bash:git') && at(0).includes('memory:omh_family') && at(0).includes('subsystem:cron'))
  const alphaOf = (id: string, agoSec: number) => buildSingleBlocks({ sources, now: NOW + agoSec * S, options: o }).find(v => v.id === id)?.alpha
  // (the offsets are seconds after NOW; the use itself is already 5 s / 8 s / 12 s old at NOW)
  assert.equal(alphaOf('bash:git', 15), 1, 'inside linger: 20 s old')
  const mid = alphaOf('bash:git', 20 + 7.5 - 5)!
  assert.ok(mid > 0.45 && mid < 0.55, `half way through the fade (${mid})`)
  assert.equal(alphaOf('bash:git', 20 + 15 - 5 + 1), undefined, 'gone after linger + fade')
  assert.ok(alphaOf('memory:omh_family', 20 + 15 - 5 + 1) === 1, 'memory has its own, longer linger')
  assert.equal(alphaOf('subsystem:cron', 45 + 15 - 12 + 1), undefined)
  assert.ok(at(100, o, setPinned(new Set<string>(), 'bash:git', true)).includes('bash:git'), 'a pin keeps it')
  const zero = { ...o, lingerSeconds: { ...o.lingerSeconds, bash: 0 } }
  assert.ok(!at(0, zero).includes('bash:git'), 'linger 0 hides at once')
  assert.ok(at(0, zero, setPinned(new Set<string>(), 'bash:git', true)).includes('bash:git'), 'a pin beats linger 0')
  const noSingle = { ...o, show: { ...o.show, single: { ...o.show.single, bash: false } } }
  assert.ok(!at(0, noSingle).includes('bash:git'), 'single toggle off')
  const noFleet = { ...o, show: { ...o.show, fleet: { ...o.show.fleet, bash: false } } }
  assert.ok(at(0, noFleet).includes('bash:git'), 'fleet toggle off does not hide the single view')
})

test('single view: the bash row shows the masked full command, the block only the head', () => {
  const events: Ev[] = [bashCall('taxis · Plan', 'curl -H "Authorization: Bearer abcdef1234567890abcdef1234567890" https://x.test', 3, 'c1')]
  const views = buildSingleBlocks({ sources: new SingleSessionTracker().update(sessionOf('taxis'), () => events, NOW), now: NOW, options: defaultOptions() })
  assert.equal(views.length, 1)
  assert.equal(views[0].label, 'curl')
  assert.ok(!views[0].sublabel.includes('Bearer'))
  const cmd = views[0].inspection.items[0].detail!
  assert.ok(cmd.startsWith('curl -H') && !cmd.includes('abcdef1234567890abcdef1234567890'), cmd)
})

// ─── agents in the window and the fleet badge ───────────────────────────────

test('agentsInWindow: counts the agents whose own latest use is within linger + fade of the kind, not every agent ever', () => {
  const o = defaultOptions() // memory: 60 + 15
  let store: BlockStore = new Map<string, ResourceBlock>()
  store = recordUse(store, { kind: 'memory', key: 'omh_family', at: NOW - 80 * S, agentId: 'sophia' })
  store = recordUse(store, { kind: 'memory', key: 'omh_family', at: NOW - 30 * S, agentId: 'taxis' })
  store = recordUse(store, { kind: 'memory', key: 'omh_family', at: NOW - 5 * S, agentId: 'org' })
  const block = store.get('memory:omh_family')!
  assert.deepEqual(block.agents, ['sophia', 'taxis', 'org'])
  assert.deepEqual(agentsInWindow(block, NOW, o), ['taxis', 'org'], 'sophia used it 80 s ago: outside 75 s')
  assert.deepEqual(agentsInWindow(block, NOW + 30 * S, o), ['taxis', 'org'], '30 s later: taxis is 60 s old (in), org 35 s (in)')
  assert.deepEqual(agentsInWindow(block, NOW + 50 * S, o), ['org'], '50 s later: taxis is 80 s old (out)')
  assert.deepEqual(agentsInWindow(block, NOW + 200 * S, o), [], 'everyone has aged out')
  assert.deepEqual(agentsInWindow(block, NOW, { ...o, lingerSeconds: { ...o.lingerSeconds, memory: 0 } }), [], 'linger 0 has no window')
  // A hand-made block without per-agent times: everyone counts at the block time.
  const bare: ResourceBlock = { kind: 'bash', key: 'git', label: 'git', lastUsedAt: NOW - 5 * S, useCount: 2, agents: ['a', 'b'] }
  assert.deepEqual(agentsInWindow(bare, NOW, o), ['a', 'b'])
  assert.deepEqual(agentsInWindow(bare, NOW + 60 * S, o), [])
})

const space = (tag: string, last: Record<string, number>): SupermemoryNamespaceNode => {
  const counts = { store: 0, search: 1, forget: 0 }
  const newest = Math.max(...Object.values(last))
  return {
    id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag, counts, total: Object.keys(last).length,
    byProfile: Object.fromEntries(Object.keys(last).map(p => [p, counts])), daily: [],
    lastEventAt: newest, lastByProfile: last, recent: [],
  } as SupermemoryNamespaceNode
}

test('fleet badge, memory: count and names of the agents in the window; hover has names only', () => {
  const o = defaultOptions()
  const graph = (last: Record<string, number>) => buildFleetGraph({ instances: twoSessions().instances(), supermemory: [space('omh_family', last)], selection: all, now: NOW, options: o })
  const node = (g: ReturnType<typeof graph>) => g.nodes.find(n => n.kind === 'supermemory')!
  const both = node(graph({ taxis: NOW - 10 * S, sophia: NOW - 70 * S }))
  assert.deepEqual(both.badge, { count: 2, names: ['taxis', 'sophia'] })
  const one = node(graph({ taxis: NOW - 10 * S, sophia: NOW - 80 * S }))
  assert.deepEqual(one.badge, { count: 1, names: ['taxis'] }, 'sophia is past linger + fade (75 s)')
  assert.deepEqual(Object.keys(one.badge!).sort(), ['count', 'names'], 'the badge carries nothing else')
  // An agent without a cloud on the map (not in the instances) is not counted.
  const unknown = node(graph({ taxis: NOW - 10 * S, stranger: NOW - 5 * S }))
  assert.deepEqual(unknown.badge, { count: 1, names: ['taxis'] })
})

test('fleet badge, bash: the agents that ran the head in the window (two-session fixture)', () => {
  const f = twoSessions()
  const o = defaultOptions() // bash 20 + 15 = 35 s
  const bash = new BashUseTracker().update(f.sessions, f.eventsOf, NOW)
  const g = (now: number) => buildFleetGraph({ instances: f.instances(), bash, selection: all, now, options: o })
  const git = (now: number) => g(now).nodes.find(n => n.id === 'bash:git')!
  // taxis ran git 5 s before NOW, sophia 7 s before NOW.
  assert.deepEqual(git(NOW).badge, { count: 2, names: ['taxis', 'sophia'] })
  assert.deepEqual(g(NOW).nodes.find(n => n.id === 'bash:pnpm')!.badge, { count: 1, names: ['sophia'] })
  // 39 s after NOW: taxis' use is 44 s old (out), sophia's is 46 s old (out) -> block is gone.
  assert.equal(g(NOW + 39 * S).nodes.find(n => n.id === 'bash:git'), undefined)
  // Pinned and quiet: the block stays, the badge is gone (nobody touched it in the window).
  const pinned = buildFleetGraph({ instances: f.instances(), bash, selection: all, now: NOW + 120 * S, options: o, pins: setPinned(new Set<string>(), 'bash:git', true) })
  const kept = pinned.nodes.find(n => n.id === 'bash:git')!
  assert.ok(kept, 'a pin keeps the block')
  assert.equal(kept.badge, undefined)
})

test('fleet badge, kanban: the assignees of recent events in the window', () => {
  const o = defaultOptions() // kanban 90 + 15
  const board: PublicKanbanBoardNode = {
    id: 'kanban:agent-flow', type: 'kanban-board', slug: 'agent-flow', name: 'agent-flow', description: '', archived: false,
    taskCounts: { running: 1 }, totalTasks: 1, lastEventAt: NOW - 5 * S,
    recentEvents: [
      { id: 1, taskId: 't1', taskTitle: 'x', assignee: 'sophia', kind: 'claimed', runId: null, at: NOW - 200 * S },
      { id: 2, taskId: 't1', taskTitle: 'x', assignee: 'taxis', kind: 'heartbeat', runId: null, at: NOW - 5 * S },
    ],
  } as PublicKanbanBoardNode
  const g = buildFleetGraph({ instances: twoSessions().instances(), kanban: [board], selection: all, now: NOW, options: o })
  assert.deepEqual(g.nodes.find(n => n.kind === 'kanban')!.badge, { count: 1, names: ['taxis'] }, 'sophia touched it 200 s ago: outside the window')
})

// ─── subsystem blocks on the fleet map ──────────────────────────────────────

function subsystemNodes(f = twoSessions(), now = NOW): UseNode[] {
  return buildUseNodes(new EventUseTracker({ kinds: ['subsystem'] }).update(f.sessions, f.eventsOf, now), 'subsystem')
}

test('subsystem nodes: cron and gateway from tool calls and message platforms, with the agents that touched them', () => {
  const nodes = subsystemNodes()
  assert.deepEqual(nodes.map(n => n.id).sort(), ['subsystem:cron', 'subsystem:gateway'])
  const cron = nodes.find(n => n.key === 'cron')!
  assert.deepEqual(Object.keys(cron.byProfile).sort(), ['sophia', 'taxis'], 'taxis via cronjob_manage, sophia via a cron turn')
  assert.equal(cron.total, 2)
  assert.deepEqual(cron.actions, { manage: 1, run: 1 })
  const gateway = nodes.find(n => n.key === 'gateway')!
  assert.deepEqual(Object.keys(gateway.byProfile), ['taxis'])
  assert.equal(useCountsLine(gateway), 'matrix ×1')
  // Memory and Kanban calls are not subsystem uses.
  assert.ok(!nodes.some(n => n.kind !== 'subsystem'))
})

test('subsystem graph node: appears with its badge, linked to the clouds, within the subsystem linger; fades; pin; switched off', () => {
  const f = twoSessions()
  const o = defaultOptions() // subsystem 45 + 15
  const subsystem = subsystemNodes(f)
  const g = (now: number, options = o, pins?: ReadonlySet<string>) => buildFleetGraph({ instances: f.instances(), subsystem, selection: all, now, options, pins })
  const cron = g(NOW).nodes.find(n => n.id === 'subsystem:cron')!
  assert.equal(cron.kind, 'subsystem')
  assert.equal(cron.label, 'cron')
  assert.equal(cron.sublabel, '2 events')
  assert.deepEqual(cron.badge, { count: 2, names: ['taxis', 'sophia'] }, 'taxis 12 s ago, sophia 13 s ago')
  assert.deepEqual(cron.life, { lastUsedAt: NOW - 12 * S, lingerMs: 45 * S, fadeMs: 15 * S, pinned: false })
  assert.deepEqual(g(NOW).edges.filter(e => e.kind === 'subsystem').map(e => e.to).sort(), ['subsystem:cron', 'subsystem:cron', 'subsystem:gateway'])
  assert.ok(g(NOW).edges.filter(e => e.kind === 'subsystem').every(e => e.life?.lingerMs === 45 * S))
  assert.equal(g(NOW + 40 * S).nodes.find(n => n.id === 'subsystem:cron')!.life!.lastUsedAt, NOW - 12 * S, 'still drawn in its fade')
  assert.equal(g(NOW + 60 * S).nodes.find(n => n.id === 'subsystem:cron'), undefined, 'gone after linger + fade')
  assert.ok(g(NOW + 600 * S, o, setPinned(new Set<string>(), 'subsystem:cron', true)).nodes.some(n => n.id === 'subsystem:cron'), 'a pin keeps it')
  const off = { ...o, show: { ...o.show, fleet: { ...o.show.fleet, subsystem: false } } }
  assert.ok(!g(NOW, off).nodes.some(n => n.kind === 'subsystem'))
  assert.ok(g(NOW, off).edges.every(e => e.kind !== 'subsystem'), 'no link for a switched-off kind')
  const zero = { ...o, lingerSeconds: { ...o.lingerSeconds, subsystem: 0 } }
  assert.ok(!g(NOW, zero).nodes.some(n => n.kind === 'subsystem'), 'linger 0 hides at once')
})

test('subsystem scene: the node is a subsystem resource with its badge, placed next to the clouds that use it', () => {
  const f = twoSessions()
  const subsystem = subsystemNodes(f)
  // What the relay delivers: the profile's main node and its session node first.
  const relay = (profile: string, node: string): SessionEventLike[] => [
    { time: 0, type: 'agent_spawn', payload: { name: profile, isMain: true, profile, group: profile, task: `Hermes profile ${profile}` } },
    { time: 0, type: 'agent_spawn', payload: { name: node, parent: profile, startedAt: T0 - 3600 * S, task: node } },
  ]
  const events: Record<string, SessionEventLike[]> = { 'hermes-taxis': relay('taxis', 'taxis · Plan'), 'hermes-sophia': relay('sophia', 'sophia · Report') }
  const instances = instancesFromSessionEvents(f.sessions, id => events[id] ?? [])
  const graph = buildFleetGraph({ instances, subsystem, selection: all, now: NOW })
  const replay = new FleetReplay()
  const scene = buildFleetScene({ sessions: f.sessions, stateOf: id => replay.advance(id, (events[id] ?? []) as never), instances, selection: all, graph })
  const node = scene.state.agents.get('subsystem:cron')!
  assert.equal(node.resourceKind, 'subsystem')
  assert.equal(node.name, 'cron')
  assert.deepEqual(node.badge, { count: 2, names: ['taxis', 'sophia'] })
  assert.ok(node.block && node.block.lingerMs === 45 * S)
  assert.ok(scene.state.edges.some(e => e.to === 'subsystem:cron' && e.fromCloud))
})

test('subsystem inspector: kind subsystem, verbs and profiles only', () => {
  const nodes = subsystemNodes()
  const insp = inspectResource('subsystem:gateway', undefined, undefined, undefined, undefined, nodes)!
  assert.equal(insp.kind, 'subsystem')
  assert.equal(insp.title, 'gateway')
  assert.equal(insp.pinId, 'subsystem:gateway')
  assert.deepEqual(insp.items.map(i => ({ profile: i.profile, action: i.action, detail: i.detail })), [{ profile: 'taxis', action: 'matrix', detail: undefined }])
  const wire = JSON.stringify([insp, buildUseBlocks(nodes)])
  for (const secret of [PRIVATE_PROMPT, 'hello from the room', 'secret-job']) assert.ok(!wire.includes(secret), secret)
  assert.equal(inspectResource('subsystem:nope', undefined, undefined, undefined, undefined, nodes), null)
})

test('bash blocks keep the per-agent time the badge needs', () => {
  const f = twoSessions()
  const blocks = buildBashBlocks(new BashUseTracker().update(f.sessions, f.eventsOf, NOW))
  assert.deepEqual(blocks.get('bash:git')!.agentLast, { taxis: NOW - 5 * S, sophia: NOW - 7 * S })
})
