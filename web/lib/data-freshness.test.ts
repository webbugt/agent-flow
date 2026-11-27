import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dataFreshness, formatAgo, stampStreamMessage, STALE_AFTER_MS, STAMP_THROTTLE_MS, type StreamStamps } from './data-freshness'
import { countsAsActivity } from './fleet/fleet-model'

const T0 = 1_700_000_000_000

test('formatAgo: seconds, minutes, hours; never negative or NaN', () => {
  assert.equal(formatAgo(0), '0s')
  assert.equal(formatAgo(5_400), '5s')
  assert.equal(formatAgo(59_999), '59s')
  assert.equal(formatAgo(60_000), '1m 00s')
  assert.equal(formatAgo(184_000), '3m 04s')
  assert.equal(formatAgo(2 * 3600_000 + 5 * 60_000), '2h 05m')
  assert.equal(formatAgo(-5), '0s')
  assert.equal(formatAgo(NaN), '0s')
})

test('an event 12 s ago is LIVE and says so', () => {
  const f = dataFreshness({ now: T0 + 12_000, connected: true, lastEventAt: T0, connectedAt: T0 - 1000 })
  assert.deepEqual([f.level, f.label, f.detail], ['live', 'LIVE', 'last event 12s ago'])
})

test('59.9 s without data is still live, 60 s is STALE (the marker appears at the threshold)', () => {
  const at = (ms: number) => dataFreshness({ now: T0 + ms, connected: true, lastEventAt: T0, connectedAt: T0 })
  assert.equal(at(STALE_AFTER_MS - 1).level, 'live')
  assert.equal(at(STALE_AFTER_MS).level, 'stale')
  assert.equal(at(STALE_AFTER_MS).label, 'STALE')
  assert.equal(at(STALE_AFTER_MS).detail, 'last event 1m 00s ago')
})

test('connected but no event yet: counted from the connection, and it also goes stale', () => {
  const live = dataFreshness({ now: T0 + 8_000, connected: true, lastEventAt: null, connectedAt: T0 })
  assert.equal(live.level, 'live')
  assert.equal(live.detail, 'no event yet (connected 8s ago)')
  assert.equal(dataFreshness({ now: T0 + 90_000, connected: true, lastEventAt: null, connectedAt: T0 }).level, 'stale')
})

test('a new event clears the stale marker', () => {
  const stale = dataFreshness({ now: T0 + 70_000, connected: true, lastEventAt: T0, connectedAt: T0 })
  const fresh = dataFreshness({ now: T0 + 70_500, connected: true, lastEventAt: T0 + 70_000, connectedAt: T0 })
  assert.equal(stale.level, 'stale')
  assert.equal(fresh.level, 'live')
})

test('no connection is OFFLINE, with the age of the last event when there was one', () => {
  assert.deepEqual(
    dataFreshness({ now: T0 + 5_000, connected: false, lastEventAt: T0, connectedAt: T0 }),
    { level: 'offline', label: 'OFFLINE', detail: 'no connection, last event 5s ago', short: '5s', sinceMs: 5_000 },
  )
  assert.equal(dataFreshness({ now: T0, connected: false, lastEventAt: null, connectedAt: null }).detail, 'no connection')
})

test('a clock that went backwards never gives a negative age', () => {
  const f = dataFreshness({ now: T0 - 5_000, connected: true, lastEventAt: T0, connectedAt: T0 })
  assert.equal(f.sinceMs, 0)
  assert.equal(f.level, 'live')
})

test('the threshold can be changed', () => {
  assert.equal(dataFreshness({ now: T0 + 11_000, connected: true, lastEventAt: T0, connectedAt: T0, staleAfterMs: 10_000 }).level, 'stale')
})

// --- Review rework: LIVE / STALE follow the stream, not only activity ------------------------------------------------

/** Replay a stream through the same pure function the bridge hook uses; returns the stamps and the level at each check. */
function runStream(msgs: { at: number; type: string; payload?: Record<string, unknown>; history?: boolean }[], checkAt: number[], connectedAt = T0) {
  let stamps: StreamStamps = { lastEventAt: null, lastActivityAt: null }
  for (const m of msgs) stamps = stampStreamMessage(stamps, m.at, !m.history && countsAsActivity(m.type, m.payload))
  return { stamps, levels: checkAt.map(now => dataFreshness({ now, connected: true, connectedAt, ...stamps }).level) }
}

test('a stream of only context_update / model_detected / agent_idle stays LIVE for 5 minutes', () => {
  const types = ['context_update', 'model_detected', 'agent_idle']
  const msgs = Array.from({ length: 30 }, (_, i) => ({ at: T0 + (i + 1) * 10_000, type: types[i % 3] }))
  const { stamps, levels } = runStream(msgs, [T0 + 65_000, T0 + 125_000, T0 + 300_000])
  assert.deepEqual(levels, ['live', 'live', 'live'])
  assert.equal(stamps.lastEventAt, T0 + 300_000)
  assert.equal(stamps.lastActivityAt, null, 'none of these shows activity')
  const f = dataFreshness({ now: T0 + 303_000, connected: true, connectedAt: T0, ...stamps })
  assert.equal(f.label, 'LIVE')
  assert.equal(f.detail, 'last event 3s ago')
})

test('the same non-activity stream going silent for 60 s turns STALE', () => {
  const msgs = [{ at: T0 + 10_000, type: 'context_update' }, { at: T0 + 20_000, type: 'agent_idle' }]
  const { levels } = runStream(msgs, [T0 + 79_000, T0 + 80_000])
  assert.deepEqual(levels, ['live', 'stale'])
})

test('a history replay alone says "last event", never "no event yet", and is not activity', () => {
  const { stamps } = runStream([{ at: T0 + 500, type: 'agent_spawn', history: true }, { at: T0 + 600, type: 'message', history: true }], [])
  assert.equal(stamps.lastEventAt, T0 + 500)
  assert.equal(stamps.lastActivityAt, null)
  assert.equal(dataFreshness({ now: T0 + 2_000, connected: true, connectedAt: T0, ...stamps }).detail, 'last event 1s ago')
})

test('activity age is extra text next to the event age', () => {
  const { stamps } = runStream([
    { at: T0 + 1_000, type: 'tool_call_start' },
    { at: T0 + 100_000, type: 'context_update' },
  ], [])
  const f = dataFreshness({ now: T0 + 104_000, connected: true, connectedAt: T0, ...stamps })
  assert.equal(f.level, 'live')
  assert.equal(f.detail, 'last event 4s ago \u00b7 last activity 1m 43s ago')
  assert.equal(f.short, '4s')
})

test("the relay's quiet-timeout completion is not activity but still keeps the stream LIVE", () => {
  const { stamps } = runStream([{ at: T0 + 1_000, type: 'agent_complete', payload: { reason: 'quiet' } }], [])
  assert.equal(stamps.lastEventAt, T0 + 1_000)
  assert.equal(stamps.lastActivityAt, null)
})

test('stamping is throttled to one write a second and returns the same object when nothing changes', () => {
  const a = stampStreamMessage({ lastEventAt: null, lastActivityAt: null }, T0, true)
  assert.deepEqual(a, { lastEventAt: T0, lastActivityAt: T0 })
  assert.equal(stampStreamMessage(a, T0 + STAMP_THROTTLE_MS - 1, true), a)
  const b = stampStreamMessage(a, T0 + STAMP_THROTTLE_MS, false)
  assert.deepEqual(b, { lastEventAt: T0 + STAMP_THROTTLE_MS, lastActivityAt: T0 })
})
