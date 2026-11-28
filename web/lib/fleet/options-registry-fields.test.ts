import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  MAX_DESELECTED_IDS, OPTIONS_KEY, OPTIONS_VERSION, applyOptionsPatch, defaultOptions, loadOptions, parseOptions, saveOptions, validateOptions,
} from './options-registry'
import { recordUse } from './resource-block'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

test('defaults of the consolidated settings: sound off, timeline shown, no cost choice, nothing hidden, not migrated', () => {
  const d = defaultOptions()
  assert.equal(d.soundOn, false)
  assert.equal(d.fleetTimelineVisible, true)
  assert.equal(d.costUnit, null)
  assert.deepEqual(d.fleetDeselected, [])
  assert.equal(d.legacyMigrated, false)
  assert.equal(defaultOptions().fleetDeselected === d.fleetDeselected, false, 'a fresh list each time')
})

test('the consolidated settings round-trip through save and load, in the one key', () => {
  const s = memStorage()
  const o = defaultOptions()
  o.soundOn = true
  o.fleetTimelineVisible = false
  o.costUnit = { unit: 'kwh', cfg: 'auto' }
  o.fleetDeselected = ['a', 'b']
  o.legacyMigrated = true
  assert.equal(saveOptions(s, o), true)
  assert.deepEqual([...s.m.keys()], [OPTIONS_KEY])
  assert.deepEqual(loadOptions(s), o)
})

test('bad consolidated values fall back per field and keep the good ones', () => {
  const o = parseOptions(JSON.stringify({
    version: 1, soundOn: 'yes', fleetTimelineVisible: false,
    costUnit: { unit: 'euro', cfg: 'auto' }, fleetDeselected: ['ok', 3], legacyMigrated: 1,
  }))
  assert.equal(o.soundOn, false)
  assert.equal(o.fleetTimelineVisible, false)
  assert.equal(o.costUnit, null)
  assert.deepEqual(o.fleetDeselected, [])
  assert.equal(o.legacyMigrated, false)
  const r = validateOptions({ version: 1, soundOn: 1, costUnit: 'kwh', fleetDeselected: 'a' })
  assert.equal(r.errors.length, 3)
})

test('a stored list of hidden ids is de-duplicated and capped by validation', () => {
  assert.deepEqual(parseOptions(JSON.stringify({ version: 1, fleetDeselected: ['a', 'b', 'a'] })).fleetDeselected, ['a', 'b'])
  const tooMany = Array.from({ length: MAX_DESELECTED_IDS + 1 }, (_, i) => `id${i}`)
  assert.equal(validateOptions({ version: 1, fleetDeselected: tooMany }).errors.length, 1)
  assert.equal(validateOptions({ version: 1, fleetDeselected: [''] }).errors.length, 1)
  assert.equal(validateOptions({ version: 1, fleetDeselected: ['x'.repeat(301)] }).errors.length, 1)
})

test('C1 finding: a wrong or missing version gives the defaults, not the valid fields', () => {
  const body = { lingerSeconds: { bash: 7 }, soundOn: true }
  for (const v of [{ ...body, version: 2 }, { ...body, version: '1' }, { ...body }]) {
    const r = validateOptions(v)
    assert.deepEqual(r.options, defaultOptions(), JSON.stringify(v))
    assert.equal(r.errors.length, 1)
    assert.match(r.errors[0], /version must be 1/)
  }
  assert.deepEqual(parseOptions(JSON.stringify({ ...body, version: 2 })), defaultOptions())
})

test('C1 finding: a patch section that is not an object is rejected, not silently ignored', () => {
  const cur = defaultOptions()
  const bad: unknown[] = [
    { lingerSeconds: 5 }, { lingerSeconds: 'x' }, { lingerSeconds: [] }, { lingerSeconds: null },
    { show: 5 }, { show: null }, { show: { fleet: 5 } }, { show: { fleet: null } }, { show: { single: [] } },
  ]
  for (const p of bad) {
    const r = applyOptionsPatch(cur, p as never)
    assert.equal(r.ok, false, JSON.stringify(p))
  }
  assert.deepEqual(cur, defaultOptions())
})

test('patching the consolidated settings: valid values apply, bad ones reject the whole patch', () => {
  const cur = defaultOptions()
  const r = applyOptionsPatch(cur, { soundOn: true, fleetTimelineVisible: false, costUnit: { unit: 'tokens', cfg: 'money' }, fleetDeselected: ['x', 'y', 'x'] })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.options.soundOn, true)
  assert.equal(r.options.fleetTimelineVisible, false)
  assert.deepEqual(r.options.costUnit, { unit: 'tokens', cfg: 'money' })
  assert.deepEqual(r.options.fleetDeselected, ['x', 'y'])
  assert.deepEqual(cur, defaultOptions())
  const back = applyOptionsPatch(r.options, { costUnit: null })
  assert.equal(back.ok && back.options.costUnit, null)
  for (const p of [
    { soundOn: 'on' }, { fleetTimelineVisible: 1 }, { costUnit: 'kwh' }, { costUnit: { unit: 'kwh' } },
    { costUnit: { unit: 'auto', cfg: 'auto' } }, { fleetDeselected: 'a' }, { fleetDeselected: [1] },
  ]) {
    assert.equal(applyOptionsPatch(cur, p as never).ok, false, JSON.stringify(p))
  }
})

test('screensaverAutoFit: default true (screensaver zoom stays on unless switched off)', () => {
  assert.equal(defaultOptions().screensaverAutoFit, true)
  assert.equal(parseOptions(null).screensaverAutoFit, true)
  assert.equal(loadOptions(memStorage()).screensaverAutoFit, true)
  assert.equal(validateOptions(null).options.screensaverAutoFit, true)
})

test('screensaverAutoFit: strict patch accepts booleans and rejects anything else, applying nothing', () => {
  const cur = defaultOptions()
  const off = applyOptionsPatch(cur, { screensaverAutoFit: false })
  assert.equal(off.ok && off.options.screensaverAutoFit, false)
  assert.equal(cur.screensaverAutoFit, true, 'the input object is not mutated')
  const on = off.ok ? applyOptionsPatch(off.options, { screensaverAutoFit: true }) : off
  assert.equal(on.ok && on.options.screensaverAutoFit, true)
  for (const bad of ['true', 'false', 0, 1, null, {}, []]) {
    const r = applyOptionsPatch(cur, { screensaverAutoFit: bad, soundOn: true })
    assert.equal(r.ok, false, JSON.stringify(bad))
    if (!r.ok) assert.deepEqual(r.errors, ['screensaverAutoFit must be true or false'])
  }
  // a patch for another field keeps the stored value
  const other = applyOptionsPatch({ ...cur, screensaverAutoFit: false }, { soundOn: true })
  assert.equal(other.ok && other.options.screensaverAutoFit, false)
})

test('screensaverAutoFit: strict parse - a non-boolean is reported and falls back to the default, the rest is kept', () => {
  for (const bad of ['no', 0, null, [], {}]) {
    const r = validateOptions({ version: 1, soundOn: true, screensaverAutoFit: bad })
    assert.deepEqual(r.errors, ['screensaverAutoFit must be true or false'], JSON.stringify(bad))
    assert.equal(r.options.screensaverAutoFit, true)
    assert.equal(r.options.soundOn, true)
  }
  assert.equal(validateOptions({ version: 1, screensaverAutoFit: false }).options.screensaverAutoFit, false)
  assert.equal(validateOptions({ version: 1, screensaverAutoFit: false }).errors.length, 0)
})

test('screensaverAutoFit: round trip through save and load, in the one key', () => {
  const s = memStorage()
  const o = defaultOptions()
  o.screensaverAutoFit = false
  assert.equal(saveOptions(s, o), true)
  assert.deepEqual([...s.m.keys()], [OPTIONS_KEY])
  assert.equal(JSON.parse(s.m.get(OPTIONS_KEY)!).screensaverAutoFit, false)
  assert.equal(loadOptions(s).screensaverAutoFit, false)
  assert.deepEqual(loadOptions(s), o)
  const back = { ...o, screensaverAutoFit: true }
  assert.equal(saveOptions(s, back), true)
  assert.equal(loadOptions(s).screensaverAutoFit, true)
})

test('screensaverAutoFit: saveOptions refuses a non-boolean (nothing written)', () => {
  const s = memStorage()
  assert.equal(saveOptions(s, { ...defaultOptions(), screensaverAutoFit: 'yes' as never }), false)
  assert.equal(s.m.size, 0)
})

test('screensaverAutoFit: an options object stored before the field existed (same version 1) loads with the default and keeps its other values', () => {
  const old = {
    version: 1, lingerSeconds: { kanban: 5, memory: 60, bash: 20, subsystem: 45 }, fadeSeconds: 15,
    show: { single: { kanban: true, memory: true, bash: true, subsystem: true }, fleet: { kanban: false, memory: true, bash: true, subsystem: true } },
    soundOn: true, fleetTimelineVisible: false, costUnit: null, fleetDeselected: ['a'], legacyMigrated: true,
  }
  assert.equal('screensaverAutoFit' in old, false)
  const s = memStorage({ [OPTIONS_KEY]: JSON.stringify(old) })
  const loaded = loadOptions(s)
  assert.equal(loaded.screensaverAutoFit, true)
  assert.equal(loaded.soundOn, true)
  assert.equal(loaded.fleetTimelineVisible, false)
  assert.equal(loaded.lingerSeconds.kanban, 5)
  assert.equal(loaded.show.fleet.kanban, false)
  assert.deepEqual(loaded.fleetDeselected, ['a'])
  assert.equal(loaded.legacyMigrated, true)
  assert.deepEqual(validateOptions(old).errors, [])
  // the version did not change, so the old object is not treated as unknown
  assert.equal(OPTIONS_VERSION, 1)
})

test('legacyMigrated is not patchable (only the migration sets it)', () => {
  const r = applyOptionsPatch(defaultOptions(), { legacyMigrated: true } as never)
  assert.equal(r.ok && r.options.legacyMigrated, false)
})

test('a patch keeps the identity of what it did not change (so consumers can compare cheaply)', () => {
  const cur = defaultOptions()
  cur.fleetDeselected = ['a']
  cur.costUnit = { unit: 'money', cfg: 'auto' }
  const r = applyOptionsPatch(cur, { lingerSeconds: { bash: 5 } })
  assert.equal(r.ok, true)
  if (!r.ok) return
  assert.equal(r.options.fleetDeselected, cur.fleetDeselected)
  assert.equal(r.options.costUnit, cur.costUnit)
  const same = applyOptionsPatch(cur, { fleetDeselected: ['a'], costUnit: { unit: 'money', cfg: 'auto' } })
  assert.equal(same.ok, true)
  if (!same.ok) return
  assert.equal(same.options.fleetDeselected, cur.fleetDeselected, 'an equal list keeps the old array')
  assert.equal(same.options.costUnit, cur.costUnit, 'an equal choice keeps the old object')
  const changed = applyOptionsPatch(cur, { fleetDeselected: ['a', 'b'] })
  assert.equal(changed.ok && changed.options.fleetDeselected !== cur.fleetDeselected, true)
})

test('C1 finding: a block label is capped at 200 characters', () => {
  const s = recordUse(new Map(), { kind: 'bash', key: 'git', label: 'x'.repeat(5000), at: 1 })
  assert.equal(s.get('bash:git')!.label.length, 200)
  const kept = recordUse(s, { kind: 'bash', key: 'git', at: 2 })
  assert.equal(kept.get('bash:git')!.label.length, 200)
})
