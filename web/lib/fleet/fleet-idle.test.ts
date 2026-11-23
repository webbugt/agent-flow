import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  buildFleetRows, computeAxis, fleetSessions, groupInstances, instancesFromSessionEvents, instancesFromSessions, tabSessions,
  type SessionEventLike, type SessionLike,
} from './fleet-model'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)
const MIN = 60_000
const HOUR = 60 * MIN
const NOW = T0 + 10 * HOUR

const all = { isSelected: () => true }
const view = (off: ReadonlySet<string>) => ({ isSelected: (id: string) => !off.has(id) })

type S = SessionLike
const live = (profile: string, label: string): S =>
  ({ id: `hermes-${profile}`, label, status: 'active', startTime: T0 + 9 * HOUR, lastActivityTime: NOW })
const idle = (profile: string, label: string): S =>
  ({ id: `hermes-${profile}`, label, status: 'completed', startTime: T0, lastActivityTime: T0 + 2 * HOUR, idle: true })

const spawn = (name: string, startedAt: number): SessionEventLike =>
  ({ time: 0, type: 'agent_spawn', payload: { name, parent: 'x', startedAt } })
const tool = (agent: string, time: number): SessionEventLike =>
  ({ time, type: 'tool_call_start', payload: { agent, tool: 'Bash' } })

// What the relay sends for an idle profile: spawn, then complete marked idle.
const idleEvents = (node: string, startedAt: number, lastSec: number): SessionEventLike[] => [
  { time: 0, type: 'agent_spawn', payload: { name: 'main', isMain: true } },
  spawn(node, startedAt),
  { time: lastSec, type: 'agent_complete', payload: { name: node, idle: true } },
  { time: 0, type: 'agent_complete', payload: { name: 'main', idle: true } },
]

test('idle profile: node is an idle instance with its real span, not active and not completed', () => {
  const events: Record<string, SessionEventLike[]> = {
    'hermes-sophia': idleEvents('Sophia · Report', T0, 2 * 3600),
  }
  const inst = instancesFromSessionEvents([idle('sophia', 'Sophia')], id => events[id] ?? [])
  assert.equal(inst.length, 1)
  assert.equal(inst[0].status, 'idle')
  assert.equal(inst[0].startTime, T0)
  assert.equal(inst[0].endTime, T0 + 2 * HOUR)
  assert.equal(inst[0].identity, 'sophia')
})

test('idle profile without events still appears: one idle instance of its own', () => {
  const inst = instancesFromSessionEvents([idle('hestia', 'Hestia')], () => [])
  assert.equal(inst.length, 1)
  assert.equal(inst[0].status, 'idle')
  assert.equal(inst[0].endTime, T0 + 2 * HOUR)
  assert.equal(instancesFromSessions([live('taxis', 'Taxis')])[0].status, 'active')
})

test('a quiet node (agent_idle) reads idle and turns active again on its next tool call', () => {
  const base: SessionEventLike[] = [spawn('Taxis · Plan', T0), tool('Taxis · Plan', 5)]
  const quiet = [...base, { time: 90, type: 'agent_idle', payload: { name: 'Taxis · Plan' } }]
  const s = [live('taxis', 'Taxis')]
  assert.equal(instancesFromSessionEvents(s, () => quiet)[0].status, 'idle')
  assert.equal(instancesFromSessionEvents(s, () => [...quiet, tool('Taxis · Plan', 100)])[0].status, 'active')
  // Respawned (new run) after an idle completion: running again.
  const reborn = [...idleEvents('Taxis · Plan', T0, 600), spawn('Taxis · Plan', T0 + HOUR)]
  assert.equal(instancesFromSessionEvents(s, () => reborn)[0].status, 'active')
})

test('fleet rows: an all-idle profile is labelled idle; a profile with a live node is not', () => {
  const sessions = [live('taxis', 'Taxis'), idle('sophia', 'Sophia')]
  const events: Record<string, SessionEventLike[]> = {
    'hermes-taxis': [spawn('Taxis · Plan', T0 + 9 * HOUR), tool('Taxis · Plan', 30)],
    'hermes-sophia': idleEvents('Sophia · Report', T0, 3600),
  }
  const rows = buildFleetRows({
    instances: instancesFromSessionEvents(sessions, id => events[id] ?? []),
    selection: all, expanded: new Set(), now: NOW,
  })
  const groups = rows.filter(r => r.kind === 'group')
  assert.deepEqual(groups.map(r => r.label).sort(), ['sophia', 'taxis'])
  assert.match(groups.find(r => r.label === 'sophia')!.sublabel ?? '', /idle/)
  assert.doesNotMatch(groups.find(r => r.label === 'taxis')!.sublabel ?? '', /idle/)
  assert.equal(groups.find(r => r.label === 'sophia')!.spans[0].status, 'idle')
  // The shared axis reaches back to the idle profile's start.
  assert.equal(computeAxis(rows, NOW)!.min, T0)
})

// ─── Requirement: two active profiles at once, whichever tab is open ─────────

test('two active profiles in the session list are two groups on the canvas and timeline at once', () => {
  const sessions = [live('taxis', 'Taxis'), live('omh-coder', 'OMH Coder')]
  const events: Record<string, SessionEventLike[]> = {
    'hermes-taxis': [spawn('Taxis · Plan', T0 + 9 * HOUR), tool('Taxis · Plan', 30)],
    'hermes-omh-coder': [spawn('OMH Coder · Fleet', T0 + 9 * HOUR + 5 * MIN), tool('OMH Coder · Fleet', 60)],
  }
  // Whichever tab is selected (or none), the fleet is built from ALL listed sessions.
  for (const selected of ['hermes-taxis', 'hermes-omh-coder', null]) {
    const instances = instancesFromSessionEvents(fleetSessions(sessions, []), id => events[id] ?? [])
    const groups = groupInstances(instances)
    assert.deepEqual(groups.map(g => g.identity).sort(), ['omh coder', 'taxis'], `selected=${selected}`)
    const rows = buildFleetRows({ instances, selection: all, expanded: new Set(), now: NOW })
    const shown = rows.filter(r => r.kind === 'group' && !r.hidden)
    assert.equal(shown.length, 2)
    assert.ok(shown.every(r => r.spans.length > 0 && r.markers.length > 0), 'both lanes carry data')
    assert.ok(shown.every(r => r.spans.every(s => s.status === 'active')))
  }
})

test('fleetSessions: listed sessions plus closed tabs, no duplicates; never looks at the open tab', () => {
  const a = live('taxis', 'Taxis')
  const b = idle('sophia', 'Sophia')
  const c = live('omh-coder', 'OMH Coder')
  assert.deepEqual(fleetSessions([a, b], [c, a]).map(s => s.id), ['hermes-taxis', 'hermes-sophia', 'hermes-omh-coder'])
})

// ─── Tab strip: idle profiles are fleet-only ────────────────────────────────

test('tab strip: idle profiles never add tabs; Fleet off shows the same tabs as before', () => {
  const sessions = [live('taxis', 'Taxis'), idle('sophia', 'Sophia'), live('omh-coder', 'OMH Coder')]
  const instances = instancesFromSessionEvents(sessions, () => [])
  const ids = (xs: SessionLike[]) => xs.map(s => s.id)
  assert.deepEqual(ids(tabSessions(sessions, 'hermes-taxis', false, instances, all)), ['hermes-taxis', 'hermes-omh-coder'])
  assert.deepEqual(ids(tabSessions(sessions, 'hermes-taxis', true, instances, all)), ['hermes-taxis', 'hermes-omh-coder'])
  // Opening an idle profile from the fleet selects it: its tab shows while it is open.
  assert.deepEqual(ids(tabSessions(sessions, 'hermes-sophia', false, instances, all)), ['hermes-taxis', 'hermes-sophia', 'hermes-omh-coder'])
  // With Fleet on, deselecting a profile's node still hides its tab (existing behaviour).
  const off = new Set(['hermes-omh-coder'])
  assert.deepEqual(ids(tabSessions(sessions, 'hermes-taxis', true, instances, view(off))), ['hermes-taxis'])
})
