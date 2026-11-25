import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildFleetGraph, countByKind, profileKey } from './fleet-graph'
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
  lastByProfile: Object.fromEntries(Object.keys(byProfile).map((p, i) => [p, NOW - (i + 1) * MIN])),
  recent: Object.keys(byProfile).flatMap((p, i) => Array.from({ length: byProfile[p] }, (_, k) => ({ at: NOW - (i + 1) * MIN - k * 1000, profile: p, action: 'search' as const }))),
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

const graph = (over: Partial<Parameters<typeof buildFleetGraph>[0]> = {}) =>
  buildFleetGraph({ instances: instances(), kanban: KANBAN, supermemory: MEMORY, selection: all, now: NOW, ...over })

test('agent clouds: one cloud per profile, one node per session, no hub and no session-to-session links', () => {
  const g = graph()
  assert.deepEqual(g.clouds.map(c => c.profile).sort(), ['omh coder', 'sophia', 'taxis'])
  const kinds = countByKind(g)
  assert.equal(kinds.cloud, 3)
  assert.equal(kinds.session, 4) // Taxis x2, OMH Coder x1, Sophia x1
  assert.equal(kinds.kanban, 2)
  assert.equal(kinds.supermemory, 2)
  assert.ok(!g.nodes.some(n => (n.kind as string) === 'profile'), 'there is no profile hub node')
  const taxis = g.clouds.find(c => c.profile === 'taxis')!
  assert.equal(taxis.sessionIds.length, 2)
  assert.equal(taxis.status, 'active')
  assert.equal(g.clouds.find(c => c.profile === 'sophia')!.status, 'idle')
  for (const id of taxis.sessionIds) assert.equal(g.nodes.find(n => n.id === id)!.cloudId, taxis.id)
  // Every link goes from a cloud to a resource; none joins two sessions.
  assert.ok(g.edges.every(e => g.clouds.some(c => c.id === e.from) && g.nodes.some(n => n.id === e.to && n.kind !== 'session')))
})

test('resources link to the clouds that use them; every edge stores lastUsedAt and a weight', () => {
  const g = graph()
  const links = (kind: string) => g.edges.filter(e => e.kind === kind).map(e => `${e.from}>${e.to}`).sort()
  assert.deepEqual(links('kanban'), ['cloud:omh coder>kanban:agent-flow', 'cloud:sophia>kanban:media', 'cloud:taxis>kanban:agent-flow'])
  assert.deepEqual(links('memory'), [
    'cloud:omh coder>supermemory:omh_family', 'cloud:sophia>supermemory:webbugt_video_memory', 'cloud:taxis>supermemory:omh_family',
  ])
  const edge = (id: string) => g.edges.find(e => e.id === id)!
  assert.equal(edge('cloud:taxis>kanban:agent-flow').lastUsedAt, NOW - 2 * MIN)
  assert.equal(edge('cloud:omh coder>kanban:agent-flow').lastUsedAt, NOW - 5 * MIN)
  assert.equal(edge('cloud:sophia>kanban:media').lastUsedAt, T0, 'an old link keeps its old time (it is not "active", it is just old)')
  assert.equal(edge('cloud:taxis>supermemory:omh_family').weight, 4, 'weight = event count')
  assert.equal(edge('cloud:taxis>supermemory:omh_family').lastUsedAt, NOW - MIN)
  assert.ok(g.edges.every(e => Number.isFinite(e.lastUsedAt) && e.events.length > 0))
  // Links no longer depend on running status: the idle profile has links too.
  assert.ok(g.edges.some(e => e.from === 'cloud:sophia'))
})

test('edge events carry kind and label, newest first, with unique keys (what a pulse is made of)', () => {
  const g = graph()
  const k = g.edges.find(e => e.id === 'cloud:taxis>kanban:agent-flow')!
  assert.deepEqual(k.events.map(e => [e.kind, e.label]), [['kanban', 'claimed']])
  const m = g.edges.find(e => e.id === 'cloud:taxis>supermemory:omh_family')!
  assert.ok(m.events.every(e => e.kind === 'memory' && e.label === 'search'))
  const ats = m.events.map(e => e.at)
  assert.deepEqual(ats, [...ats].sort((a, b) => b - a))
  const keys = g.edges.flatMap(e => e.events.map(ev => ev.key))
  assert.equal(new Set(keys).size, keys.length)
})

test('resources nobody uses still show as nodes; links to unknown profiles are dropped', () => {
  const g = buildFleetGraph({
    instances: instances(), selection: all, now: NOW,
    kanban: [board('lonely', [['ghost', NOW]])], supermemory: [space('unused', {})],
  })
  assert.equal(countByKind(g).kanban, 1)
  assert.equal(countByKind(g).supermemory, 1)
  assert.equal(g.edges.length, 0)
})

test('deselected items leave the map; a profile with every session deselected disappears', () => {
  const off = new Set(['hermes-sophia::Sophia · Report', 'kanban:media', 'supermemory:omh_family'])
  const g = graph({ selection: { isSelected: id => !off.has(id) } })
  assert.deepEqual(g.clouds.map(c => c.profile).sort(), ['omh coder', 'taxis'])
  assert.deepEqual(g.nodes.filter(n => n.kind === 'kanban').map(n => n.id), ['kanban:agent-flow'])
  assert.deepEqual(g.nodes.filter(n => n.kind === 'supermemory').map(n => n.id), ['supermemory:webbugt_video_memory'])
  assert.ok(g.edges.every(e => g.clouds.some(c => c.id === e.from) && g.nodes.some(n => n.id === e.to)), 'no dangling edge')
})

test('uncapped sessions: a profile with many sessions shows every one, running first', () => {
  const sessions = [live('taxis', 'Taxis')]
  const events: SessionEventLike[] = []
  const N = 40
  for (let i = 0; i < N; i++) {
    events.push(spawn(`Taxis · Job ${i}`, T0 + i * MIN))
    if (i !== N - 1) events.push({ time: 30, type: 'agent_complete', payload: { name: `Taxis · Job ${i}` } })
  }
  const g = buildFleetGraph({ instances: instancesFromSessionEvents(sessions, () => events), selection: all, now: NOW })
  const drawn = g.nodes.filter(n => n.kind === 'session')
  assert.equal(drawn.length, N, 'no per-profile session cap')
  assert.equal(g.clouds[0].sessionIds.length, N)
  assert.equal(drawn[0].label, `Job ${N - 1}`, 'the running session comes first')
  assert.equal(new Set(drawn.map(n => n.id)).size, N)
})

test('uncapped resources: many boards and namespaces are all kept; archived and never-used boards stay off', () => {
  const archived = { ...board('old', [['taxis', NOW]]), archived: true } as PublicKanbanBoardNode
  const blank = { ...board('blank', []), totalTasks: 0 } as PublicKanbanBoardNode
  const boards = Array.from({ length: 30 }, (_, i) => ({ ...board(`b${i}`, i % 2 ? [['taxis', NOW - i * MIN]] : []), totalTasks: 5 }) as PublicKanbanBoardNode)
  const spaces = Array.from({ length: 25 }, (_, i) => space(`ns${i}`, i % 2 ? { taxis: 1 } : {}))
  const g = buildFleetGraph({ instances: instances(), selection: all, now: NOW, kanban: [archived, blank, ...boards], supermemory: spaces })
  const ids = g.nodes.filter(n => n.kind === 'kanban').map(n => n.id)
  assert.equal(ids.length, 30, 'no resource cap')
  assert.ok(!ids.includes('kanban:old') && !ids.includes('kanban:blank'))
  assert.equal(g.nodes.filter(n => n.kind === 'supermemory').length, 25)
  assert.ok(g.edges.every(e => g.nodes.some(n => n.id === e.to)), 'no edge to a missing node')
})

test('graph is deterministic: same input, same graph', () => {
  assert.deepEqual(graph(), graph())
})
