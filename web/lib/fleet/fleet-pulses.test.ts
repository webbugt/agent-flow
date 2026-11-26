import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { FleetEdgeEvent, FleetGraphEdge } from './fleet-graph'
import { KANBAN_COLOR, SUPERMEMORY_COLOR } from './fleet-colors'
import { FleetPulseTracker, MAX_PULSES_PER_EDGE, PULSE_MAX_AGE_MS, PULSE_MS, pulseColor, pulseProgress } from './fleet-pulses'

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0)
const ev = (key: string, at: number, kind: 'kanban' | 'memory' = 'kanban', label = 'claimed'): FleetEdgeEvent => ({ key, at, kind, label })
const edge = (id: string, events: FleetEdgeEvent[], kind: 'kanban' | 'memory' = 'kanban'): FleetGraphEdge => ({
  id, from: 'cloud:x', to: 'r', kind, lastUsedAt: Math.max(...events.map(e => e.at)), weight: events.length, events, sessions: [],
})

test('colours: one for Kanban events, a different one for memory store, search and forget', () => {
  assert.equal(pulseColor('kanban'), KANBAN_COLOR)
  assert.equal(pulseColor('memory'), SUPERMEMORY_COLOR)
  assert.notEqual(KANBAN_COLOR, SUPERMEMORY_COLOR)
  const t = new FleetPulseTracker()
  t.update([edge('e', [ev('a', NOW - 1000)])], NOW)
  const out = t.update([edge('e', [ev('b', NOW + 1000, 'memory', 'store'), ev('a', NOW - 1000)], 'memory')], NOW + 2000)
  assert.equal(out.length, 1)
  assert.equal(out[0].color, SUPERMEMORY_COLOR)
})

test('the first update only records what exists: loading the page replays no history', () => {
  const t = new FleetPulseTracker()
  const out = t.update([edge('e', [ev('a', NOW - 1000), ev('b', NOW - 2000)])], NOW)
  assert.deepEqual(out, [])
})

test('only a NEW event pulses, once: the same events again start nothing', () => {
  const t = new FleetPulseTracker()
  const base = [ev('a', NOW - 5000)]
  t.update([edge('e', base)], NOW)
  const fresh = [ev('b', NOW + 1000), ...base]
  const first = t.update([edge('e', fresh)], NOW + 1500)
  assert.equal(first.length, 1)
  assert.equal(first[0].edgeId, 'e')
  const again = t.update([edge('e', fresh)], NOW + 2000)
  assert.equal(again.length, 1, 'still the one running, none added')
  assert.equal(again[0].id, first[0].id)
})

test('an unseen but old event is history, not animated', () => {
  const t = new FleetPulseTracker()
  t.update([edge('e', [ev('a', NOW)])], NOW)
  const out = t.update([edge('e', [ev('old', NOW - PULSE_MAX_AGE_MS - 1), ev('a', NOW)])], NOW + 100)
  assert.deepEqual(out, [])
})

test('an empty first update (sources still loading) does not use up the "first load"', () => {
  const t = new FleetPulseTracker()
  assert.deepEqual(t.update([], NOW), [])
  assert.deepEqual(t.update([edge('e', [ev('a', NOW - 100)])], NOW + 100), [], 'the data that arrives later is still the first load')
})

test('a burst is staggered and capped per edge; pulses end after PULSE_MS', () => {
  const t = new FleetPulseTracker()
  t.update([edge('e', [ev('seed', NOW - 90_000)])], NOW)
  const burst = Array.from({ length: 20 }, (_, i) => ev(`n${i}`, NOW + i))
  const out = t.update([edge('e', [...burst, ev('seed', NOW - 90_000)])], NOW + 50)
  assert.equal(out.length, MAX_PULSES_PER_EDGE)
  const starts = out.map(p => p.startedAt)
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b))
  assert.ok(new Set(starts).size === starts.length, 'dots do not stack')
  assert.deepEqual(t.update([edge('e', [...burst, ev('seed', NOW - 90_000)])], NOW + 50 + PULSE_MS + 2000), [])
})

test('pulseProgress: 0..1 along the trip, null before it starts or after it ends', () => {
  const p = { id: 'x', edgeId: 'e', kind: 'kanban' as const, color: KANBAN_COLOR, startedAt: NOW }
  assert.equal(pulseProgress(p, NOW - 1), null)
  assert.equal(pulseProgress(p, NOW), 0)
  assert.equal(pulseProgress(p, NOW + PULSE_MS / 2), 0.5)
  assert.equal(pulseProgress(p, NOW + PULSE_MS), 1)
  assert.equal(pulseProgress(p, NOW + PULSE_MS + 1), null)
})

test('a pulse leaves from the session node that did the interaction (its source id comes from the event)', () => {
  const t = new FleetPulseTracker()
  t.update([edge('e', [ev('seed', NOW - 90_000)])], NOW)
  const a: FleetEdgeEvent = { ...ev('a', NOW + 100), sessionId: 'hermes-taxis::Taxis · Plan' }
  const b: FleetEdgeEvent = { ...ev('b', NOW + 200), sessionId: 'hermes-taxis::Taxis · Review' }
  const c = ev('c', NOW + 300) // source unknown
  const out = t.update([edge('e', [c, b, a, ev('seed', NOW - 90_000)])], NOW + 400)
  assert.deepEqual(out.map(p => p.sourceId), ['hermes-taxis::Taxis · Plan', 'hermes-taxis::Taxis · Review', undefined])
  assert.equal(new Set(out.map(p => p.edgeId)).size, 1, 'still one link: the pulses differ in where they start')
})
