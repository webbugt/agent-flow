import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildObservedLimitsView, formatUntil, type LocalClock } from './observed-limits'
import type { LimitsUpdatePayload } from './observed-types'

// Fixed clock: UTC, so no test depends on the machine's time zone.
const utc: LocalClock = {
  hm: ms => new Date(ms).toISOString().slice(11, 16),
  dayHm: ms => `${new Date(ms).toISOString().slice(5, 10)} ${new Date(ms).toISOString().slice(11, 16)}`,
  sameDay: (a, b) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10),
}
const NOW = Date.UTC(2026, 10, 25, 14, 30)
const H = 3_600_000

const payload = (over: Partial<LimitsUpdatePayload> = {}): LimitsUpdatePayload => ({
  version: 1, seq: 1, provider: 'claude', source: 'statusline', canConfigure: true,
  install: { state: 'installed', canInstall: false }, observed: null, ...over,
})
const observed = (at: number, stale: boolean, windows: NonNullable<LimitsUpdatePayload['observed']>['windows']): LimitsUpdatePayload['observed'] => ({ at, stale, windows })

test('fresh reading: values with obs tag, no as-of, chip shows both windows', () => {
  const v = buildObservedLimitsView(payload({ observed: observed(NOW - 60_000, false, [
    { key: 'five_hour', kind: 'five_hour', usedPct: 23.4, resetsAt: NOW + 2 * H + 15 * 60_000, state: 'fresh' },
    { key: 'seven_day', kind: 'seven_day', usedPct: 41.2, resetsAt: NOW + 3 * 24 * H, state: 'fresh' },
  ]) }), NOW, utc)
  assert.equal(v.mode, 'observed')
  assert.equal(v.asOfText, null)
  assert.deepEqual(v.rows.map(r => [r.label, r.valueText, r.tag, r.resetText]), [['5-hour', '23%', 'obs', 'resets in 2h 15m'], ['Weekly', '41%', 'obs', 'resets 11-28 14:30']])
  assert.equal(v.chip?.text, '5h 23% · wk 41%')
  assert.equal(v.chip?.tone, 'ok')
  assert.match(v.rows[0].title, /Claude Code · 5-hour usage limit · observed/)
  assert.match(v.rows[0].title, /not an estimate and not a price/)
})

test('stale reading: as-of time on the view and the chip, tag stale, value kept', () => {
  const at = Date.UTC(2026, 10, 25, 9, 5)
  const v = buildObservedLimitsView(payload({ observed: observed(at, true, [
    { key: 'five_hour', kind: 'five_hour', usedPct: 80, resetsAt: NOW + H, state: 'stale' },
  ]) }), NOW, utc)
  assert.equal(v.asOfText, 'as of 09:05')
  assert.equal(v.rows[0].tag, 'stale')
  assert.equal(v.rows[0].valueText, '80%')
  assert.equal(v.chip?.text, '5h 80% · as of 09:05')
  assert.equal(v.chip?.tone, 'stale')
  assert.match(v.headline, /not current/)
})

test('a reading from another day names the day', () => {
  const at = Date.UTC(2026, 10, 24, 22, 10)
  const v = buildObservedLimitsView(payload({ observed: observed(at, true, [{ key: 'five_hour', kind: 'five_hour', usedPct: 5, resetsAt: NOW + H, state: 'stale' }]) }), NOW, utc)
  assert.equal(v.asOfText, 'as of 11-24 22:10')
})

test('expired window: no number, ended tag, never shown as 0%', () => {
  const v = buildObservedLimitsView(payload({ observed: observed(NOW - 10_000, false, [
    { key: 'five_hour', kind: 'five_hour', usedPct: null, resetsAt: NOW - H, state: 'expired' },
    { key: 'seven_day', kind: 'seven_day', usedPct: 10, resetsAt: NOW + 24 * H, state: 'fresh' },
  ]) }), NOW, utc)
  assert.deepEqual(v.rows.map(r => [r.valueText, r.tag, r.fraction]), [['–', 'ended', null], ['10%', 'obs', 0.1]])
  assert.equal(v.rows[0].resetText, 'window ended')
  assert.equal(v.chip?.text, '5h – · wk 10%')
})

test('below 1% uses per mille, like every other limit figure', () => {
  const v = buildObservedLimitsView(payload({ observed: observed(NOW, false, [{ key: 'five_hour', kind: 'five_hour', usedPct: 0.45, resetsAt: NOW + H, state: 'fresh' }]) }), NOW, utc)
  assert.equal(v.rows[0].valueText, '4.5‰')
})

test('an unknown window (a future per-model key) is shown with its own name, not dropped', () => {
  const v = buildObservedLimitsView(payload({ observed: observed(NOW, false, [{ key: 'weekly_model', kind: 'other', usedPct: 12, resetsAt: null, state: 'fresh' }]) }), NOW, utc)
  assert.equal(v.rows[0].label, 'weekly model')
  assert.equal(v.rows[0].resetText, '')
  assert.equal(v.chip?.text, '')
})

test('prompt: not installed and installable from a configurable host', () => {
  const v = buildObservedLimitsView(payload({ install: { state: 'not-installed', canInstall: true } }), NOW, utc)
  assert.equal(v.mode, 'prompt')
  assert.equal(v.canInstall, true)
  assert.equal(v.rows.length, 0)
  assert.equal(v.installHint, null)
  assert.match(v.headline, /Observe your real 5-hour and weekly Claude limits/)
})

test('prompt on the relay: no install button, the command to run is named', () => {
  const v = buildObservedLimitsView(payload({ canConfigure: false, install: { state: 'not-installed', canInstall: true } }), NOW, utc)
  assert.equal(v.canInstall, false)
  assert.match(v.installHint ?? '', /Agent Flow: Configure Claude statusLine/)
})

test('refused: reason is carried, nothing can be installed, limits stay estimated', () => {
  const v = buildObservedLimitsView(payload({ install: { state: 'refused', canInstall: false, reason: 'the statusLine type is "static"', code: 'statusline-not-command' } }), NOW, utc)
  assert.equal(v.mode, 'refused')
  assert.equal(v.canInstall, false)
  assert.match(v.headline, /stay estimated/)
  assert.match(v.chip?.title ?? '', /static/)
})

test('installed, no reading yet: waiting', () => {
  const v = buildObservedLimitsView(payload(), NOW, utc)
  assert.equal(v.mode, 'waiting')
  assert.equal(v.canRemove, true)
  assert.match(v.headline, /terminal UI/)
})

test('broken wrapper is called out and cannot be removed from here', () => {
  const v = buildObservedLimitsView(payload({ install: { state: 'broken', canInstall: false, reason: 'saved original missing' } }), NOW, utc)
  assert.equal(v.mode, 'broken')
  assert.equal(v.canRemove, false)
})

test('a file error is a note, never a number', () => {
  const v = buildObservedLimitsView(payload({ install: { state: 'not-installed', canInstall: true }, fileError: 'the limits file is not valid JSON' }), NOW, utc)
  assert.ok(v.notes.some(n => /not valid JSON/.test(n)))
  assert.equal(v.rows.length, 0)
})

test('shadowing project statusLine is warned about only when installed', () => {
  const sh = { shadowedBy: ['~/proj/.claude/settings.json'] }
  assert.ok(buildObservedLimitsView(payload({ install: { state: 'installed', canInstall: false, ...sh } }), NOW, utc).notes.some(n => /~\/proj/.test(n)))
  assert.equal(buildObservedLimitsView(payload({ install: { state: 'not-installed', canInstall: true, ...sh } }), NOW, utc).notes.length, 0)
})

test('no message yet (older host): nothing actionable, no chip', () => {
  const v = buildObservedLimitsView(null, NOW, utc)
  assert.equal(v.mode, 'unavailable')
  assert.equal(v.chip, null)
  assert.equal(v.canInstall, false)
})

test('formatUntil', () => {
  assert.equal(formatUntil(0), '0m')
  assert.equal(formatUntil(30_000), '<1m')
  assert.equal(formatUntil(45 * 60_000), '45m')
  assert.equal(formatUntil(2 * H), '2h')
  assert.equal(formatUntil(2 * H + 5 * 60_000), '2h 5m')
  assert.equal(formatUntil(3 * 24 * H + 4 * H + 3 * 60_000), '3d 4h')
  assert.equal(formatUntil(NaN), '0m')
})

test('N1: node-missing marker newer than the last reading: clear note, chip says so, last reading still shown', () => {
  const at = Date.UTC(2026, 10, 25, 9, 5)
  const v = buildObservedLimitsView(payload({
    observed: observed(at, true, [{ key: 'five_hour', kind: 'five_hour', usedPct: 80, resetsAt: NOW + H, state: 'stale' }]),
    nodeMissing: { at: NOW - 10 * 60_000 },
  }), NOW, utc)
  assert.match(v.nodeMissingNote ?? '', /wrapper cannot find node \(last tried 14:20\)/)
  assert.match(v.nodeMissingNote ?? '', /last reading, as of 09:05/)
  assert.match(v.headline, /cannot find node/)
  assert.equal(v.chip?.text, '5h 80% · as of 09:05 · no node')
  assert.equal(v.chip?.tone, 'stale')
  assert.equal(v.rows[0].valueText, '80%', 'the stale number stays visible')
  assert.equal(v.notes[0], v.nodeMissingNote)
  assert.deepEqual(v.reinstall, { label: 'Repair wrapper…' })
})

test('N1: node-missing without any reading: estimates stay, chip is "limits: no node"', () => {
  const v = buildObservedLimitsView(payload({ nodeMissing: { at: NOW - 60_000 } }), NOW, utc)
  assert.match(v.headline, /no readings can arrive. Limits stay estimated/)
  assert.equal(v.chip?.text, 'limits: no node')
  assert.equal(v.rows.length, 0)
})

test('N1: a reading newer than the marker clears the note; marker is ignored when not installed', () => {
  const fresh = buildObservedLimitsView(payload({
    observed: observed(NOW - 1000, false, [{ key: 'five_hour', kind: 'five_hour', usedPct: 10, resetsAt: NOW + H, state: 'fresh' }]),
    nodeMissing: { at: NOW - 3_600_000 },
  }), NOW, utc)
  assert.equal(fresh.nodeMissingNote, null); assert.equal(fresh.chip?.text, '5h 10%'); assert.equal(fresh.reinstall, null)
  const off = buildObservedLimitsView(payload({ install: { state: 'not-installed', canInstall: true }, nodeMissing: { at: NOW } }), NOW, utc)
  assert.equal(off.nodeMissingNote, null)
})

test('N1: legacy command: note and an upgrade button (only when the host can configure)', () => {
  const legacy = payload({ install: { state: 'installed', canInstall: false, legacy: true, canUpgrade: true } })
  const v = buildObservedLimitsView(legacy, NOW, utc)
  assert.match(v.notes.join(' '), /old command form/)
  assert.deepEqual(v.reinstall, { label: 'Upgrade wrapper…' })
  assert.equal(v.nodeMissingNote, null)
  assert.equal(buildObservedLimitsView({ ...legacy, canConfigure: false }, NOW, utc).reinstall, null)
  assert.equal(buildObservedLimitsView(payload({ install: { state: 'installed', canInstall: false, legacy: true, canUpgrade: false } }), NOW, utc).reinstall, null)
})
