import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SimulationEvent } from '@/lib/agent-types'
import { instancesFromSessionEvents, splitInstanceId, type FleetSelectionView, type SessionLike } from '@/lib/fleet/fleet-model'
import { buildFleetGraph } from '@/lib/fleet/fleet-graph'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'
import { anonymizeToolInput, createAnonymizePolicy, isAnonymized } from '@/lib/content-privacy'
import { buildFleetScene, FleetReplay, openTargetOf } from './fleet-scene'
import { buildSessionItems, pickDefaultAgentId } from '@/lib/session-detail'
import { RESTING_TOOLS_PER_AGENT } from './animate'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)
const MIN = 60_000
const NOW = T0 + 60 * MIN
const all: FleetSelectionView = { isSelected: () => true }

const session = (profile: string, over: Partial<SessionLike> = {}): SessionLike => ({
  id: `hermes-${profile}`, label: profile, status: 'active', startTime: T0, lastActivityTime: NOW, ...over,
})

/** What the relay delivers for a profile: its main node, one session node and some actions. */
function profileEvents(profile: string, node: string, actions: Array<{ tool: string; input: Record<string, unknown>; hermesTool: string }>, anonymize: boolean): SimulationEvent[] {
  const events: SimulationEvent[] = [
    { time: 0, type: 'agent_spawn', payload: { name: profile, isMain: true, profile, group: profile, task: `Hermes profile ${profile}` } },
    { time: 0, type: 'agent_spawn', payload: { name: node, parent: profile, startedAt: T0, task: node } },
  ]
  actions.forEach((a, i) => {
    // The relay anonymizes before the event leaves it (lib/content-privacy.ts); mirror that here.
    const shown = anonymize ? anonymizeToolInput(a.hermesTool, a.input) : { args: String(Object.values(a.input)[0] ?? ''), inputData: a.input }
    events.push({ time: 10 + i * 5, type: 'tool_call_start', payload: { agent: node, tool: a.tool, toolUseId: `u${i}`, args: shown.args, inputData: shown.inputData } })
    events.push({ time: 12 + i * 5, type: 'tool_call_end', payload: { agent: node, tool: a.tool, toolUseId: `u${i}`, result: 'ok' } })
  })
  events.push({ time: 20, type: 'message', payload: { agent: node, role: 'assistant', content: anonymize ? '(42 chars)' : 'checking the build output now' } })
  return events
}

const SECRET_CMD = 'curl -H "x: y" https://internal.example/very-private-endpoint'
const SECRET_FILE = '/srv/private/plan.md'

function fixture() {
  const sessions = [session('taxis'), session('sophia')]
  const events: Record<string, SimulationEvent[]> = {
    'hermes-taxis': profileEvents('taxis', 'taxis · Plan', [
      { tool: 'Bash', hermesTool: 'terminal', input: { command: SECRET_CMD } },
      { tool: 'Read', hermesTool: 'read_file', input: { path: SECRET_FILE } },
    ], true),
    'hermes-sophia': profileEvents('sophia', 'sophia · Report', [
      { tool: 'Bash', hermesTool: 'terminal', input: { command: 'pnpm test' } },
    ], false),
  }
  return { sessions, events }
}

function sceneFor(f: ReturnType<typeof fixture>, selection: FleetSelectionView = all, replay = new FleetReplay(), extra: { kanban?: PublicKanbanBoardNode[]; supermemory?: SupermemoryNamespaceNode[] } = {}) {
  const instances = instancesFromSessionEvents(f.sessions, id => f.events[id] ?? [])
  const graph = buildFleetGraph({ instances, kanban: extra.kanban, supermemory: extra.supermemory, selection, now: NOW })
  const scene = buildFleetScene({
    sessions: f.sessions, stateOf: id => replay.advance(id, f.events[id] ?? []), instances, selection, graph,
  })
  return { scene, replay, graph, instances }
}

const board = (slug: string, assignee: string): PublicKanbanBoardNode => ({
  id: `kanban:${slug}`, type: 'kanban-board', slug, name: slug, description: '', archived: false,
  taskCounts: { running: 1, done: 1 }, totalTasks: 2,
  recentEvents: [{ id: 1, taskId: 't1', taskTitle: 'Write the plan', assignee, kind: 'claimed', runId: null, at: NOW - MIN }],
  lastEventAt: NOW - MIN,
} as PublicKanbanBoardNode)

const space = (tag: string, byProfile: Record<string, number>): SupermemoryNamespaceNode => ({
  id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag,
  counts: { store: 1, search: 3, forget: 0 }, total: 4,
  byProfile: Object.fromEntries(Object.entries(byProfile).map(([p, n]) => [p, { store: 0, search: n, forget: 0 }])),
  daily: [], lastEventAt: NOW - MIN, lastByProfile: {}, recent: [],
})

test('fleet scene: two active profiles each show their agent nodes with their action nodes', () => {
  const { scene } = sceneFor(fixture())
  const agents = [...scene.state.agents.values()]
  const names = agents.map(a => a.name).sort()
  // No central hub: each session is its own node, the profile's main node is not drawn.
  assert.deepEqual(names, ['sophia · Report', 'taxis · Plan'])
  for (const a of agents) assert.ok(a.sessionId, `${a.name} carries its session`)
  const cards = (agent: string) => [...scene.state.toolCalls.values()].filter(tc => tc.agentId === agent)
  assert.equal(cards('hermes-taxis::taxis · Plan').length, 2, 'taxis: both tool calls orbit its node')
  assert.equal(cards('hermes-sophia::sophia · Report').length, 1, 'sophia: its tool call orbits its node')
  // Same shared edges as the single view: a tool edge from node to card.
  const toolEdges = scene.state.edges.filter(e => e.type === 'tool')
  assert.equal(toolEdges.length, 3)
  // The message shows as a bubble on its node, as in the single view.
  assert.equal(scene.state.agents.get('hermes-sophia::sophia · Report')!.messageBubbles.length, 1)
  // Satellites sit near their node (orbit), not at the origin.
  for (const tc of scene.state.toolCalls.values()) {
    const a = scene.state.agents.get(tc.agentId)!
    assert.ok(Math.hypot(tc.x - a.x, tc.y - a.y) < 400, 'a card orbits its node')
  }
})

test('fleet scene: the two profiles are laid out apart, not on top of each other', () => {
  const { scene } = sceneFor(fixture())
  const t = scene.state.agents.get('hermes-taxis::taxis · Plan')!
  const s = scene.state.agents.get('hermes-sophia::sophia · Report')!
  assert.ok(Math.hypot(t.x - s.x, t.y - s.y) > 150)
})

test('fleet scene: clicking an agent, or one of its satellites, opens that agent in its session', () => {
  const { scene } = sceneFor(fixture())
  assert.deepEqual(openTargetOf(scene, 'hermes-sophia::sophia · Report'), { sessionId: 'hermes-sophia', instanceId: 'hermes-sophia::sophia · Report', openId: 'hermes-sophia::sophia · Report' })
  const card = [...scene.state.toolCalls.values()].find(tc => tc.agentId === 'hermes-taxis::taxis · Plan')!
  assert.deepEqual(openTargetOf(scene, card.id), { sessionId: 'hermes-taxis', instanceId: 'hermes-taxis::taxis · Plan', openId: 'hermes-taxis::taxis · Plan' })
  assert.equal(openTargetOf(scene, null), null)
  assert.equal(openTargetOf(scene, 'nope'), null)
})

test('fleet scene: no hub node; a profile that has only its main node still shows as one node and opens its session', () => {
  const f = fixture()
  f.sessions.push(session('lone'))
  f.events['hermes-lone'] = [{ time: 0, type: 'agent_spawn', payload: { name: 'lone', isMain: true, profile: 'lone', group: 'lone', task: 'Hermes profile lone' } }]
  const { scene } = sceneFor(f)
  assert.ok(!scene.state.agents.has('hermes-taxis::taxis'), 'taxis has session nodes, so its main node is not drawn')
  const lone = scene.state.agents.get('hermes-lone::lone')!
  assert.equal(lone.isMain, true)
  // The main node has no conversation: the detail must not be asked for it.
  assert.deepEqual(openTargetOf(scene, lone.id), { sessionId: 'hermes-lone', instanceId: 'hermes-lone::lone', openId: 'hermes-lone' })
  assert.equal(splitInstanceId('hermes-lone').agentName, undefined, 'a plain session id lets the panel pick the most recent session node')
  // Resource nodes open nothing.
  const withBoard = sceneFor(fixture(), all, new FleetReplay(), { kanban: [board('b1', 'taxis')] }).scene
  assert.equal(openTargetOf(withBoard, 'kanban:b1'), null)
})

test('fleet scene: anonymize on one profile hides its content while the other shows content', () => {
  const f = fixture()
  // Same policy the relay applies: taxis anonymized, sophia full.
  const policy = createAnonymizePolicy({ value: 'taxis', warn: () => {} })
  assert.equal(isAnonymized(policy, 'taxis'), true)
  assert.equal(isAnonymized(policy, 'sophia'), false)
  const { scene } = sceneFor(f)
  const text = (agent: string) => JSON.stringify([...scene.state.toolCalls.values()].filter(tc => tc.agentId === agent).map(tc => [tc.args, tc.inputData]))
  const bubbles = (agent: string) => scene.state.agents.get(agent)!.messageBubbles.map(b => b.text).join('|')

  const taxis = text('hermes-taxis::taxis · Plan')
  assert.ok(!taxis.includes('very-private-endpoint'), 'anonymized command text is not on the satellites')
  assert.ok(taxis.includes('curl · '), 'structure only: command name and size')
  assert.ok(taxis.includes(SECRET_FILE), 'file path stays (structure)')
  assert.ok(!bubbles('hermes-taxis::taxis · Plan').includes('checking the build'), 'message text hidden')

  const sophia = text('hermes-sophia::sophia · Report')
  assert.ok(sophia.includes('pnpm test'), 'the other profile shows its content')
  assert.ok(bubbles('hermes-sophia::sophia · Report').includes('checking the build'))
})

test('fleet scene: deselecting an agent only hides it, and it comes back with its state and history', () => {
  const f = fixture()
  const replay = new FleetReplay()
  const before = sceneFor(f, all, replay).scene
  const key = 'hermes-taxis::taxis · Plan'
  const hidden = new Set(['hermes-taxis::taxis · Plan', 'hermes-taxis'])
  const without: FleetSelectionView = { isSelected: id => !hidden.has(id) }
  const during = sceneFor(f, without, replay).scene
  assert.ok(!during.state.agents.has(key), 'the deselected node is off the map')
  assert.ok([...during.state.toolCalls.values()].every(tc => tc.agentId !== key), 'and so are its satellites')
  assert.ok(during.state.agents.has('hermes-sophia::sophia · Report'), 'the other profile stays')

  // New activity while hidden is not lost: the replay keeps running.
  f.events['hermes-taxis'].push({ time: 40, type: 'tool_call_start', payload: { agent: 'taxis · Plan', tool: 'Bash', toolUseId: 'late', args: 'git · 10 chars' } })
  const after = sceneFor(f, all, replay).scene
  const node = after.state.agents.get(key)!
  assert.equal(node.state, 'tool_calling', 'it keeps its state')
  assert.equal([...after.state.toolCalls.values()].filter(tc => tc.agentId === key).length, 3, 'with its own history, including what happened while hidden')
  assert.equal(before.state.agents.get(key)!.toolCalls, 2)
  assert.equal(node.toolCalls, 3)
})

test('fleet scene: an idle node stays on the map, idle', () => {
  const f = fixture()
  f.events['hermes-sophia'].push({ time: 60, type: 'agent_complete', payload: { name: 'sophia · Report', idle: true } })
  const { scene } = sceneFor(f)
  const node = scene.state.agents.get('hermes-sophia::sophia · Report')!
  assert.equal(node.state, 'idle')
  assert.ok(node.opacity > 0)
  assert.equal([...scene.state.toolCalls.values()].filter(tc => tc.agentId === node.id).length, 1, 'its action history stays')
})

test('fleet scene: satellites per node are capped to the newest, the node keeps its full count', () => {
  const f = fixture()
  const many = Array.from({ length: 20 }, (_, i) => ({ tool: 'Read', hermesTool: 'read_file', input: { path: `/f/${i}.ts` } }))
  f.events['hermes-sophia'] = profileEvents('sophia', 'sophia · Report', many, false)
  const { scene } = sceneFor(f)
  const node = scene.state.agents.get('hermes-sophia::sophia · Report')!
  const cards = [...scene.state.toolCalls.values()].filter(tc => tc.agentId === node.id)
  assert.equal(cards.length, RESTING_TOOLS_PER_AGENT)
  assert.equal(node.toolCalls, 20)
  assert.ok(cards.some(c => c.args.includes('/f/19.ts')), 'the newest are kept')
})

test('fleet scene: Kanban boards and Supermemory namespaces stay on the map, linked to the agents that use them', () => {
  const { scene } = sceneFor(fixture(), all, new FleetReplay(), {
    kanban: [board('agent-flow', 'taxis')],
    supermemory: [space('omh_family', { sophia: 3 })],
  })
  const agents = [...scene.state.agents.values()]
  const kanban = agents.filter(a => a.resourceKind === 'kanban')
  const memory = agents.filter(a => a.resourceKind === 'supermemory')
  assert.equal(kanban.length, 1)
  assert.equal(memory.length, 1)
  const links = scene.state.edges.filter(e => e.type === 'resource')
  const link = (resource: string) => links.find(e => e.to === resource)!
  // Links start at the profile's cloud, not at a node, and carry their last use time.
  assert.equal(link(kanban[0].id).from, 'cloud:taxis', 'Kanban links to the cloud of the profile that works on it')
  assert.equal(link(memory[0].id).from, 'cloud:sophia', 'a namespace links to the cloud with events in it')
  assert.ok(links.every(l => l.fromCloud && typeof l.lastUsedAt === 'number'))
  assert.equal(link(kanban[0].id).lastUsedAt, NOW - MIN)
  // Resources are not an agent to open.
  assert.equal(openTargetOf(scene, kanban[0].id), null)
})

test('fleet replay: resets when the buffer is shorter, and does not reprocess an unchanged buffer', () => {
  const f = fixture()
  const replay = new FleetReplay()
  const a = replay.advance('hermes-taxis', f.events['hermes-taxis'])
  assert.equal(replay.advance('hermes-taxis', f.events['hermes-taxis']), a, 'same state object when nothing is new')
  const b = replay.advance('hermes-taxis', f.events['hermes-taxis'].slice(0, 2))
  assert.equal(b.toolCalls.size, 0, 'a shorter buffer starts over')
})

test('fleet replay feeds the session detail: a completed or idle profile still has its whole conversation', () => {
  const f = fixture()
  // Taxis finished (every node complete), Sophia is idle after a while.
  f.events['hermes-taxis'].push({ time: 50, type: 'agent_complete', payload: { name: 'taxis · Plan' } })
  f.events['hermes-taxis'].push({ time: 51, type: 'agent_complete', payload: { name: 'taxis' } })
  f.events['hermes-sophia'].push({ time: 60, type: 'agent_complete', payload: { name: 'sophia · Report', idle: true } })
  const replay = new FleetReplay()
  const { scene } = sceneFor(f, all, replay)
  // The node stays on the map, dimmed, with its satellites.
  assert.equal(scene.state.agents.get('hermes-taxis::taxis · Plan')!.state, 'complete')

  for (const [sid, node, tools] of [['hermes-taxis', 'taxis · Plan', 2], ['hermes-sophia', 'sophia · Report', 1]] as const) {
    // What the panel is fed from when opened from the Fleet (main node click = plain session id).
    const detail = replay.advance(sid, f.events[sid])
    const open = openTargetOf(scene, `${sid}::${node}`)!
    assert.equal(open.openId, `${sid}::${node}`)
    assert.ok(detail.agents.has(node), `${node} is in the panel's agents although it finished`)
    const picked = pickDefaultAgentId(detail.agents, detail.conversations)
    assert.equal(picked, node, 'a main-node click picks the session node, not the empty main node')
    const items = buildSessionItems(detail.conversations.get(picked!) ?? [])
    assert.equal(items.filter(i => i.kind === 'tool').length, tools, `${node}: its tool calls are in the detail`)
    assert.ok(items.some(i => i.kind === 'message'), `${node}: its message is in the detail`)
  }

  // Anonymized profile: the detail carries structure only; the other profile carries content.
  const detailText = (sid: string, node: string) => JSON.stringify(buildSessionItems(replay.advance(sid, f.events[sid]).conversations.get(node) ?? []))
  assert.ok(!detailText('hermes-taxis', 'taxis · Plan').includes('very-private-endpoint'))
  assert.ok(!detailText('hermes-taxis', 'taxis · Plan').includes('checking the build'))
  assert.ok(detailText('hermes-sophia', 'sophia · Report').includes('pnpm test'))
  assert.ok(detailText('hermes-sophia', 'sophia · Report').includes('checking the build'))
})

// ─── Clouds, placement, uncapped ────────────────────────────────────────────

const positions = (scene: ReturnType<typeof sceneFor>['scene']) =>
  [...scene.state.agents.values()].map(a => [a.id, Math.round(a.x * 1000) / 1000, Math.round(a.y * 1000) / 1000]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))

test('fleet scene: layout is deterministic, same input gives the same map', () => {
  const extra = { kanban: [board('agent-flow', 'taxis')], supermemory: [space('omh_family', { sophia: 3, taxis: 1 })] }
  const a = sceneFor(fixture(), all, new FleetReplay(), extra).scene
  const b = sceneFor(fixture(), all, new FleetReplay(), extra).scene
  assert.deepEqual(positions(a), positions(b))
  assert.deepEqual([...a.clusters], [...b.clusters])
})

test('fleet scene: clouds carry the profile name and their session nodes; no link joins two sessions of a profile', () => {
  const f = fixture()
  f.events['hermes-taxis'].push({ time: 25, type: 'agent_spawn', payload: { name: 'taxis · Review', parent: 'taxis', startedAt: T0 + MIN, task: 'review' } })
  const { scene } = sceneFor(f)
  const clouds = scene.state.clouds!
  assert.deepEqual(clouds.map(c => c.label).sort(), ['sophia', 'taxis'])
  const taxis = clouds.find(c => c.label === 'taxis')!
  assert.deepEqual(taxis.members.map(m => m.id).sort(), ['hermes-taxis::taxis · Plan', 'hermes-taxis::taxis · Review'])
  const [p, r] = ['hermes-taxis::taxis · Plan', 'hermes-taxis::taxis · Review'].map(id => scene.state.agents.get(id)!)
  assert.ok(Math.hypot(p.x - r.x, p.y - r.y) > 100, 'the two sessions are apart in the blob')
  // No edge between agents of one profile (only tool edges to satellites).
  for (const e of scene.state.edges) assert.ok(e.type !== 'parent-child' && !(scene.state.agents.has(e.from) && scene.state.agents.has(e.to) && e.type !== 'resource'))
})

test('fleet scene: a resource sits near the clouds it links to, outside their halo; an unlinked one is on the rim', () => {
  const f = fixture()
  const { scene } = sceneFor(f, all, new FleetReplay(), {
    kanban: [board('agent-flow', 'taxis')], supermemory: [space('lonely', {})],
  })
  const cloud = scene.clusters.get('cloud:taxis')!
  const other = scene.clusters.get('cloud:sophia')!
  const kb = scene.state.agents.get('kanban:agent-flow')!
  const dTaxis = Math.hypot(kb.x - cloud.x, kb.y - cloud.y)
  assert.ok(dTaxis >= cloud.r, 'outside the halo')
  assert.ok(dTaxis < Math.hypot(kb.x - other.x, kb.y - other.y), 'nearer to the cloud that uses it than to the other')
  const lone = scene.state.agents.get('supermemory:lonely')!
  for (const c of scene.clusters.values()) assert.ok(Math.hypot(lone.x - c.x, lone.y - c.y) >= c.r, 'the unlinked one is outside every halo')
})

test('fleet scene: a profile with many sessions shows every session node (no per-profile cap)', () => {
  const f = fixture()
  for (let i = 0; i < 30; i++) f.events['hermes-sophia'].push({ time: 1, type: 'agent_spawn', payload: { name: `sophia · Job ${i}`, parent: 'sophia', startedAt: T0 + i * MIN, task: 'x' } })
  const { scene } = sceneFor(f)
  const sophia = [...scene.state.agents.values()].filter(a => a.sessionId === 'hermes-sophia')
  assert.equal(sophia.length, 31) // Report + 30 jobs
  assert.equal(scene.state.clouds!.find(c => c.label === 'sophia')!.members.length, 31)
})

test('fleet scene: pulses given to the scene reach the canvas state', () => {
  const pulses = [{ id: 'p', edgeId: 'e', kind: 'kanban' as const, color: '#fff', startedAt: NOW }]
  const f = fixture()
  const instances = instancesFromSessionEvents(f.sessions, id => f.events[id] ?? [])
  const graph = buildFleetGraph({ instances, selection: all, now: NOW })
  const replay = new FleetReplay()
  const scene = buildFleetScene({ sessions: f.sessions, stateOf: id => replay.advance(id, f.events[id] ?? []), instances, selection: all, graph, pulses })
  assert.deepEqual(scene.state.pulses, pulses)
})
