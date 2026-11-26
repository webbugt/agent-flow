import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  FLEET_TIMELINE_INSET, FLEET_TIMELINE_KEY, PLAYBACK_BAR_INSET, loadTimelineVisible, mapInsetBottom, parseTimelineVisible, saveTimelineVisible,
} from './fleet-timeline-pref'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) }, m }
}

test('default is visible; only an explicit "hidden" hides', () => {
  assert.equal(loadTimelineVisible(memStorage()), true)
  assert.equal(loadTimelineVisible(null), true)
  assert.equal(parseTimelineVisible('garbage'), true)
  assert.equal(parseTimelineVisible('hidden'), false)
})

test('the choice is persisted and read back', () => {
  const s = memStorage()
  assert.equal(saveTimelineVisible(s, false), true)
  assert.equal(s.m.get(FLEET_TIMELINE_KEY), 'hidden')
  assert.equal(loadTimelineVisible(s), false)
  saveTimelineVisible(s, true)
  assert.equal(loadTimelineVisible(s), true)
})

test('broken storage does not throw: load falls back to visible, save reports failure', () => {
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') }, removeItem: () => {} }
  assert.equal(loadTimelineVisible(boom), true)
  assert.equal(saveTimelineVisible(boom, false), false)
  assert.equal(saveTimelineVisible(null, false), false)
})

test('hidden timeline: the map gives back the panel space and keeps only the playback bar clear', () => {
  assert.equal(mapInsetBottom(true), FLEET_TIMELINE_INSET)
  assert.equal(mapInsetBottom(true), 380, 'the value the layout used before')
  assert.equal(mapInsetBottom(false), PLAYBACK_BAR_INSET)
  assert.ok(mapInsetBottom(false) < mapInsetBottom(true) / 4, 'the map is much taller when hidden')
})
