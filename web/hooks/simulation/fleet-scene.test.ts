import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { NODE, type SimulationEvent } from '@/lib/agent-types'
import { cloudGeometry } from '@/lib/fleet/fleet-cloud-geometry'
import { instancesFromSessionEvents, splitInstanceId, type FleetSelectionView, type SessionLike } from '@/lib/fleet/fleet-model'
import { buildFleetGraph } from '@/lib/fleet/fleet-graph'
import { defaultOptions } from '@/lib/fleet/options-registry'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'
import { anonymizeToolInput, createAnonymizePolicy, isAnonymized } from '@/lib/content-privacy'
import { BLOB_GAP } from '@/lib/fleet/fleet-placement'
import { newFleetPresenceTracker, withGhosts, ghostIdsOf } from './fleet-presence-scene'
import { positionsOf, tweenedFrame } from './fleet-tween-scene'
import { TWEEN_MS, retarget } from '@/lib/fleet/fleet-tween'
import { buildFleetScene, CLOUD_GAP_X, CLOUD_GAP_Y, FleetReplay, openTargetOf, packRadius, unitReach, SATELLITE_PACK_SHARE } from './fleet-scene'
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

test('fleet scene: a Kanban block carries its life (last use, kanban linger and fade, pin) and its link the kanban window, for the draw loop', () => {
  const f = fixture()
  const instances = instancesFromSessionEvents(f.sessions, id => f.events[id] ?? [])
  const options = defaultOptions()
  options.lingerSeconds.kanban = 120
  options.fadeSeconds = 30
  const build = (pins: ReadonlySet<string>) => {
    const graph = buildFleetGraph({ instances, kanban: [board('agent-flow', 'taxis')], selection: all, now: NOW, options, pins })
    return buildFleetScene({ sessions: f.sessions, stateOf: id => new FleetReplay().advance(id, f.events[id] ?? []), instances, selection: all, graph }).state
  }
  const state = build(new Set())
  const node = state.agents.get('kanban:agent-flow')!
  assert.deepEqual(node.block, { lastUsedAt: NOW - MIN, lingerMs: 120_000, fadeMs: 30_000, pinned: false })
  assert.equal(node.name, 'agent-flow')
  assert.equal(node.task, '1 running · 1 done')
  const link = state.edges.find(e => e.to === 'kanban:agent-flow')!
  assert.equal(link.lingerMs, 120_000)
  assert.equal(link.fadeMs, 30_000)
  assert.equal(build(new Set(['kanban:agent-flow'])).agents.get('kanban:agent-flow')!.block!.pinned, true)
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

test('fleet scene: sessions of a cloud sit at least BLOB_GAP apart (no overlap) and clouds keep CLOUD_GAP between their halos', () => {
  const sessions: SessionLike[] = []
  const events: Record<string, SimulationEvent[]> = {}
  const counts: Array<[string, number]> = [['alpha', 8], ['beta', 5], ['gamma', 3], ['delta', 1], ['eps', 13]]
  for (const [p, n] of counts) {
    sessions.push(session(p))
    const ev: SimulationEvent[] = [{ time: 0, type: 'agent_spawn', payload: { name: p, isMain: true, profile: p, group: p, task: p } }]
    for (let k = 0; k < n; k++) {
      const node = `${p} · S${k}`
      ev.push({ time: 0, type: 'agent_spawn', payload: { name: node, parent: p, startedAt: T0 + k * 1000, task: node } })
      ev.push({ time: 5, type: 'tool_call_start', payload: { agent: node, tool: 'Read', toolUseId: `u${k}`, args: 'a.ts', inputData: { path: 'a.ts' } } })
      ev.push({ time: 6, type: 'tool_call_end', payload: { agent: node, tool: 'Read', toolUseId: `u${k}`, result: 'ok' } })
    }
    events[`hermes-${p}`] = ev
  }
  const { scene } = sceneFor({ sessions, events })
  const clouds = scene.state.clouds!
  assert.equal(clouds.length, 5)
  for (const c of clouds) {
    for (let i = 0; i < c.members.length; i++) {
      for (let j = i + 1; j < c.members.length; j++) {
        const a = scene.state.agents.get(c.members[i].id)!
        const b = scene.state.agents.get(c.members[j].id)!
        // The packing counts AGENT_PAD plus SATELLITE_PACK_SHARE of the reach (member.pad is the full reach).
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        const gap = d - packRadius(c.members[i].pad) - packRadius(c.members[j].pad)
        assert.ok(gap >= BLOB_GAP - 1e-6, `${c.label}: nodes ${i}/${j} packing gap ${gap}`)
        // No overlap at normal zoom: the node discs themselves (and a margin) never touch.
        assert.ok(d >= 2 * NODE.radiusMain + BLOB_GAP, `${c.label}: nodes ${i}/${j} overlap (${d})`)
      }
    }
    // The halo (as the canvas computes it from the drawn positions) still covers every node with its whole reach.
    const g = cloudGeometry(c, new Map(c.members.map(m => [m.id, scene.state.agents.get(m.id)!])))!
    for (const m of c.members) {
      const a = scene.state.agents.get(m.id)!
      assert.ok(Math.hypot(a.x - g.x, a.y - g.y) + m.pad <= g.r + 1e-6, `${c.label}: halo covers ${m.id}`)
    }
    const stored = scene.clusters.get(c.id)!
    assert.ok(Math.abs(stored.r - g.r) < 1e-6, `${c.label}: scene halo ${stored.r} = canvas halo ${g.r}`)
  }
  // Halos of different clouds never overlap.
  const cl = [...scene.clusters.values()]
  for (let i = 0; i < cl.length; i++) {
    for (let j = i + 1; j < cl.length; j++) {
      const d = Math.hypot(cl[i].x - cl[j].x, cl[i].y - cl[j].y)
      assert.ok(d >= cl[i].r + cl[j].r, `halos of ${cl[i].identity} and ${cl[j].identity} overlap`)
    }
  }
  assert.ok(CLOUD_GAP_X <= 48 && CLOUD_GAP_Y <= 44, 'grid gaps between halos')
  // Row neighbours (3 columns: alpha, beta, delta): the cells are as wide as the widest halo of their column, so the gap
  // between two halos of one row is at least CLOUD_GAP_X.
  const byId = new Map([...scene.clusters.values()].map(c => [c.identity, c]))
  const a = byId.get('alpha')!
  const b = byId.get('beta')!
  assert.ok(b.x - a.x - a.r - b.r >= CLOUD_GAP_X - 1e-6, `alpha-beta halo gap ${b.x - a.x - a.r - b.r}`)
})

test('fleet scene: packing radius = AGENT_PAD + SATELLITE_PACK_SHARE of the reach beyond it (pure, monotone, never above the reach)', () => {
  assert.ok(SATELLITE_PACK_SHARE > 0 && SATELLITE_PACK_SHARE < 1, 'a share of the reach, not none and not all')
  assert.equal(packRadius(70), 70, 'a node with no satellites packs on AGENT_PAD')
  assert.equal(packRadius(10), 70, 'never below AGENT_PAD')
  const full = 221.9
  assert.ok(Math.abs(packRadius(full) - (70 + SATELLITE_PACK_SHARE * (full - 70))) < 1e-9)
  for (const r of [70, 100, 130, 222, 400]) assert.ok(packRadius(r) <= r + 1e-9)
  for (let r = 70; r < 400; r += 10) assert.ok(packRadius(r + 10) >= packRadius(r), 'monotone in the reach')
})

test('fleet scene: a node with one tool card packs on the reduced radius while the halo keeps the full reach', () => {
  const { scene } = sceneFor({
    sessions: [session('alpha')],
    events: {
      'hermes-alpha': [
        { time: 0, type: 'agent_spawn', payload: { name: 'alpha', isMain: true, profile: 'alpha', group: 'alpha', task: 'alpha' } },
        ...[0, 1, 2].flatMap(k => [
          { time: 0, type: 'agent_spawn' as const, payload: { name: `alpha · S${k}`, parent: 'alpha', startedAt: T0 + k * 1000, task: 'x' } },
          { time: 5, type: 'tool_call_start' as const, payload: { agent: `alpha · S${k}`, tool: 'Read', toolUseId: `u${k}`, args: 'a.ts', inputData: { path: 'a.ts' } } },
          { time: 6, type: 'tool_call_end' as const, payload: { agent: `alpha · S${k}`, tool: 'Read', toolUseId: `u${k}`, result: 'ok' } },
        ]),
      ],
    },
  })
  const cloud = scene.state.clouds![0]
  assert.equal(cloud.members.length, 3)
  const reach = cloud.members[0].pad
  assert.ok(reach > 200 && reach < 240, `full reach of node + card ~222 (got ${reach})`)
  // Neighbours sit closer than twice the full reach (the old packing), at the reduced packing radius + BLOB_GAP.
  const ids = cloud.members.map(m => scene.state.agents.get(m.id)!)
  const dists = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => Math.hypot(ids[i].x - ids[j].x, ids[i].y - ids[j].y))
  const min = Math.min(...dists)
  assert.ok(min < 2 * reach - 100, `nodes at ${min}, old packing needed >= ${2 * reach}`)
  assert.ok(Math.abs(min - (2 * packRadius(reach) + BLOB_GAP)) < 1e-6, `closest pair touches at the packing radius (${min})`)
  // Zoomed in nothing is cut: every tool card still lies inside the halo.
  const halo = scene.clusters.get(cloud.id)!
  for (const t of scene.state.toolCalls.values()) assert.ok(Math.hypot(t.x - halo.x, t.y - halo.y) <= halo.r, 'card inside the halo')
  // A tool card never lies on another node's disc at normal zoom.
  for (const t of scene.state.toolCalls.values()) {
    for (const a of ids) {
      if (a.id === t.agentId) continue
      const dx = Math.max(Math.abs(a.x - t.x) - 170 / 2, 0)
      const dy = Math.max(Math.abs(a.y - t.y) - 36 / 2, 0)
      assert.ok(Math.hypot(dx, dy) >= NODE.radiusSub, `card ${t.id} on node ${a.id}`)
    }
  }
})

test('fleet scene: unitReach is unchanged by the packing share (what the halo must cover)', () => {
  const agent = { x: 0, y: 0, messageBubbles: [] } as unknown as Parameters<typeof unitReach>[0]
  assert.equal(unitReach(agent, []), 70)
  const tc = { x: 135, y: 0 } as unknown as Parameters<typeof unitReach>[1][number]
  assert.ok(Math.abs(unitReach(agent, [tc]) - (135 + Math.hypot(170, 36) / 2)) < 1e-9)
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

// ─── Weighted resource placement (by session node) ───────────────────────────

/** Taxis with a handful of session nodes, a board that Taxis uses, and a scene built from the given links. */
function weightedFixture(sessionsOf: (taxisNodes: string[]) => Array<{ sessionId: string; weight: number }>, moved?: Map<string, { x: number; y: number }>) {
  const f = fixture()
  for (let i = 0; i < 7; i++) f.events['hermes-taxis'].push({ time: 1, type: 'agent_spawn', payload: { name: `taxis · Job ${i}`, parent: 'taxis', startedAt: T0 + i * MIN, task: 'x' } })
  const instances = instancesFromSessionEvents(f.sessions, id => f.events[id] ?? [])
  const graph = buildFleetGraph({ instances, kanban: [board('agent-flow', 'taxis')], selection: all, now: NOW })
  const taxisNodes = graph.clouds.find(c => c.id === 'cloud:taxis')!.sessionIds
  const edge = graph.edges.find(e => e.to === 'kanban:agent-flow')!
  edge.sessions = sessionsOf(taxisNodes)
  const replay = new FleetReplay()
  const scene = buildFleetScene({ sessions: f.sessions, stateOf: id => replay.advance(id, f.events[id] ?? []), instances, selection: all, graph, moved })
  return { scene, taxisNodes }
}

test('fleet scene: a resource is placed towards the session nodes that use it, so it moves when the weights move', () => {
  const probe = weightedFixture(ids => [{ sessionId: ids[0], weight: 1 }]).scene
  const centre = probe.clusters.get('cloud:taxis')!
  const nodes = [...probe.state.agents.values()].filter(a => a.sessionId === 'hermes-taxis')
  assert.ok(nodes.length >= 8)
  // The two session nodes farthest apart in the cloud (by the direction they sit in from the centre).
  const far = [...nodes].sort((a, b) => Math.hypot(b.x - centre.x, b.y - centre.y) - Math.hypot(a.x - centre.x, a.y - centre.y))
  const a = far[0]
  const dot = (n: { x: number; y: number }) => (n.x - centre.x) * (a.x - centre.x) + (n.y - centre.y) * (a.y - centre.y)
  const b = [...far].sort((p, q) => dot(p) - dot(q))[0] // the node on the opposite side of the cloud
  const toward = (scene: typeof probe, node: typeof a) => {
    const kb = scene.state.agents.get('kanban:agent-flow')!
    return (kb.x - centre.x) * (node.x - centre.x) + (kb.y - centre.y) * (node.y - centre.y)
  }
  const usedA = weightedFixture(() => [{ sessionId: a.id, weight: 9 }, { sessionId: b.id, weight: 1 }]).scene
  const usedB = weightedFixture(() => [{ sessionId: a.id, weight: 1 }, { sessionId: b.id, weight: 9 }]).scene
  const kbA = usedA.state.agents.get('kanban:agent-flow')!
  const kbB = usedB.state.agents.get('kanban:agent-flow')!
  assert.ok(Math.hypot(kbA.x - kbB.x, kbA.y - kbB.y) > 20, `the resource moved with the weights (${kbA.x.toFixed(0)},${kbA.y.toFixed(0)} vs ${kbB.x.toFixed(0)},${kbB.y.toFixed(0)})`)
  assert.ok(toward(usedA, a) > toward(usedA, b), 'mostly used from a: sits on a\'s side of the cloud')
  assert.ok(toward(usedB, b) > toward(usedB, a), 'mostly used from b: sits on b\'s side')
  for (const s of [usedA, usedB]) {
    const kb = s.state.agents.get('kanban:agent-flow')!
    assert.ok(Math.hypot(kb.x - centre.x, kb.y - centre.y) >= centre.r, 'still outside the halo')
  }
})

test('fleet scene: the scene reports where each resource belongs; the drawn position is that target; a dropped node keeps its place', () => {
  const { scene } = weightedFixture(ids => [{ sessionId: ids[0], weight: 1 }])
  const kb = scene.state.agents.get('kanban:agent-flow')!
  assert.deepEqual([...scene.resourceTargets.keys()], ['kanban:agent-flow'])
  assert.deepEqual(scene.resourceTargets.get('kanban:agent-flow'), { x: kb.x, y: kb.y })
  assert.ok(![...scene.resourceTargets.keys()].some(id => scene.sessionOfAgent.has(id)), 'session nodes are not resources')
  const dropped = weightedFixture(ids => [{ sessionId: ids[0], weight: 1 }], new Map([['kanban:agent-flow', { x: 1234, y: -567 }]])).scene
  assert.deepEqual(dropped.resourceTargets.get('kanban:agent-flow'), { x: 1234, y: -567 }, 'a dragged resource is its own target: nothing glides it away')
  assert.deepEqual([dropped.state.agents.get('kanban:agent-flow')!.x, dropped.state.agents.get('kanban:agent-flow')!.y], [1234, -567])
})

test('fleet scene: every link event names a session node that is on the map (a pulse has somewhere to leave from)', () => {
  const f = fixture()
  const instances = instancesFromSessionEvents(f.sessions, id => f.events[id] ?? [])
  const graph = buildFleetGraph({ instances, kanban: [board('agent-flow', 'taxis')], supermemory: [{ ...space('omh_family', { taxis: 2 }), recent: [{ at: NOW - MIN, profile: 'taxis', action: 'search' }, { at: NOW - 2 * MIN, profile: 'taxis', action: 'store' }] }], selection: all, now: NOW })
  const replay = new FleetReplay()
  const scene = buildFleetScene({ sessions: f.sessions, stateOf: id => replay.advance(id, f.events[id] ?? []), instances, selection: all, graph })
  const events = graph.edges.flatMap(e => e.events)
  assert.ok(events.length >= 3)
  for (const ev of events) assert.ok(scene.state.agents.has(ev.sessionId!), `${ev.key} leaves from ${ev.sessionId}, a node of the scene`)
})

// ─── Position tween on a rebuilt scene (F3b) ────────────────────────────────

function threeProfiles(names: string[]) {
  const sessions = names.map(n => session(n))
  const events: Record<string, SimulationEvent[]> = {}
  for (const n of names) events[`hermes-${n}`] = profileEvents(n, `${n} · Node`, [{ tool: 'Read', hermesTool: 'read_file', input: { path: `/x/${n}.md` } }], false)
  return { sessions, events }
}

test('position tween: a cloud in the middle of the grid leaves, the clouds after it shift in the scene, and glide to the new place instead of jumping', () => {
  const T = 9_000_000
  // 4 clouds on a 2 x 2 grid in name order: alpha beta / gamma delta. beta leaves: gamma and delta move.
  const before = sceneFor(threeProfiles(['alpha', 'beta', 'gamma', 'delta'])).scene
  const afterEvents = threeProfiles(['alpha', 'gamma', 'delta'])
  const after = sceneFor(afterEvents).scene
  const tracker = newFleetPresenceTracker()
  const live1 = withGhosts(before.state, tracker, T - 5000, before.clusters)
  const live2 = withGhosts(after.state, tracker, T, after.clusters)

  const id = (n: string) => `hermes-${n}::${n} · Node`
  const moved = ['gamma', 'delta'].filter(n => {
    const a = before.state.agents.get(id(n))!
    const b = after.state.agents.get(id(n))!
    return Math.hypot(a.x - b.x, a.y - b.y) > 1
  })
  assert.ok(moved.length >= 1, 'the scene itself moves the clouds that stay (this is the snap the tween removes)')

  const legs = retarget(null, positionsOf(live1), positionsOf(live2), T)
  for (const n of moved) assert.ok(legs.has(id(n)), `${n} gets a leg`)
  // First drawn frame = where it was; last = the scene's place; in between never outside the box of both.
  for (const n of moved) {
    const a = before.state.agents.get(id(n))!
    const b = after.state.agents.get(id(n))!
    const f0 = tweenedFrame(live2, legs, T).frame.agents.get(id(n))!
    assert.deepEqual([f0.x, f0.y], [a.x, a.y])
    const fm = tweenedFrame(live2, legs, T + TWEEN_MS / 2).frame.agents.get(id(n))!
    assert.ok(fm.x >= Math.min(a.x, b.x) - 1e-6 && fm.x <= Math.max(a.x, b.x) + 1e-6)
    assert.ok(fm.y >= Math.min(a.y, b.y) - 1e-6 && fm.y <= Math.max(a.y, b.y) + 1e-6)
    assert.ok(Math.hypot(fm.x - a.x, fm.y - a.y) > 0.1, 'half way it is on its way')
    const f1 = tweenedFrame(live2, legs, T + TWEEN_MS)
    assert.deepEqual([f1.frame.agents.get(id(n))!.x, f1.frame.agents.get(id(n))!.y], [b.x, b.y])
    assert.equal(f1.settled, true)
  }
  // Its satellites move with it (the offset the scene gave them is kept).
  const sat = [...live2.toolCalls.values()].find(tc => tc.agentId === id('gamma'))!
  const own = live2.agents.get(id('gamma'))!
  const mid = tweenedFrame(live2, legs, T + 100).frame
  const midSat = mid.toolCalls.get(sat.id)!
  const midOwn = mid.agents.get(id('gamma'))!
  assert.ok(Math.abs((midSat.x - midOwn.x) - (sat.x - own.x)) < 1e-9)
})

test('position tween: a session of a multi-session cloud leaves: the others glide, the ghost keeps its cloud and follows its centre', () => {
  const T = 9_000_000
  const base = threeProfiles(['alpha', 'beta'])
  // beta gets a second session node (its own session id, same profile name).
  base.sessions.push(session('beta', { id: 'hermes-beta-2' }))
  base.events['hermes-beta-2'] = profileEvents('beta', 'beta · Two', [{ tool: 'Read', hermesTool: 'read_file', input: { path: '/x/two.md' } }], false)
  const before = sceneFor(base).scene
  const smaller = { sessions: base.sessions.filter(s => s.id !== 'hermes-beta-2'), events: base.events }
  const after = sceneFor(smaller).scene
  const tracker = newFleetPresenceTracker()
  withGhosts(before.state, tracker, T - 5000, before.clusters)
  const live = withGhosts(after.state, tracker, T, after.clusters)

  const gone = 'hermes-beta-2::beta · Two'
  assert.ok(live.agents.has(gone), 'its ghost is in the frame')
  assert.ok(live.clouds!.find(c => c.id.includes('beta'))!.members.some(m => m.id === gone), 'and stays a member of its cloud')
  const cb = before.clusters.get([...before.clusters.keys()].find(k => k.includes('beta'))!)!
  const ca = after.clusters.get([...after.clusters.keys()].find(k => k.includes('beta'))!)!
  const ghost = live.agents.get(gone)!
  const was = before.state.agents.get(gone)!
  assert.ok(Math.abs(ghost.x - (was.x + ca.x - cb.x)) < 1e-9 && Math.abs(ghost.y - (was.y + ca.y - cb.y)) < 1e-9, 'old place plus the cloud centre delta')
  assert.deepEqual(ghostIdsOf(live), new Set([gone]))
})
