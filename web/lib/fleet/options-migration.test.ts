import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SOUND_PREF_KEY } from '../canvas-constants'
import { FLEET_SELECTION_KEY } from './fleet-selection'
import { FLEET_TIMELINE_KEY } from './fleet-timeline-pref'
import { LEGACY_KEYS, migrateLegacySettings } from './options-migration'
import { OPTIONS_KEY, defaultOptions, loadOptions, saveOptions } from './options-registry'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v) },
    removeItem: (k: string) => { m.delete(k) },
    m,
  }
}

/** What the app wrote with the four old keys before the options panel existed. */
const OLD = {
  selection: JSON.stringify({ v: 1, off: ['profile:a', 'board:x', 'profile:a'] }),
  timeline: 'hidden',
  cost: JSON.stringify({ unit: 'kwh', cfg: 'money' }),
  sound: 'on',
}
function seeded() {
  return memStorage({
    [FLEET_SELECTION_KEY]: OLD.selection,
    [FLEET_TIMELINE_KEY]: OLD.timeline,
    ['agentFlow.costUnit']: OLD.cost,
    [SOUND_PREF_KEY]: OLD.sound,
  })
}

test('the legacy key names match the ones the old code used', () => {
  assert.equal(LEGACY_KEYS.fleetSelection, FLEET_SELECTION_KEY)
  assert.equal(LEGACY_KEYS.fleetTimeline, FLEET_TIMELINE_KEY)
  assert.equal(LEGACY_KEYS.sound, SOUND_PREF_KEY)
  assert.equal(LEGACY_KEYS.costUnit, 'agentFlow.costUnit')
})

test('seeded old keys are copied into the registry, once', () => {
  const s = seeded()
  const r = migrateLegacySettings(s)
  assert.equal(r.migrated, true)
  assert.equal(r.saved, true)
  assert.deepEqual([...r.imported].sort(), ['costUnit', 'fleetSelection', 'fleetTimeline', 'sound'])
  assert.deepEqual(r.options.fleetDeselected, ['profile:a', 'board:x'])
  assert.equal(r.options.fleetTimelineVisible, false)
  assert.deepEqual(r.options.costUnit, { unit: 'kwh', cfg: 'money' })
  assert.equal(r.options.soundOn, true)
  assert.equal(r.options.legacyMigrated, true)
  // The registry key now holds the same thing, so the next load sees it.
  assert.deepEqual(loadOptions(s), r.options)
  // The block settings were not touched.
  assert.deepEqual(r.options.lingerSeconds, defaultOptions().lingerSeconds)
})

test('the old keys are left in place (deleting them is a later step)', () => {
  const s = seeded()
  migrateLegacySettings(s)
  assert.equal(s.m.get(FLEET_SELECTION_KEY), OLD.selection)
  assert.equal(s.m.get(FLEET_TIMELINE_KEY), OLD.timeline)
  assert.equal(s.m.get('agentFlow.costUnit'), OLD.cost)
  assert.equal(s.m.get(SOUND_PREF_KEY), OLD.sound)
  assert.equal(s.m.size, 5)
})

test('it runs once: a second call changes nothing, even if an old key changed meanwhile', () => {
  const s = seeded()
  const first = migrateLegacySettings(s)
  s.setItem(SOUND_PREF_KEY, 'off')
  s.setItem(FLEET_TIMELINE_KEY, 'visible')
  s.setItem(FLEET_SELECTION_KEY, JSON.stringify({ v: 1, off: ['other'] }))
  const second = migrateLegacySettings(s)
  assert.equal(second.migrated, false)
  assert.deepEqual(second.imported, [])
  assert.deepEqual(second.options, first.options)
  assert.equal(second.options.soundOn, true)
})

test('what the user sets in the panel after the migration is not overwritten by old keys', () => {
  const s = seeded()
  const first = migrateLegacySettings(s)
  const edited = { ...first.options, soundOn: false, fleetDeselected: [] as string[] }
  assert.equal(saveOptions(s, edited), true)
  const again = migrateLegacySettings(s)
  assert.equal(again.options.soundOn, false)
  assert.deepEqual(again.options.fleetDeselected, [])
})

test('no old keys: defaults, marked as migrated, nothing imported', () => {
  const s = memStorage()
  const r = migrateLegacySettings(s)
  assert.equal(r.migrated, true)
  assert.deepEqual(r.imported, [])
  assert.deepEqual(r.options, { ...defaultOptions(), legacyMigrated: true })
  assert.equal(s.m.has(OPTIONS_KEY), true)
})

test('only some old keys: those are copied, the rest stay at their defaults', () => {
  const s = memStorage({ [SOUND_PREF_KEY]: 'on' })
  const r = migrateLegacySettings(s)
  assert.deepEqual(r.imported, ['sound'])
  assert.equal(r.options.soundOn, true)
  assert.equal(r.options.fleetTimelineVisible, true)
  assert.equal(r.options.costUnit, null)
  assert.deepEqual(r.options.fleetDeselected, [])
  const off = migrateLegacySettings(memStorage({ [SOUND_PREF_KEY]: 'off' }))
  assert.equal(off.options.soundOn, false)
})

test('garbled old values do not break it and do not become settings', () => {
  const s = memStorage({
    [FLEET_SELECTION_KEY]: '{not json',
    [FLEET_TIMELINE_KEY]: 'banana',
    ['agentFlow.costUnit']: 'kwh', // the pre-review plain string: no override
    [SOUND_PREF_KEY]: 'maybe',
  })
  const r = migrateLegacySettings(s)
  assert.equal(r.migrated, true)
  assert.deepEqual(r.options.fleetDeselected, [])
  assert.equal(r.options.fleetTimelineVisible, true, 'only an explicit "hidden" hides')
  assert.equal(r.options.costUnit, null)
  assert.equal(r.options.soundOn, false)
  assert.deepEqual(r.imported, ['fleetSelection', 'fleetTimeline', 'sound'])
})

test('a stored list beyond the cap or with oversized ids is trimmed to what the registry accepts', () => {
  const ids = Array.from({ length: 2100 }, (_, i) => `id${i}`)
  const s = memStorage({ [FLEET_SELECTION_KEY]: JSON.stringify({ v: 1, off: [...ids, 'x'.repeat(400)] }) })
  const r = migrateLegacySettings(s)
  assert.ok(r.options.fleetDeselected.length <= 2000)
  assert.equal(r.saved, true, 'what was imported is valid, so it was written')
})

test('a failing write keeps the migrated options in memory and retries next load', () => {
  const m = new Map<string, string>([[SOUND_PREF_KEY, 'on']])
  const failing = { getItem: (k: string) => m.get(k) ?? null, setItem: () => { throw new Error('quota') } }
  const r = migrateLegacySettings(failing)
  assert.equal(r.migrated, true)
  assert.equal(r.saved, false)
  assert.equal(r.options.soundOn, true)
  assert.equal(migrateLegacySettings(failing).migrated, true, 'nothing was saved, so the next load tries again')
})

test('a stored registry with an unknown version is replaced by a migrated one', () => {
  const s = memStorage({ [OPTIONS_KEY]: JSON.stringify({ version: 7, soundOn: false }), [SOUND_PREF_KEY]: 'on' })
  const r = migrateLegacySettings(s)
  assert.equal(r.options.soundOn, true)
  assert.equal(loadOptions(s).legacyMigrated, true)
})

test('no storage and a throwing getItem do not throw', () => {
  assert.equal(migrateLegacySettings(null).migrated, false)
  assert.deepEqual(migrateLegacySettings(undefined).options, defaultOptions())
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  const r = migrateLegacySettings(boom)
  assert.deepEqual(r.options, { ...defaultOptions(), legacyMigrated: true })
  assert.equal(r.saved, false)
})
