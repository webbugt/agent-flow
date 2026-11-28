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

test('a message 12 s ago and activity 12 s ago is LIVE and shows the activity age', () => {
  const f = dataFreshness({ now: T0 + 12_000, connected: true, lastEventAt: T0, lastActivityAt: T0, connectedAt: T0 - 1000 })
  assert.deepEqual([f.level, f.label, f.detail, f.short], ['live', 'LIVE', 'last activity 12s ago', '12s'])
})

test('59.9 s without any stream message is still live, 60 s is STALE (the marker appears at the threshold)', () => {
  const at = (ms: number) => dataFreshness({ now: T0 + ms, connected: true, lastEventAt: T0, lastActivityAt: T0, connectedAt: T0 })
  assert.equal(at(STALE_AFTER_MS - 1).level, 'live')
  assert.equal(at(STALE_AFTER_MS).level, 'stale')
  assert.equal(at(STALE_AFTER_MS).label, 'STALE')
  assert.equal(at(STALE_AFTER_MS).detail, 'no message from the relay for 1m 00s \u00b7 last activity 1m 00s ago')
  assert.equal(at(STALE_AFTER_MS).short, '1m 00s', 'the short age of a stale marker is the silence')
})

test('connected but no message yet: counted from the connection, and it also goes stale', () => {
  const live = dataFreshness({ now: T0 + 8_000, connected: true, lastEventAt: null, connectedAt: T0 })
  assert.equal(live.level, 'live')
  assert.equal(live.detail, 'no activity since connect (8s ago)')
  assert.equal(live.short, '')
  const stale = dataFreshness({ now: T0 + 90_000, connected: true, lastEventAt: null, connectedAt: T0 })
  assert.equal(stale.level, 'stale')
  assert.equal(stale.detail, 'no message from the relay for 1m 30s')
})

test('a new message clears the stale marker', () => {
  const stale = dataFreshness({ now: T0 + 70_000, connected: true, lastEventAt: T0, connectedAt: T0 })
  const fresh = dataFreshness({ now: T0 + 70_500, connected: true, lastEventAt: T0 + 70_000, connectedAt: T0 })
  assert.equal(stale.level, 'stale')
  assert.equal(fresh.level, 'live')
})

test('no connection is OFFLINE, with the age of the last message and of the last activity when known', () => {
  assert.deepEqual(
    dataFreshness({ now: T0 + 5_000, connected: false, lastEventAt: T0, connectedAt: T0 }),
    { level: 'offline', label: 'OFFLINE', detail: 'no connection, last message 5s ago', short: '5s', sinceMs: 5_000 },
  )
  assert.equal(
    dataFreshness({ now: T0 + 5_000, connected: false, lastEventAt: T0 + 4_000, lastActivityAt: T0, connectedAt: T0 }).detail,
    'no connection, last message 1s ago \u00b7 last activity 5s ago',
  )
  assert.equal(dataFreshness({ now: T0, connected: false, lastEventAt: null, connectedAt: null }).detail, 'no connection')
})

test('a clock that went backwards never gives a negative age', () => {
  const f = dataFreshness({ now: T0 - 5_000, connected: true, lastEventAt: T0, lastActivityAt: T0, connectedAt: T0 })
  assert.equal(f.sinceMs, 0)
  assert.equal(f.level, 'live')
  assert.equal(f.detail, 'last activity 0s ago')
})

test('the threshold can be changed', () => {
  assert.equal(dataFreshness({ now: T0 + 11_000, connected: true, lastEventAt: T0, connectedAt: T0, staleAfterMs: 10_000 }).level, 'stale')
})

// --- LIVE / STALE follow the relay stream; the shown age follows REAL activity ---------------------------------------

/** Replay a stream through the same pure function the bridge hook uses; returns the stamps and the level at each check. */
function runStream(msgs: { at: number; type: string; payload?: Record<string, unknown>; history?: boolean }[], checkAt: number[], connectedAt = T0) {
  let stamps: StreamStamps = { lastEventAt: null, lastActivityAt: null }
  for (const m of msgs) stamps = stampStreamMessage(stamps, m.at, !m.history && countsAsActivity(m.type, m.payload))
  return { stamps, levels: checkAt.map(now => dataFreshness({ now, connected: true, connectedAt, ...stamps }).level) }
}

test('a stream of only context_update / model_detected / agent_idle stays LIVE for 5 minutes and shows no activity', () => {
  const types = ['context_update', 'model_detected', 'agent_idle']
  const msgs = Array.from({ length: 30 }, (_, i) => ({ at: T0 + (i + 1) * 10_000, type: types[i % 3] }))
  const { stamps, levels } = runStream(msgs, [T0 + 65_000, T0 + 125_000, T0 + 300_000])
  assert.deepEqual(levels, ['live', 'live', 'live'])
  assert.equal(stamps.lastEventAt, T0 + 300_000)
  assert.equal(stamps.lastActivityAt, null, 'none of these shows activity')
  const f = dataFreshness({ now: T0 + 303_000, connected: true, connectedAt: T0, ...stamps })
  assert.equal(f.label, 'LIVE')
  assert.equal(f.detail, 'no activity since connect (5m 03s ago)')
})

test("one real activity, then only the relay's agent_idle ticks every second for 100 s: LIVE, and the activity age grows past 60 s", () => {
  const msgs: { at: number; type: string }[] = [{ at: T0 + 1_000, type: 'tool_call_start' }]
  for (let s = 2; s <= 101; s++) msgs.push({ at: T0 + s * 1_000, type: 'agent_idle' })
  let stamps: StreamStamps = { lastEventAt: null, lastActivityAt: null }
  const seen: { level: string; detail: string }[] = []
  for (const m of msgs) {
    stamps = stampStreamMessage(stamps, m.at, countsAsActivity(m.type))
    if ((m.at - T0) % 20_000 === 1_000 || m.at === T0 + 101_000) {
      const f = dataFreshness({ now: m.at + 100, connected: true, connectedAt: T0, ...stamps })
      seen.push({ level: f.level, detail: f.detail })
    }
  }
  assert.equal(stamps.lastActivityAt, T0 + 1_000, 'agent_idle never moves the activity stamp')
  assert.equal(stamps.lastEventAt, T0 + 101_000, 'but it keeps the stream alive')
  assert.ok(seen.every(x => x.level === 'live'), JSON.stringify(seen))
  assert.equal(seen[seen.length - 1].detail, 'last activity 1m 40s ago')
  const f = dataFreshness({ now: T0 + 101_100, connected: true, connectedAt: T0, ...stamps })
  assert.equal(f.sinceMs, 100, 'liveness is the idle tick 100 ms ago')
})

test('the same non-activity stream going silent for 60 s turns STALE', () => {
  const msgs = [{ at: T0 + 10_000, type: 'context_update' }, { at: T0 + 20_000, type: 'agent_idle' }]
  const { levels } = runStream(msgs, [T0 + 79_000, T0 + 80_000])
  assert.deepEqual(levels, ['live', 'stale'])
})

test('a stream that had activity and then goes completely silent: LIVE, then STALE at 60 s, text names the silence and the activity', () => {
  const { stamps } = runStream([{ at: T0 + 1_000, type: 'tool_call_start' }, { at: T0 + 2_000, type: 'agent_idle' }], [])
  const at = (ms: number) => dataFreshness({ now: T0 + ms, connected: true, connectedAt: T0, ...stamps })
  assert.equal(at(61_999).level, 'live')
  assert.equal(at(62_000).level, 'stale')
  assert.equal(at(62_000).detail, 'no message from the relay for 1m 00s \u00b7 last activity 1m 01s ago')
})

test('a history replay alone is not activity: LIVE with "no activity since connect"', () => {
  const { stamps } = runStream([{ at: T0 + 500, type: 'agent_spawn', history: true }, { at: T0 + 600, type: 'message', history: true }], [])
  assert.equal(stamps.lastEventAt, T0 + 500)
  assert.equal(stamps.lastActivityAt, null)
  assert.equal(dataFreshness({ now: T0 + 2_000, connected: true, connectedAt: T0, ...stamps }).detail, 'no activity since connect (2s ago)')
})

test('a live message that shows activity sets the age; later idle ticks leave it alone', () => {
  const { stamps } = runStream([
    { at: T0 + 1_000, type: 'tool_call_start' },
    { at: T0 + 100_000, type: 'context_update' },
  ], [])
  const f = dataFreshness({ now: T0 + 104_000, connected: true, connectedAt: T0, ...stamps })
  assert.equal(f.level, 'live')
  assert.equal(f.detail, 'last activity 1m 43s ago')
  assert.equal(f.short, '1m 43s')
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
