import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SimulationEvent } from '@/lib/agent-types'
import { instancesFromSessionEvents, type FleetSelectionView, type SessionLike } from '@/lib/fleet/fleet-model'
import { buildFleetGraph } from '@/lib/fleet/fleet-graph'
import { defaultOptions } from '@/lib/fleet/options-registry'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'
import { ANCHOR_DIM_ALPHA, hoverAlpha, profileColor } from '@/lib/fleet/anchor-mode'
import { buildFleetScene, FleetReplay } from './fleet-scene'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)
const MIN = 60_000
const NOW = T0 + 60 * MIN
const all: FleetSelectionView = { isSelected: () => true }

const session = (profile: string): SessionLike => ({
  id: `hermes-${profile}`, label: profile, status: 'active', startTime: T0, lastActivityTime: NOW,
})

function profileEvents(profile: string, node: string): SimulationEvent[] {
  return [
    { time: 0, type: 'agent_spawn', payload: { name: profile, isMain: true, profile, group: profile, task: `Hermes profile ${profile}` } },
    { time: 0, type: 'agent_spawn', payload: { name: node, parent: profile, startedAt: T0, task: node } },
    { time: 10, type: 'tool_call_start', payload: { agent: node, tool: 'Bash', toolUseId: 'u0', args: 'pnpm test', inputData: { command: 'pnpm test' } } },
    { time: 12, type: 'tool_call_end', payload: { agent: node, tool: 'Bash', toolUseId: 'u0', result: 'ok' } },
  ]
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

function build(layout?: 'cloud' | 'anchor', extra: { palette?: string[]; profileColors?: Record<string, string> } = {}) {
  const sessions = [session('taxis'), session('sophia')]
  const events: Record<string, SimulationEvent[]> = {
    'hermes-taxis': profileEvents('taxis', 'taxis · Plan'),
    'hermes-sophia': profileEvents('sophia', 'sophia · Report'),
  }
  const instances = instancesFromSessionEvents(sessions, id => events[id] ?? [])
  const graph = buildFleetGraph({
    instances, selection: all, now: NOW, options: defaultOptions(),
    kanban: [board('alpha', 'taxis'), board('beta', 'sophia')],
    supermemory: [space('alpha', { taxis: 3 }), space('omh_family', { sophia: 2 })],
  })
  const replay = new FleetReplay()
  const scene = buildFleetScene({
    sessions, stateOf: id => replay.advance(id, events[id] ?? []), instances, selection: all, graph,
    ...(layout ? { layout, now: NOW, ...extra } : {}),
  })
  return { scene, graph }
}

test('R8: the default layout is untouched: no layout option = layout "cloud", clouds are drawn, nodes carry no tint, no relations', () => {
  const plain = build()
  const cloud = build('cloud')
  assert.deepEqual([...plain.scene.state.agents].map(([id, a]) => [id, a.x, a.y]), [...cloud.scene.state.agents].map(([id, a]) => [id, a.x, a.y]))
  assert.ok(plain.scene.state.clouds && plain.scene.state.clouds.length === 2)
  for (const c of plain.scene.state.clouds ?? []) assert.ok(!c.anchor, 'halo cloud')
  for (const a of plain.scene.state.agents.values()) assert.equal(a.tint, undefined)
  assert.equal(plain.scene.state.relations, undefined)
  for (const e of plain.scene.state.edges) assert.equal(e.sourceIds, undefined)
})

test('anchor layout (R7): no halo or grouping: every cloud is data only, each session node is tinted by its profile', () => {
  const { scene } = build('anchor')
  for (const c of scene.state.clouds ?? []) assert.equal(c.anchor, true, `${c.label} is not drawn`)
  const taxis = [...scene.state.agents.values()].find(a => a.name === 'taxis · Plan')!
  const sophia = [...scene.state.agents.values()].find(a => a.name === 'sophia · Report')!
  assert.equal(taxis.tint, profileColor('taxis', defaultOptions().profilePalette))
  assert.equal(sophia.tint, profileColor('sophia', defaultOptions().profilePalette))
})

test('anchor layout (R4): the palette and the per-profile override reach the nodes', () => {
  const { scene } = build('anchor', { palette: ['#010101'], profileColors: { taxis: '#ff00aa' } })
  const byName = (n: string) => [...scene.state.agents.values()].find(a => a.name === n)!
  assert.equal(byName('taxis · Plan').tint, '#ff00aa')
  assert.equal(byName('sophia · Report').tint, '#010101')
})

test('anchor layout (R5): resource nodes keep their fixed colours and kinds', () => {
  const { scene } = build('anchor')
  const kinds = new Set([...scene.state.agents.values()].filter(a => a.resourceKind).map(a => a.resourceKind))
  assert.ok(kinds.has('kanban') && kinds.has('supermemory'))
  for (const a of scene.state.agents.values()) if (a.resourceKind) assert.equal(a.tint, undefined, 'resources are not tinted')
  const colors = new Set(scene.state.edges.filter(e => e.type === 'resource').map(e => e.color))
  assert.ok(colors.has('#ffbb44') && colors.has('#cc88ff'), 'Kanban amber and Supermemory violet')
})

test('anchor layout (R2/R3): a project board and its memory namespace sit closer than unrelated resources; sessions sit beside a resource they use', () => {
  const { scene } = build('anchor')
  const at = (id: string) => scene.state.agents.get(id)!
  const d = (a: string, b: string) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y)
  assert.ok(d('kanban:alpha', 'supermemory:alpha') < d('kanban:alpha', 'supermemory:omh_family'), 'explicit link: same project is closer')
  assert.ok(d('kanban:alpha', 'supermemory:alpha') < d('kanban:alpha', 'kanban:beta'))
  const taxis = [...scene.state.agents.values()].find(a => a.name === 'taxis · Plan')!
  const nearest = [...scene.state.agents.values()].filter(a => a.resourceKind)
    .sort((a, b) => Math.hypot(a.x - taxis.x, a.y - taxis.y) - Math.hypot(b.x - taxis.x, b.y - taxis.y))[0]
  assert.ok(['kanban:alpha', 'supermemory:alpha'].includes(nearest.id), `taxis sits beside one of its own resources (got ${nearest.id})`)
})

test('anchor layout (R6): hovering a resource keeps its sessions and linked resources at 100%, the rest at 80%', () => {
  const { scene } = build('anchor')
  const rel = scene.state.relations!
  const related = rel.get('kanban:alpha')!
  const taxis = [...scene.state.agents.values()].find(a => a.name === 'taxis · Plan')!
  const sophia = [...scene.state.agents.values()].find(a => a.name === 'sophia · Report')!
  assert.ok(related.has(taxis.id), 'the session that used it')
  assert.ok(!related.has(sophia.id), 'a session that did not')
  assert.equal(hoverAlpha(taxis.id, 'kanban:alpha', related), 1)
  assert.equal(hoverAlpha('kanban:alpha', 'kanban:alpha', related), 1)
  assert.equal(hoverAlpha(sophia.id, 'kanban:alpha', related), ANCHOR_DIM_ALPHA)
  assert.equal(hoverAlpha('kanban:beta', 'kanban:alpha', related), ANCHOR_DIM_ALPHA)
})

test('anchor layout: links leave the session nodes that used the resource (no halo to leave from)', () => {
  const { scene } = build('anchor')
  const link = scene.state.edges.find(e => e.to === 'kanban:alpha' && e.fromCloud)!
  const taxis = [...scene.state.agents.values()].find(a => a.name === 'taxis · Plan')!
  assert.deepEqual(link.sourceIds, [taxis.id])
})

test('anchor layout is deterministic: the same input gives the same map', () => {
  const a = build('anchor').scene.state.agents
  const b = build('anchor').scene.state.agents
  assert.deepEqual([...a].map(([id, v]) => [id, v.x, v.y]), [...b].map(([id, v]) => [id, v.x, v.y]))
})

test('anchor layout (R6): a sub-agent is related to its parent node, so hovering one does not dim the other', () => {
  const sessions = [session('taxis')]
  const events: Record<string, SimulationEvent[]> = {
    'hermes-taxis': [
      ...profileEvents('taxis', 'taxis · Plan'),
      { time: 2, type: 'agent_spawn', payload: { name: 'explore', parent: 'taxis · Plan', task: 'look around' } },
    ],
  }
  const instances = instancesFromSessionEvents(sessions, id => events[id] ?? [])
  const graph = buildFleetGraph({
    instances, selection: all, now: NOW, options: defaultOptions(),
    kanban: [board('alpha', 'taxis')], supermemory: [],
  })
  const replay = new FleetReplay()
  const { state } = buildFleetScene({
    sessions, stateOf: id => replay.advance(id, events[id] ?? []), instances, selection: all, graph, layout: 'anchor', now: NOW,
  })
  const children = [...state.agents.values()].filter(a => !a.resourceKind && a.parentId && state.agents.has(a.parentId))
  assert.ok(children.length > 0, "the scene has a sub-agent node with a parent node")
  for (const child of children) {
    assert.ok(state.relations!.get(child.id)!.has(child.parentId!), 'child -> parent')
    assert.ok(state.relations!.get(child.parentId!)!.has(child.id), 'parent -> child')
    assert.equal(hoverAlpha(child.parentId!, child.id, state.relations!.get(child.id)), 1)
  }
})
