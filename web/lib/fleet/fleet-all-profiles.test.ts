import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  buildFleetRows, computeAxis, groupInstances, instancesFromSessionEvents, nodeInstanceId, splitInstanceId, tabSessions,
  type FleetRow, type SessionEventLike, type SessionLike,
} from './fleet-model'
import { setMany } from './fleet-selection'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)
const MIN = 60_000
const NOW = T0 + 60 * MIN

const view = (off: ReadonlySet<string>) => ({ isSelected: (id: string) => !off.has(id) })
const none = new Set<string>()
const row = (rows: FleetRow[], key: string) => {
  const r = rows.find(x => x.key === key)
  assert.ok(r, `row ${key} missing`)
  return r
}

const session = (profile: string, label: string, status: 'active' | 'completed' = 'active'): SessionLike =>
  ({ id: `hermes-${profile}`, label, status, startTime: T0, lastActivityTime: NOW })

const spawn = (name: string, startedAt: number, model?: string): SessionEventLike =>
  ({ time: 0, type: 'agent_spawn', payload: { name, parent: 'x', startedAt, ...(model ? { model } : {}) } })
const mainSpawn = (name: string): SessionEventLike =>
  ({ time: 0, type: 'agent_spawn', payload: { name, isMain: true } })
const tool = (agent: string, time: number, name = 'terminal'): SessionEventLike =>
  ({ time, type: 'tool_call_start', payload: { agent, tool: name } })
const complete = (name: string, time: number): SessionEventLike =>
  ({ time, type: 'agent_complete', payload: { name } })

// Two Hermes profiles, each with its own agent nodes. Taxis has two nodes, Sophia one.
const SESSIONS = [session('taxis', 'Taxis'), session('sophia', 'Sophia')]
const EVENTS: Record<string, SessionEventLike[]> = {
  'hermes-taxis': [
    mainSpawn('Taxis'),
    spawn('Taxis · Fix Login', T0 + 5 * MIN, 'claude-sonnet'),
    tool('Taxis · Fix Login', 60),
    tool('Taxis · Fix Login', 120),
    spawn('Taxis · Weekly Plan', T0 + 20 * MIN),
    complete('Taxis · Fix Login', 900),
  ],
  'hermes-sophia': [
    mainSpawn('Sophia'),
    spawn('Sophia · Review', T0 + 10 * MIN),
    tool('Sophia · Review', 30),
  ],
}
const eventsOf = (id: string) => EVENTS[id] ?? []

test('sessions from two profiles show both groups, one instance per agent node', () => {
  const instances = instancesFromSessionEvents(SESSIONS, eventsOf)
  const groups = groupInstances(instances)
  assert.deepEqual(groups.map(g => [g.identity, g.instances.length]), [['taxis', 2], ['sophia', 1]])
  const rows = buildFleetRows({ instances, selection: view(none), expanded: new Set(['taxis', 'sophia']), now: NOW })
  // Count badge for copies only. Every node has a row: a group of several is open by
  // default into one row per node, a group of one is its own node row.
  assert.equal(row(rows, 'group:taxis').badge, 'x2')
  assert.equal(row(rows, 'group:sophia').badge, undefined)
  assert.deepEqual(rows.map(r => r.key), [
    'group:taxis',
    nodeInstanceId('hermes-taxis', 'Taxis · Fix Login'),
    nodeInstanceId('hermes-taxis', 'Taxis · Weekly Plan'),
    'group:sophia',
  ])
  assert.equal(row(rows, 'group:sophia').openSessionId, nodeInstanceId('hermes-sophia', 'Sophia · Review'))
})

test('nodes sit on the wall-clock axis: start, end and tool markers use each node\'s own time base', () => {
  const instances = instancesFromSessionEvents(SESSIONS, eventsOf)
  const fix = instances.find(i => i.id === nodeInstanceId('hermes-taxis', 'Taxis · Fix Login'))!
  assert.equal(fix.startTime, T0 + 5 * MIN)
  assert.equal(fix.endTime, T0 + 5 * MIN + 900_000)
  assert.equal(fix.status, 'completed')
  assert.equal(fix.runtime, 'claude-sonnet')
  assert.deepEqual(fix.markers.map(m => m.at), [T0 + 6 * MIN, T0 + 7 * MIN])
  const plan = instances.find(i => i.id === nodeInstanceId('hermes-taxis', 'Taxis · Weekly Plan'))!
  assert.equal(plan.endTime, undefined)
  assert.equal(plan.status, 'active')
  // The main node is the profile itself, not a copy.
  assert.ok(!instances.some(i => i.id.endsWith('::Taxis')))
  // One shared axis over both profiles.
  const rows = buildFleetRows({ instances, selection: view(none), expanded: new Set(), now: NOW })
  const axis = computeAxis(rows, NOW)!
  assert.equal(axis.min, T0 + 5 * MIN)
  assert.equal(axis.max, NOW)
})

test('a profile with no placeable node yet still shows up as one instance', () => {
  const quiet = session('hestia', 'Hestia')
  const instances = instancesFromSessionEvents([...SESSIONS, quiet], id => (id === 'hermes-hestia' ? [mainSpawn('Hestia')] : eventsOf(id)))
  assert.deepEqual(groupInstances(instances).map(g => g.identity), ['hestia', 'taxis', 'sophia'])
  assert.equal(instances.find(i => i.id === 'hermes-hestia')?.startTime, T0)
})

test('a node that becomes active again is running again and counts from its new time base', () => {
  const again: SessionEventLike[] = [
    spawn('Taxis · Fix Login', T0), complete('Taxis · Fix Login', 60),
    spawn('Taxis · Fix Login', T0 + 30 * MIN), tool('Taxis · Fix Login', 10),
  ]
  const [inst] = instancesFromSessionEvents([SESSIONS[0]], () => again)
  assert.equal(inst.startTime, T0)
  assert.equal(inst.endTime, undefined)
  assert.equal(inst.markers[0].at, T0 + 30 * MIN + 10_000)
})

test('deselecting a node or a group only hides it; the other profile stays untouched', () => {
  const instances = instancesFromSessionEvents(SESSIONS, eventsOf)
  const expanded = new Set(['taxis', 'sophia'])
  const base = buildFleetRows({ instances, selection: view(none), expanded, now: NOW })
  const taxisIds = instances.filter(i => i.identity === 'taxis').map(i => i.id)
  const off = setMany(none, taxisIds, false)
  const rows = buildFleetRows({ instances, selection: view(off), expanded, now: NOW })
  assert.equal(row(rows, 'group:taxis').hidden, true)
  assert.equal(rows.length, base.length, 'hidden rows stay so they can be shown again')
  assert.deepEqual(row(rows, 'group:sophia'), row(base, 'group:sophia'))
})

test('splitInstanceId round-trips node ids and leaves plain session ids alone', () => {
  assert.deepEqual(splitInstanceId(nodeInstanceId('hermes-taxis', 'Taxis · Fix: Login')), { sessionId: 'hermes-taxis', agentName: 'Taxis · Fix: Login' })
  assert.deepEqual(splitInstanceId('hermes-taxis'), { sessionId: 'hermes-taxis' })
})

// ─── Fleet off: single-profile tabs ─────────────────────────────────────────

test('Fleet off: every profile tab shows and the fleet selection does not touch the tab strip', () => {
  const instances = instancesFromSessionEvents(SESSIONS, eventsOf)
  const allOff = setMany(none, instances.map(i => i.id), false)
  const tabs = tabSessions(SESSIONS, 'hermes-taxis', false, instances, view(allOff))
  assert.deepEqual(tabs.map(s => s.id), ['hermes-taxis', 'hermes-sophia'])
  assert.equal(tabs.find(s => s.id === 'hermes-taxis'), SESSIONS[0], 'the session objects are passed through as they are')
})

test('Fleet on: a profile whose nodes are all deselected leaves the tab strip, the open tab never does', () => {
  const instances = instancesFromSessionEvents(SESSIONS, eventsOf)
  const sophiaOff = setMany(none, instances.filter(i => i.identity === 'sophia').map(i => i.id), false)
  assert.deepEqual(tabSessions(SESSIONS, 'hermes-taxis', true, instances, view(sophiaOff)).map(s => s.id), ['hermes-taxis'])
  assert.deepEqual(tabSessions(SESSIONS, 'hermes-sophia', true, instances, view(sophiaOff)).map(s => s.id), ['hermes-taxis', 'hermes-sophia'])
  // One node of Taxis still selected: its tab stays.
  const oneOff = setMany(none, [nodeInstanceId('hermes-taxis', 'Taxis · Fix Login')], false)
  assert.equal(tabSessions(SESSIONS, 'hermes-sophia', true, instances, view(oneOff)).length, 2)
})
