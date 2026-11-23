import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildFleetGraph, countByKind, layoutFleetGraph, profileKey, MAX_SESSIONS_PER_PROFILE, MAX_RESOURCES_PER_KIND, type FleetGraph } from './fleet-graph'
import { instancesFromSessionEvents, type SessionEventLike, type SessionLike } from './fleet-model'
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = T0 + 10 * HOUR
const all = { isSelected: () => true }

const live = (profile: string, label: string): SessionLike =>
  ({ id: `hermes-${profile}`, label, status: 'active', startTime: T0 + 9 * HOUR, lastActivityTime: NOW })
const idleSession = (profile: string, label: string): SessionLike =>
  ({ id: `hermes-${profile}`, label, status: 'completed', startTime: T0, lastActivityTime: T0 + 2 * HOUR, idle: true })

const spawn = (name: string, startedAt: number): SessionEventLike => ({ time: 0, type: 'agent_spawn', payload: { name, parent: 'x', startedAt } })
const tool = (agent: string, time: number): SessionEventLike => ({ time, type: 'tool_call_start', payload: { agent, tool: 'Bash' } })

const board = (slug: string, assignees: Array<[string, number]>, running = 0): PublicKanbanBoardNode => ({
  id: `kanban:${slug}`, type: 'kanban-board', slug, name: slug, description: '', archived: false,
  taskCounts: { running, done: 3 }, totalTasks: 3 + running,
  recentEvents: assignees.map(([assignee, at], i) => ({ id: i + 1, taskId: `t${i}`, taskTitle: 'x', assignee, kind: 'claimed', runId: null, at })),
  lastEventAt: assignees.length ? Math.max(...assignees.map(a => a[1])) : null,
} as PublicKanbanBoardNode)

const space = (tag: string, byProfile: Record<string, number>): SupermemoryNamespaceNode => ({
  id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag,
  counts: { store: 2, search: 5, forget: 0 }, total: 7,
  byProfile: Object.fromEntries(Object.entries(byProfile).map(([p, n]) => [p, { store: 0, search: n, forget: 0 }])),
  daily: [], lastEventAt: NOW - MIN,
})

const SESSIONS = [live('taxis', 'Taxis'), live('omh-coder', 'OMH Coder'), idleSession('sophia', 'Sophia')]
const EVENTS: Record<string, SessionEventLike[]> = {
  'hermes-taxis': [spawn('Taxis · Plan', T0 + 9 * HOUR), tool('Taxis · Plan', 30), spawn('Taxis · Review', T0 + 9 * HOUR + MIN)],
  'hermes-omh-coder': [spawn('OMH Coder · Fleet', T0 + 9 * HOUR + 5 * MIN), tool('OMH Coder · Fleet', 60)],
  'hermes-sophia': [
    spawn('Sophia · Report', T0), { time: 3600, type: 'agent_complete', payload: { name: 'Sophia · Report', idle: true } },
  ],
}
const instances = () => instancesFromSessionEvents(SESSIONS, id => EVENTS[id] ?? [])

const KANBAN = [board('agent-flow', [['taxis', NOW - 2 * MIN], ['omh-coder', NOW - 5 * MIN]], 1), board('media', [['sophia', T0]])]
const MEMORY = [space('omh_family', { taxis: 4, 'omh-coder': 2 }), space('webbugt_video_memory', { sophia: 1 })]

test('profileKey ignores case, dashes and spaces; default is Hermes', () => {
  assert.equal(profileKey('omh-coder'), profileKey('OMH Coder'))
  assert.equal(profileKey('default'), profileKey('Hermes'))
  assert.notEqual(profileKey('taxis'), profileKey('sophia'))
})

test('two active profiles: the map has both agent nodes, their sessions, a Kanban and a Supermemory node', () => {
  const g = buildFleetGraph({ instances: instances(), kanban: KANBAN, supermemory: MEMORY, selection: all, now: NOW })
  const profiles = g.nodes.filter(n => n.kind === 'profile')
  assert.deepEqual(profiles.map(p => p.label).sort(), ['omh coder', 'sophia', 'taxis'])
  assert.equal(profiles.find(p => p.label === 'taxis')!.status, 'active')
  assert.equal(profiles.find(p => p.label === 'omh coder')!.status, 'active')
  assert.equal(profiles.find(p => p.label === 'sophia')!.status, 'idle')
  const kinds = countByKind(g)
  assert.equal(kinds.profile, 3)
  assert.equal(kinds.session, 4) // Taxis x2, OMH Coder x1, Sophia x1
  assert.equal(kinds.kanban, 2)
  assert.equal(kinds.supermemory, 2)
  // Every session hangs off its own profile.
  for (const s of g.nodes.filter(n => n.kind === 'session')) {
    assert.ok(g.edges.some(e => e.kind === 'session' && e.to === s.id && e.from === s.profileId))
  }
})

test('resources link to the profiles that use them', () => {
  const g = buildFleetGraph({ instances: instances(), kanban: KANBAN, supermemory: MEMORY, selection: all, now: NOW })
  const links = (kind: string) => g.edges.filter(e => e.kind === kind).map(e => `${e.from}>${e.to}`).sort()
  assert.deepEqual(links('kanban'), [
    'profile:omh coder>kanban:agent-flow', 'profile:sophia>kanban:media', 'profile:taxis>kanban:agent-flow',
  ])
  assert.deepEqual(links('memory'), [
    'profile:omh coder>supermemory:omh_family', 'profile:sophia>supermemory:webbugt_video_memory', 'profile:taxis>supermemory:omh_family',
  ])
  // Active profile + recent use = animated link; the idle profile's board link is not.
  const edge = (id: string) => g.edges.find(e => e.id === id)!
  assert.equal(edge('profile:taxis>kanban:agent-flow').active, true)
  assert.equal(edge('profile:sophia>kanban:media').active, false)
  assert.equal(edge('profile:taxis>supermemory:omh_family').weight, 4)
})

test('resources nobody uses still show as nodes; links to unknown profiles are dropped', () => {
  const g = buildFleetGraph({
    instances: instances(), selection: all, now: NOW,
    kanban: [board('lonely', [['ghost', NOW]])], supermemory: [space('unused', {})],
  })
  assert.equal(countByKind(g).kanban, 1)
  assert.equal(countByKind(g).supermemory, 1)
  assert.equal(g.edges.filter(e => e.kind !== 'session').length, 0)
})

test('deselected items leave the map; a profile with every session deselected disappears', () => {
  const off = new Set(['hermes-sophia::Sophia · Report', 'kanban:media', 'supermemory:omh_family'])
  const g = buildFleetGraph({
    instances: instances(), kanban: KANBAN, supermemory: MEMORY, now: NOW,
    selection: { isSelected: id => !off.has(id) },
  })
  assert.deepEqual(g.nodes.filter(n => n.kind === 'profile').map(n => n.label).sort(), ['omh coder', 'taxis'])
  assert.deepEqual(g.nodes.filter(n => n.kind === 'kanban').map(n => n.id), ['kanban:agent-flow'])
  assert.deepEqual(g.nodes.filter(n => n.kind === 'supermemory').map(n => n.id), ['supermemory:webbugt_video_memory'])
  assert.ok(g.edges.every(e => g.nodes.some(n => n.id === e.from) && g.nodes.some(n => n.id === e.to)), 'no dangling edge')
})

test('a busy profile draws at most MAX_SESSIONS_PER_PROFILE sessions, running first, and counts the rest', () => {
  const sessions = [live('taxis', 'Taxis')]
  const events: SessionEventLike[] = []
  for (let i = 0; i < 12; i++) {
    events.push(spawn(`Taxis · Job ${i}`, T0 + i * MIN))
    if (i !== 11) events.push({ time: 30, type: 'agent_complete', payload: { name: `Taxis · Job ${i}` } })
  }
  const g = buildFleetGraph({
    instances: instancesFromSessionEvents(sessions, () => events), selection: all, now: NOW,
  })
  const drawn = g.nodes.filter(n => n.kind === 'session')
  assert.equal(drawn.length, MAX_SESSIONS_PER_PROFILE)
  assert.equal(g.nodes.find(n => n.kind === 'profile')!.hiddenSessions, 4)
  assert.ok(drawn.some(n => n.label === 'Job 11'), 'the running session is always drawn')
})

// ─── Layout ─────────────────────────────────────────────────────────────────

function assertLaidOut(g: FleetGraph, width: number, height: number, insets: { insetTop: number; insetBottom: number; insetRight?: number }) {
  const layout = layoutFleetGraph(g, { width, height, ...insets })
  assert.equal(layout.nodes.length, g.nodes.length, 'every node is placed')
  const right = width - (insets.insetRight ?? 0)
  for (const n of layout.nodes) {
    assert.ok(n.x - n.radius >= 0 && n.x + n.radius <= right, `${n.id} inside horizontally (${n.x.toFixed(0)}±${n.radius.toFixed(0)} of ${right})`)
    assert.ok(n.y - n.radius >= insets.insetTop && n.y + n.radius <= height - insets.insetBottom, `${n.id} inside vertically (${n.y.toFixed(0)}±${n.radius.toFixed(0)})`)
  }
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i]
      const b = layout.nodes[j]
      assert.ok(Math.hypot(a.x - b.x, a.y - b.y) >= a.radius + b.radius - 0.5, `${a.id} and ${b.id} do not overlap`)
    }
  }
  return layout
}

test('layout: desktop and phone widths place every node inside the free area, none overlapping', () => {
  const g = buildFleetGraph({ instances: instances(), kanban: KANBAN, supermemory: MEMORY, selection: all, now: NOW })
  const desktop = assertLaidOut(g, 1280, 800, { insetTop: 48, insetBottom: 320 })
  const phone = assertLaidOut(g, 390, 844, { insetTop: 96, insetBottom: 340 })
  // Wide: boards left of the profiles, namespaces right of them. Narrow: boards above, namespaces below.
  const at = (l: typeof desktop, kind: string) => l.nodes.filter(n => n.kind === kind)
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  assert.ok(mean(at(desktop, 'kanban').map(n => n.x)) < mean(at(desktop, 'profile').map(n => n.x)))
  assert.ok(mean(at(desktop, 'supermemory').map(n => n.x)) > mean(at(desktop, 'profile').map(n => n.x)))
  assert.ok(mean(at(phone, 'kanban').map(n => n.y)) < mean(at(phone, 'profile').map(n => n.y)))
  assert.ok(mean(at(phone, 'supermemory').map(n => n.y)) > mean(at(phone, 'profile').map(n => n.y)))
})

test('layout: eleven profiles with sessions still fit and stay apart; empty graph gives no nodes', () => {
  const sessions: SessionLike[] = []
  const events: Record<string, SessionEventLike[]> = {}
  for (let p = 0; p < 11; p++) {
    sessions.push(live(`p${p}`, `P${p}`))
    events[`hermes-p${p}`] = [1, 2, 3, 4].map(k => spawn(`P${p} · S${k}`, T0 + k * MIN))
  }
  const g = buildFleetGraph({
    instances: instancesFromSessionEvents(sessions, id => events[id] ?? []),
    kanban: KANBAN, supermemory: MEMORY, selection: all, now: NOW,
  })
  assertLaidOut(g, 1440, 900, { insetTop: 48, insetBottom: 360 })
  assert.deepEqual(layoutFleetGraph({ nodes: [], edges: [] }, { width: 800, height: 600 }).nodes, [])
})

test('archived and never-used boards stay off the map; resources are capped, linked ones first', () => {
  const empty = (slug: string) => board(slug, [])
  empty('x').totalTasks = 0
  const archived = { ...board('old', [['taxis', NOW]]), archived: true } as PublicKanbanBoardNode
  const unused = Array.from({ length: 12 }, (_, i) => ({ ...board(`b${i}`, []), totalTasks: 5 }) as PublicKanbanBoardNode)
  const emptyBoard = { ...board('blank', []), totalTasks: 0 } as PublicKanbanBoardNode
  const g = buildFleetGraph({
    instances: instances(), selection: all, now: NOW,
    kanban: [archived, emptyBoard, ...unused, board('agent-flow', [['taxis', NOW]])],
  })
  const ids = g.nodes.filter(n => n.kind === 'kanban').map(n => n.id)
  assert.equal(ids.length, MAX_RESOURCES_PER_KIND)
  assert.ok(ids.includes('kanban:agent-flow'), 'the linked board survives the cap')
  assert.ok(!ids.includes('kanban:old') && !ids.includes('kanban:blank'))
  assert.ok(g.edges.every(e => g.nodes.some(n => n.id === e.to)), 'no edge to a dropped node')
})

test('layout: phone width with a full set of resources keeps all in two rows, inside the area', () => {
  const unused = Array.from({ length: 8 }, (_, i) => ({ ...board(`b${i}`, [['taxis', NOW]]), totalTasks: 5 }) as PublicKanbanBoardNode)
  const spaces = Array.from({ length: 5 }, (_, i) => space(`ns${i}`, { taxis: 1 }))
  const g = buildFleetGraph({ instances: instances(), kanban: unused, supermemory: spaces, selection: all, now: NOW })
  assertLaidOut(g, 390, 844, { insetTop: 96, insetBottom: 340 })
})
