/**
 * P6b host side: the byTime ledger (10-minute slots that fade to hours, bounded) and the limits reading history.
 */
import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { addUsage, recordAssistantUsage, TIME_KEYS_MAX, TIME_SLOT_MS, TIME_SLOTS_KEPT, timeKey, timestampMs } from '../src/usage-ledger'
import {
  HISTORY_FILE, HISTORY_MAX, HISTORY_REPEAT_MS, appendReading, parseHistory, readHistory, readingOf, recordReading,
} from '../src/limits-history'
import { buildLimitsUpdate, LimitsObserver } from '../src/limits-observer'
import { paths, type InstallerEnv } from '../src/statusline-installer'
import type { ObservedReading, WatchedSession } from '../src/protocol'

const ONE = { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }
const T0 = Date.UTC(2026, 10, 25, 12, 0)   // a multiple of 10 minutes and of an hour
const H = 3_600_000

describe('byTime ledger', () => {
  it('a call with a time, a model and a provider lands in its 10-minute slot; the flat totals are unchanged by it', () => {
    const a = addUsage(undefined, ONE, { model: 'claude-opus-5-5', provider: 'anthropic', atMs: T0 + 3 * 60_000 })
    const b = addUsage(a, ONE, { atMs: T0 + 9 * 60_000 })
    const c = addUsage(b, ONE, { atMs: T0 + 11 * 60_000 })
    const k0 = timeKey(T0 / TIME_SLOT_MS, 'anthropic', 'claude-opus-5-5', 'le100000')
    const k1 = timeKey(T0 / TIME_SLOT_MS + 1, 'anthropic', 'claude-opus-5-5', 'le100000')
    assert.deepEqual(Object.keys(c.byTime!).sort(), [k0, k1].sort())
    assert.equal(c.byTime![k0].inputTokens, 2000)
    assert.equal(c.byTime![k1].inputTokens, 1000)
    assert.equal(c.inputTokens, 3000)
    assert.equal(a.byTime![k0].inputTokens, 1000, 'earlier results are not mutated')
  })

  it('no time, no provider or no model: only the totals', () => {
    assert.equal(addUsage(undefined, ONE, { model: 'm', provider: 'p' }).byTime, undefined)
    assert.equal(addUsage(undefined, ONE, { model: 'm', atMs: T0 }).byTime, undefined)
    assert.equal(addUsage(undefined, ONE, { provider: 'p', atMs: T0 }).byTime, undefined)
    assert.equal(addUsage(undefined, ONE, { model: 'm', provider: 'p', atMs: Number.NaN }).byTime, undefined)
  })

  it('old slots fade to hours (same total), and slots past 8 days are dropped; the key count stays bounded', () => {
    let s = addUsage(undefined, ONE, { model: 'm', provider: 'p', atMs: T0 - 20 * 3_600_000 + 20 * 60_000 })   // 19h40m before the newest
    s = addUsage(s, ONE, { model: 'm', provider: 'p', atMs: T0 - 20 * 3_600_000 + 40 * 60_000 })
    s = addUsage(s, ONE, { model: 'm', provider: 'p', atMs: T0 })
    const keys = Object.keys(s.byTime!)
    assert.equal(keys.length, 2, 'two old calls of one hour merged into one key')
    const hourKey = timeKey((T0 - 20 * H) / TIME_SLOT_MS, 'p', 'm', 'le100000')
    assert.equal(s.byTime![hourKey].inputTokens, 2000)
    const old = addUsage(s, ONE, { model: 'm', provider: 'p', atMs: T0 - (TIME_SLOTS_KEPT + 30) * TIME_SLOT_MS })
    assert.equal(Object.keys(old.byTime!).length, 2, 'a call older than 8 days behind the newest is dropped from the slots')
    assert.equal(old.inputTokens, 4000, 'but it still counts in the totals')

    let big = addUsage(undefined, ONE, { model: 'm0', provider: 'p', atMs: T0 })
    for (let i = 1; i < TIME_KEYS_MAX + 200; i++) big = addUsage(big, ONE, { model: `m${i}`, provider: 'p', atMs: T0 })
    assert.ok(Object.keys(big.byTime!).length <= TIME_KEYS_MAX)
  })

  it('a pipe in a model id cannot break the key', () => {
    const s = addUsage(undefined, ONE, { model: 'a|b', provider: 'p|q', atMs: T0 })
    assert.deepEqual(Object.keys(s.byTime!), [timeKey(T0 / TIME_SLOT_MS, 'p|q', 'a|b', 'le100000')])
    assert.equal(Object.keys(s.byTime!)[0].split('|').length, 4)
  })

  it('transcript lines: the `timestamp` field (ISO text or ms) gives the call time', () => {
    assert.equal(timestampMs('2026-11-25T12:03:00.000Z'), T0 + 3 * 60_000)
    assert.equal(timestampMs(T0), T0)
    assert.equal(timestampMs('not a time'), undefined)
    assert.equal(timestampMs(undefined), undefined)
    const sess = { spendByAgent: new Map(), seenUsageIds: new Set() } as unknown as WatchedSession
    recordAssistantUsage(sess, 'orch', { id: 'm1', model: 'claude-fable-5-2', usage: { input_tokens: 5, output_tokens: 1 } }, 'u1', '2026-11-25T12:03:00.000Z')
    const t = sess.spendByAgent.get('orch')!
    assert.deepEqual(Object.keys(t.byTime!), [timeKey(T0 / TIME_SLOT_MS, 'anthropic', 'claude-fable-5-2', 'le100000')])
  })
})

const r = (at: number, pct: number, reset = T0 + 3 * H): ObservedReading => ({ at, fiveHour: { usedPct: pct, resetsAt: reset } })

describe('limits history', () => {
  const temps: string[] = []
  afterEach(() => { for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hist-')); temps.push(d); return d }

  it('appends a reading that moved; a repeat of the same numbers waits for the repeat interval; older-than-last is ignored', () => {
    let h = appendReading([], r(T0, 10), T0)
    h = appendReading(h, r(T0 + 60_000, 10), T0 + 60_000)
    assert.equal(h.length, 1)
    h = appendReading(h, r(T0 + 60_000, 12), T0 + 60_000)
    assert.equal(h.length, 2)
    h = appendReading(h, r(T0 + 30_000, 50), T0 + 60_000)
    assert.equal(h.length, 2, 'a reading older than the newest one is not appended')
    h = appendReading(h, r(T0 + 60_000 + HISTORY_REPEAT_MS, 12), T0 + 2 * HISTORY_REPEAT_MS)
    assert.equal(h.length, 3)
  })

  it('is trimmed by count and by age', () => {
    let h: ObservedReading[] = []
    for (let i = 0; i < HISTORY_MAX + 20; i++) h = appendReading(h, r(T0 + i * 60_000, i), T0 + i * 60_000)
    assert.equal(h.length, HISTORY_MAX)
    const aged = appendReading([r(T0 - 40 * 24 * H, 5)], r(T0, 6), T0)
    assert.deepEqual(aged.map(x => x.at), [T0])
  })

  it('readingOf keeps the two known windows with both numbers, nothing else', () => {
    const rd = readingOf({ at: T0, windows: [
      { kind: 'five_hour', usedPct: 30, resetsAt: T0 + H }, { kind: 'seven_day', usedPct: 4, resetsAt: null }, { kind: 'other', usedPct: 9, resetsAt: T0 },
    ] })
    assert.deepEqual(rd, { at: T0, fiveHour: { usedPct: 30, resetsAt: T0 + H } })
    assert.equal(readingOf({ at: T0, windows: [{ kind: 'other', usedPct: 1, resetsAt: 5 }] }), null)
  })

  it('the file round-trips (private file, atomic) and a corrupt one is an empty history', () => {
    const file = path.join(tmp(), 'limits', HISTORY_FILE)
    recordReading(file, r(T0, 10), T0)
    const after = recordReading(file, r(T0 + 60_000, 20), T0 + 60_000)
    assert.equal(after.length, 2)
    assert.deepEqual(readHistory(file).map(x => x.fiveHour?.usedPct), [10, 20])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(path.dirname(file)), [HISTORY_FILE], 'no temp file is left behind')
    fs.writeFileSync(file, '{ nope')
    assert.deepEqual(readHistory(file), [])
    assert.deepEqual(parseHistory('{"v":2,"readings":[]}'), [])
    assert.deepEqual(parseHistory(JSON.stringify({ v: 1, readings: [{ at: 'x' }, { at: T0, fiveHour: { usedPct: -1, resetsAt: 5 } }, { at: T0, sevenDay: { usedPct: 3, resetsAt: T0 } }] })).length, 1)
  })

  it('the observer records each new reading and the payload carries the history', () => {
    const root = tmp()
    const home = path.join(root, 'home')
    fs.mkdirSync(home, { recursive: true })
    const env: InstallerEnv = { home, nodePath: process.execPath, managedSettingsPaths: [path.join(root, 'none.json')], claudeConfigDir: path.join(home, '.claude') }
    const p = paths(home)
    fs.mkdirSync(p.limitsDir, { recursive: true })
    const write = (at: number, five: number, seven: number) => fs.writeFileSync(p.limits, JSON.stringify({
      v: 1, at, session_id: 's', model: { id: 'claude-opus-5-5' },
      rate_limits: { five_hour: { used_percentage: five, resets_at: (T0 + 2 * H) / 1000 }, seven_day: { used_percentage: seven, resets_at: (T0 + 3 * 24 * H) / 1000 } },
    }))
    let now = T0 + 60_000
    const obs = new LimitsObserver({ env: () => env, canConfigure: true, now: () => now })
    write(T0, 10, 2)
    const first = obs.refresh()
    assert.equal(first.history?.length, 1)
    now += 5 * 60_000
    write(T0 + 5 * 60_000, 25, 3)
    const second = obs.refresh()
    assert.deepEqual(second.history?.map(h => [h.fiveHour?.usedPct, h.sevenDay?.usedPct]), [[10, 2], [25, 3]])
    assert.deepEqual(buildLimitsUpdate({ env, now, seq: 9, canConfigure: true }).history?.length, 2)
    assert.equal(JSON.stringify(second).includes('session_id'), false, 'no session id in the history')
  })
})
