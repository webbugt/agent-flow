import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  ACTIVITY_WINDOWS, DEFAULT_ACTIVITY_WINDOW, FLEET_ACTIVITY_FILTER_KEY, applyActivityFilter, hiddenByActivity, inWindow,
  instanceLastActivity, loadActivityWindow, parseActivityWindow, sameIds, saveActivityWindow, summarizeHidden, withActivityFilter,
  type ActivityWindowId,
} from './fleet-activity-filter'
import { buildFleetGraph } from './fleet-graph'
import { countsAsActivity, instancesFromSessionEvents, type FleetInstance, type SessionEventLike, type SessionLike } from './fleet-model'
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0)
const MIN = 60_000

// Three timestamps: 2 min ago (in every window), 20 min ago (30 min and 2 h), 90 min ago (2 h only).
const T_RECENT = NOW - 2 * MIN
const T_MID = NOW - 20 * MIN
const T_OLD = NOW - 90 * MIN

const inst = (id: string, identity: string, last: number, over: Partial<FleetInstance> = {}): FleetInstance => ({
  id, identity, runtime: 'claude', startTime: last - 10 * MIN, endTime: undefined, status: 'active', markers: [],
  lastEventAt: last, ...over,
})
const board = (slug: string, at: number | null): PublicKanbanBoardNode => ({
  id: `kanban:${slug}`, type: 'kanban-board', slug, name: slug, description: '', archived: false,
  taskCounts: { running: 0, done: 2 }, totalTasks: 2,
  recentEvents: at === null ? [] : [{ id: 1, taskId: 't', taskTitle: 'x', assignee: 'recent', kind: 'claimed', runId: null, at }],
  lastEventAt: at,
} as PublicKanbanBoardNode)
const space = (tag: string, at: number | null): SupermemoryNamespaceNode => ({
  id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag,
  counts: { store: 1, search: 0, forget: 0 }, total: 1,
  byProfile: at === null ? {} : { recent: { store: 1, search: 0, forget: 0 } },
  daily: [], lastEventAt: at, lastByProfile: at === null ? {} : { recent: at },
  recent: at === null ? [] : [{ at, profile: 'recent', action: 'store' as const }],
})

const INSTANCES = [
  inst('recent-1', 'recent', T_RECENT),
  inst('mid-1', 'mid', T_MID),
  inst('old-1', 'old', T_OLD),
  // A profile with two nodes, one fresh and one old: the profile stays, the old node goes.
  inst('mixed::a', 'mixed', T_RECENT),
  inst('mixed::b', 'mixed', T_OLD),
]
const KANBAN = [board('b-recent', T_RECENT), board('b-mid', T_MID), board('b-old', T_OLD), board('b-none', null)]
const MEMORY = [space('m_recent', T_RECENT), space('m_mid', T_MID), space('m_old', T_OLD), space('m_none', null)]

const shown = (window: ActivityWindowId) => {
  const hidden = hiddenByActivity({ window, now: NOW, instances: INSTANCES, kanban: KANBAN, supermemory: MEMORY })
  const keep = (ids: string[]) => ids.filter(id => !hidden.has(id)).sort()
  return {
    instances: keep(INSTANCES.map(i => i.id)),
    kanban: keep(KANBAN.map(b => b.id)),
    memory: keep(MEMORY.map(s => s.id)),
  }
}

test('options are All, 5 min, 30 min and 2 h; the default is 5 min', () => {
  assert.deepEqual(ACTIVITY_WINDOWS.map(w => w.label), ['All', 'Active last 5 min', 'Active last 30 min', 'Active last 2 h'])
  assert.deepEqual(ACTIVITY_WINDOWS.map(w => w.ms), [null, 300_000, 1_800_000, 7_200_000])
  assert.equal(DEFAULT_ACTIVITY_WINDOW, '5m')
})

test('All: nothing is hidden, not even a resource that never had an event', () => {
  const s = shown('all')
  assert.equal(s.instances.length, INSTANCES.length)
  assert.equal(s.kanban.length, KANBAN.length)
  assert.equal(s.memory.length, MEMORY.length)
})

test('5 min: only what had an event in the last 5 minutes', () => {
  const s = shown('5m')
  assert.deepEqual(s.instances, ['mixed::a', 'recent-1'])
  assert.deepEqual(s.kanban, ['kanban:b-recent'])
  assert.deepEqual(s.memory, ['supermemory:m_recent'])
})

test('30 min: adds what was active 20 minutes ago', () => {
  const s = shown('30m')
  assert.deepEqual(s.instances, ['mid-1', 'mixed::a', 'recent-1'])
  assert.deepEqual(s.kanban, ['kanban:b-mid', 'kanban:b-recent'])
  assert.deepEqual(s.memory, ['supermemory:m_mid', 'supermemory:m_recent'])
})

test('2 h: adds what was active 90 minutes ago; a resource with no event at all stays hidden', () => {
  const s = shown('2h')
  assert.deepEqual(s.instances, ['mid-1', 'mixed::a', 'mixed::b', 'old-1', 'recent-1'])
  assert.deepEqual(s.kanban, ['kanban:b-mid', 'kanban:b-old', 'kanban:b-recent'])
  assert.deepEqual(s.memory, ['supermemory:m_mid', 'supermemory:m_old', 'supermemory:m_recent'])
})

test('the window edge is inclusive and a missing timestamp is outside every limited window', () => {
  assert.equal(inWindow(NOW - 5 * MIN, NOW, 5 * MIN), true)
  assert.equal(inWindow(NOW - 5 * MIN - 1, NOW, 5 * MIN), false)
  assert.equal(inWindow(undefined, NOW, 5 * MIN), false)
  assert.equal(inWindow(undefined, NOW, null), true)
})

test('an instance without lastEventAt falls back to its start, end and tool-call markers', () => {
  const bare: FleetInstance = {
    id: 'bare', identity: 'bare', runtime: 'claude', startTime: NOW - 3 * 60 * MIN, endTime: NOW - 60 * MIN, status: 'completed',
    markers: [{ id: 'm', at: NOW - 3 * MIN, kind: 'tool_call', label: 'Bash' }],
  }
  const h = (window: ActivityWindowId) => hiddenByActivity({ window, now: NOW, instances: [bare] }).has('bare')
  assert.equal(h('5m'), false, 'the tool call 3 minutes ago counts')
  assert.equal(hiddenByActivity({ window: '5m', now: NOW, instances: [{ ...bare, markers: [] }] }).has('bare'), true, 'without it only the end (1 h ago) is left')
  assert.equal(hiddenByActivity({ window: '2h', now: NOW, instances: [{ ...bare, markers: [] }] }).has('bare'), false)
})

test('hidden is not stopped: the filter changes visibility only, never status or the user selection', () => {
  const before = JSON.stringify(INSTANCES)
  const hidden = hiddenByActivity({ window: '5m', now: NOW, instances: INSTANCES, kanban: KANBAN, supermemory: MEMORY })
  assert.equal(JSON.stringify(INSTANCES), before, 'instances are untouched, a running one stays running')
  assert.equal(INSTANCES.find(i => i.id === 'old-1')?.status, 'active')
  const userSel = { isSelected: (id: string) => id !== 'mid-1' }
  const view = withActivityFilter(userSel, hidden)
  assert.equal(view.isSelected('recent-1'), true)
  assert.equal(view.isSelected('old-1'), false, 'outside the window')
  assert.equal(view.isSelected('mid-1'), false, 'deselected by the user stays deselected')
  assert.equal(userSel.isSelected('old-1'), true, 'the user selection itself is not changed')
  assert.equal(withActivityFilter(userSel, new Set()), userSel, 'All returns the selection as is')
})

test('the fleet graph drops hidden profiles, sessions and resources', () => {
  const run = (window: ActivityWindowId) => {
    const hidden = hiddenByActivity({ window, now: NOW, instances: INSTANCES, kanban: KANBAN, supermemory: MEMORY })
    return buildFleetGraph({
      instances: INSTANCES, kanban: KANBAN, supermemory: MEMORY, now: NOW,
      selection: withActivityFilter({ isSelected: () => true }, hidden),
    })
  }
  const g5 = run('5m')
  assert.deepEqual(g5.clouds.map(c => c.profile).sort(), ['mixed', 'recent'])
  assert.deepEqual(g5.clouds.find(c => c.profile === 'mixed')?.sessionIds, ['mixed::a'])
  assert.deepEqual(g5.nodes.filter(n => n.kind !== 'session').map(n => n.id).sort(), ['kanban:b-recent', 'supermemory:m_recent'])
  const g2h = run('2h')
  assert.deepEqual(g2h.clouds.map(c => c.profile).sort(), ['mid', 'mixed', 'old', 'recent'])
  assert.equal(run('all').clouds.length, 4)
})

test('array filter for panels that take lists', () => {
  const hidden = new Set(['kanban:b-old'])
  assert.deepEqual(applyActivityFilter(KANBAN, hidden).map(b => b.slug), ['b-recent', 'b-mid', 'b-none'])
  assert.equal(applyActivityFilter(KANBAN, new Set()), KANBAN)
})

test('summary counts hidden profiles (all nodes hidden), sessions and resources', () => {
  const hidden = hiddenByActivity({ window: '30m', now: NOW, instances: INSTANCES, kanban: KANBAN, supermemory: MEMORY })
  // old-1 and mixed::b are hidden; only "old" has no node left; "mixed" keeps mixed::a.
  assert.deepEqual(summarizeHidden(INSTANCES, KANBAN, MEMORY, hidden), { profiles: 1, sessions: 2, resources: 4 })
})

test('summary counts only what the filter alone hides: not user-deselected items, not boards the map never draws', () => {
  const archived = { ...board('b-archived', T_OLD), archived: true } as PublicKanbanBoardNode
  const unused = { ...board('b-unused', null), totalTasks: 0 } as PublicKanbanBoardNode
  const kanban = [...KANBAN, archived, unused]
  const hidden = hiddenByActivity({ window: '5m', now: NOW, instances: INSTANCES, kanban, supermemory: MEMORY })
  assert.ok(hidden.has('kanban:b-archived') && hidden.has('kanban:b-unused'), 'the filter does hide them too')
  const userOff = new Set(['old-1', 'kanban:b-mid', 'supermemory:m_none'])
  const sel = { isSelected: (id: string) => !userOff.has(id) }
  // 5 min hides: mid-1, old-1, mixed::b | b-mid, b-old, b-none (b-archived, b-unused never drawn) | m_mid, m_old, m_none.
  // User already deselected old-1, b-mid and m_none, so they are not the filter's doing.
  assert.deepEqual(summarizeHidden(INSTANCES, kanban, MEMORY, hidden, sel), { profiles: 1, sessions: 2, resources: 4 })
  assert.deepEqual(summarizeHidden(INSTANCES, kanban, MEMORY, hidden), { profiles: 2, sessions: 3, resources: 6 })
})

test('sameIds compares content, so a clock tick that changes nothing does not rebuild the map', () => {
  assert.equal(sameIds(new Set(['a', 'b']), new Set(['b', 'a'])), true)
  assert.equal(sameIds(new Set(['a']), new Set(['a', 'b'])), false)
  assert.equal(sameIds(new Set(['a', 'c']), new Set(['a', 'b'])), false)
})

test('events decide the activity: a message keeps a node visible, agent_idle does not', () => {
  const START = NOW - 60 * MIN
  const sessions: SessionLike[] = [
    { id: 's-chat', label: 'Chat', status: 'active', startTime: START, lastActivityTime: NOW },
    { id: 's-quiet', label: 'Quiet', status: 'active', startTime: START, lastActivityTime: NOW },
  ]
  const spawn = (name: string): SessionEventLike => ({ time: 0, type: 'agent_spawn', payload: { name, parent: 'x', startedAt: START } })
  const events: Record<string, SessionEventLike[]> = {
    // last real event 1 minute ago (a message, which leaves no tool-call marker)
    's-chat': [spawn('Chat · A'), { time: 59 * 60, type: 'message', payload: { agent: 'Chat · A', role: 'assistant', content: 'hi' } }],
    // last real event 40 minutes ago, then an agent_idle 1 minute ago
    's-quiet': [
      spawn('Quiet · A'), { time: 20 * 60, type: 'tool_call_start', payload: { agent: 'Quiet · A', tool: 'Bash' } },
      { time: 59 * 60, type: 'agent_idle', payload: { name: 'Quiet · A' } },
    ],
  }
  const instances = instancesFromSessionEvents(sessions, id => events[id] ?? [])
  assert.equal(instances.length, 2)
  const hidden = hiddenByActivity({ window: '5m', now: NOW, instances })
  assert.deepEqual([...hidden], ['s-quiet::Quiet · A'])
})

test('the relay\'s quiet-timeout agent_complete is not activity: spawn, tool at T, timeout complete at T+10 min, hidden in 5m at T+11', () => {
  const START = NOW - 60 * MIN
  const T = 30 * 60 // tool call 30 minutes into the node, in seconds
  const sessions: SessionLike[] = [{ id: 's-q', label: 'Quiet', status: 'completed', startTime: START, lastActivityTime: NOW }]
  const events: SessionEventLike[] = [
    { time: 0, type: 'agent_spawn', payload: { name: 'Quiet · A', parent: 'x', startedAt: START } },
    { time: T, type: 'tool_call_start', payload: { agent: 'Quiet · A', tool: 'Bash' } },
    { time: T + 10 * 60, type: 'agent_complete', payload: { name: 'Quiet · A', reason: 'quiet' } },
  ]
  const [inst] = instancesFromSessionEvents(sessions, () => events)
  const tool = START + T * 1000
  assert.equal(inst.status, 'completed')
  assert.equal(inst.lastEventAt, tool, 'the quiet timeout does not set lastEventAt')
  assert.equal(instanceLastActivity(inst), tool, 'and its end time is not an activity time either')
  const at = (offsetMin: number, window: ActivityWindowId) => hiddenByActivity({ window, now: tool + offsetMin * MIN, instances: [inst] }).has(inst.id)
  assert.equal(at(4, '5m'), false)
  assert.equal(at(6, '5m'), true, 'hidden 5 minutes after the last real event')
  assert.equal(at(11, '5m'), true, 'still hidden after the synthetic completion at T+10')
  assert.equal(at(11, '30m'), false)
  assert.equal(at(31, '30m'), true, 'the 30 min window is not stretched by the timeout either')
})

test('a real agent_complete (subagent finished, history restored) still counts as activity', () => {
  const START = NOW - 60 * MIN
  const sessions: SessionLike[] = [{ id: 's-r', label: 'Real', status: 'completed', startTime: START, lastActivityTime: NOW }]
  const events: SessionEventLike[] = [
    { time: 0, type: 'agent_spawn', payload: { name: 'Real · A', parent: 'x', startedAt: START } },
    { time: 20 * 60, type: 'tool_call_start', payload: { agent: 'Real · A', tool: 'Bash' } },
    { time: 58 * 60, type: 'agent_complete', payload: { name: 'Real · A' } },
  ]
  const [inst] = instancesFromSessionEvents(sessions, () => events)
  assert.equal(inst.lastEventAt, START + 58 * 60 * 1000)
  assert.equal(hiddenByActivity({ window: '5m', now: NOW, instances: [inst] }).has(inst.id), false, 'finished 2 minutes ago')
})

test('countsAsActivity: agent_idle and the quiet-timeout completion do not count, real events do', () => {
  assert.equal(countsAsActivity('agent_idle', { name: 'a' }), false)
  assert.equal(countsAsActivity('agent_complete', { name: 'a', reason: 'quiet' }), false)
  assert.equal(countsAsActivity('agent_complete', { name: 'a' }), true)
  assert.equal(countsAsActivity('agent_complete', { name: 'a', idle: true }), true)
  assert.equal(countsAsActivity('tool_call_start', {}), true)
  assert.equal(countsAsActivity('message'), true)
  assert.equal(countsAsActivity('context_update', {}), false)
})

test('a session without nodes uses the session\'s own last activity time', () => {
  const s: SessionLike = { id: 'hermes-hestia', label: 'Hestia', status: 'completed', startTime: NOW - 600 * MIN, lastActivityTime: NOW - 600 * MIN, idle: true }
  const instances = instancesFromSessionEvents([s, { ...s, id: 'hermes-taxis', label: 'Taxis', status: 'active', idle: undefined, lastActivityTime: NOW - MIN }], () => [])
  const hidden = hiddenByActivity({ window: '2h', now: NOW, instances })
  assert.deepEqual([...hidden], ['hermes-hestia'])
})

test('the choice persists in localStorage and a bad value gives the default', () => {
  const m = new Map<string, string>()
  const storage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
  assert.equal(loadActivityWindow(storage), '5m', 'nothing stored: default')
  for (const w of ACTIVITY_WINDOWS) {
    assert.equal(saveActivityWindow(storage, w.id), true)
    assert.equal(m.get(FLEET_ACTIVITY_FILTER_KEY), w.id)
    assert.equal(loadActivityWindow(storage), w.id)
  }
  m.set(FLEET_ACTIVITY_FILTER_KEY, 'garbage')
  assert.equal(loadActivityWindow(storage), '5m')
  assert.equal(parseActivityWindow(null), '5m')
  assert.equal(parseActivityWindow(undefined), '5m')
})

test('broken storage does not throw', () => {
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
  assert.equal(loadActivityWindow(boom), '5m')
  assert.equal(saveActivityWindow(boom, '2h'), false)
  assert.equal(saveActivityWindow(null, '2h'), false)
  assert.equal(loadActivityWindow(null), '5m')
})
