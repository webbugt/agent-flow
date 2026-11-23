import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SimulationEvent } from '@/lib/agent-types'
import { createEmptyState, type SimulationState } from './types'
import { processEvent, type ProcessEventContext } from './process-event'
import { applyExternalEvents } from './apply-external-events'

const ctx = (): ProcessEventContext => ({
  syncForceSimulation: () => {}, findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000, blockIdCounter: { current: 0 }, skipForceSync: true,
})
const process_ = (c: ProcessEventContext) => (e: SimulationEvent, s: SimulationState) => processEvent(e, s, c)

const spawn = (history: boolean): SimulationEvent => ({
  time: 0, type: 'agent_spawn', history,
  payload: { name: 'Taxis', isMain: true, task: 'Taxis', model: 'claude-opus-4' },
})
const toolStart = (time: number, id: string, history: boolean): SimulationEvent => ({
  time, type: 'tool_call_start', history,
  payload: { agent: 'Taxis', tool: 'Bash', args: `cmd ${id}`, inputData: { command: `cmd ${id}` }, toolUseId: id },
})
const toolEnd = (time: number, id: string, history: boolean): SimulationEvent => ({
  time, type: 'tool_call_end', history,
  payload: { agent: 'Taxis', tool: 'Bash', result: 'ok', toolUseId: id },
})

function history(): SimulationEvent[] {
  const out: SimulationEvent[] = [spawn(true)]
  for (let i = 0; i < 6; i++) {
    out.push(toolStart(100 + i * 60, `h${i}`, true), toolEnd(110 + i * 60, `h${i}`, true))
  }
  return out
}

test('history events are not all placed at the same instant', () => {
  const r = applyExternalEvents(createEmptyState({ isPlaying: true }), history(), 0.016, process_(ctx()))
  const times = r.applied.map(e => e.time)
  assert.equal(times.length, 13)
  assert.ok(new Set(times).size > 6, `expected spread times, got ${[...new Set(times)]}`)
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'applied times stay monotonic')
  assert.equal(times[1], 100)
  assert.equal(times[times.length - 1], 410)
  // timeline stays complete and spaced as the history was
  const blocks = r.state.timelineEntries.get('Taxis')!.blocks
  const starts = blocks.map(b => b.startTime)
  assert.ok(blocks.length >= 7)
  assert.ok(new Set(starts).size > 3, `timeline blocks collapsed to one instant: ${starts}`)
  assert.equal(r.state.currentTime, 410)
  assert.equal(r.state.maxTimeReached, 410)
  assert.equal(r.newTime, 410)
  assert.ok(!r.applied.some(e => e.history), 'history flag is not kept in the log')
})

test('history is a snapshot: nothing is mid fade-in, no particles', () => {
  const r = applyExternalEvents(createEmptyState({ isPlaying: true }), history(), 0.016, process_(ctx()))
  const main = r.state.agents.get('Taxis')!
  assert.equal(main.opacity, 1)
  assert.equal(main.scale, 1)
  assert.equal(r.state.particles.length, 0)
  for (const tc of r.state.toolCalls.values()) {
    assert.ok(tc.opacity === 0 || tc.opacity === 1, 'tool cards are settled, not animating in')
  }
  assert.equal(r.state.conversations.get('Taxis')!.filter(m => m.type === 'tool_call').length, 6)
})

test('live events after history still animate: placed at now, fading in', () => {
  const first = applyExternalEvents(createEmptyState({ isPlaying: true }), history(), 0.016, process_(ctx()))
  const live = applyExternalEvents(first.state, [toolStart(0, 'live1', false)], first.newTime + 0.5, process_(ctx()))
  const tc = [...live.state.toolCalls.values()].find(t => t.args === 'cmd live1')!
  assert.ok(tc, 'live tool call is created')
  assert.equal(tc.state, 'running')
  assert.equal(tc.opacity, 0, 'starts invisible so the animation loop fades it in')
  assert.equal(live.applied[0].time, 410.5, 'placed at now, after the history')
  assert.equal(live.state.currentTime, 410.5)
})

test('history and live events in one frame: history first, then live animates', () => {
  const events = [...history(), toolStart(0, 'live1', false)]
  const r = applyExternalEvents(createEmptyState({ isPlaying: true }), events, 0.016, process_(ctx()))
  const live = r.applied[r.applied.length - 1]
  assert.equal(live.time, 410)
  const tc = [...r.state.toolCalls.values()].find(t => t.args === 'cmd live1')!
  assert.equal(tc.opacity, 0)
})

test('snapshot mode is on only while history is processed, and the layout is settled once', () => {
  const calls: string[] = []
  applyExternalEvents(createEmptyState({ isPlaying: true }), [...history(), toolStart(0, 'x', false)], 0.016, process_(ctx()), {
    setSnapshotMode: on => calls.push(on ? 'on' : 'off'),
    onHistoryApplied: () => calls.push('sync'),
  })
  assert.deepEqual(calls, ['on', 'off', 'sync'])
})

test('events from another session are skipped by the accept filter', () => {
  const other = { ...toolStart(50, 'o', true), sessionId: 'other' }
  const r = applyExternalEvents(createEmptyState({ isPlaying: true }), [spawn(true), other], 0, process_(ctx()), {
    accept: e => !e.sessionId || e.sessionId === 'mine',
  })
  assert.equal(r.applied.length, 1)
})
