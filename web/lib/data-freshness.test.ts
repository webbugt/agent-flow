import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dataFreshness, formatAgo, STALE_AFTER_MS } from './data-freshness'

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
    { level: 'offline', label: 'OFFLINE', detail: 'no connection, last event 5s ago', sinceMs: 5_000 },
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
