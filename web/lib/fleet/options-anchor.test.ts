import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DEFAULT_PROFILE_PALETTE, MAX_PALETTE_COLORS, applyOptionsPatch, defaultOptions, loadOptions, parseOptions, saveOptions, validateOptions,
} from './options-registry'

function memStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
}

test('R8: resource-anchor mode is off by default; the default palette is the shipped one, no overrides', () => {
  const d = defaultOptions()
  assert.equal(d.anchorMode, false)
  assert.deepEqual(d.profilePalette, [...DEFAULT_PROFILE_PALETTE])
  assert.deepEqual(d.profileColors, {})
  assert.notEqual(d.profilePalette, defaultOptions().profilePalette, 'a fresh array each time')
  for (const c of d.profilePalette) assert.match(c, /^#[0-9a-f]{6}$/)
})

test('R1: the mode, the palette and the overrides round-trip through save and load (persisted per browser)', () => {
  const s = memStorage()
  const o = defaultOptions()
  o.anchorMode = true
  o.profilePalette = ['#112233', '#aabbcc', '#00ff00']
  o.profileColors = { taxis: '#ff0000' }
  assert.equal(saveOptions(s, o), true)
  assert.deepEqual(loadOptions(s), o)
})

test('an old stored value without the anchor fields still loads, with the defaults', () => {
  const o = parseOptions(JSON.stringify({ version: 1, soundOn: true }))
  assert.equal(o.soundOn, true)
  assert.equal(o.anchorMode, false)
  assert.deepEqual(o.profilePalette, [...DEFAULT_PROFILE_PALETTE])
})

test('bad anchor values fall back per field', () => {
  const o = parseOptions(JSON.stringify({ version: 1, anchorMode: 'yes', profilePalette: ['red'], profileColors: { a: 'nope' }, soundOn: true }))
  assert.equal(o.anchorMode, false)
  assert.deepEqual(o.profilePalette, [...DEFAULT_PROFILE_PALETTE])
  assert.deepEqual(o.profileColors, {})
  assert.equal(o.soundOn, true)
  assert.equal(validateOptions({ version: 1, anchorMode: 1, profilePalette: 'x', profileColors: [] }).errors.length, 3)
})

test('palette: 1 to MAX hex codes, normalised to lower case', () => {
  assert.equal(validateOptions({ version: 1, profilePalette: [] }).errors.length, 1)
  assert.equal(validateOptions({ version: 1, profilePalette: Array(MAX_PALETTE_COLORS + 1).fill('#ffffff') }).errors.length, 1)
  assert.equal(validateOptions({ version: 1, profilePalette: ['#FFAA00'] }).errors.length, 0)
  assert.deepEqual(parseOptions(JSON.stringify({ version: 1, profilePalette: ['#FFAA00', '#00bbCC'] })).profilePalette, ['#ffaa00', '#00bbcc'])
  for (const bad of ['#fff', 'ffffff', '#gggggg', '#ffffff80', 5, null]) {
    assert.equal(validateOptions({ version: 1, profilePalette: [bad] }).errors.length, 1, String(bad))
  }
})

test('patch: toggle the mode, replace the palette, set and clear a profile colour; a bad patch changes nothing', () => {
  const cur = defaultOptions()
  const on = applyOptionsPatch(cur, { anchorMode: true })
  assert.ok(on.ok && on.options.anchorMode === true)
  const pal = applyOptionsPatch(cur, { profilePalette: ['#010203', '#040506'] })
  assert.ok(pal.ok && pal.options.profilePalette.length === 2)
  const set = applyOptionsPatch(cur, { profileColors: { ' Taxis ': '#FF0000' } })
  assert.ok(set.ok)
  if (set.ok) {
    assert.deepEqual(set.options.profileColors, { taxis: '#ff0000' }, 'keyed by trimmed lower-case name')
    const cleared = applyOptionsPatch(set.options, { profileColors: {} })
    assert.ok(cleared.ok && Object.keys(cleared.options.profileColors).length === 0)
  }
  const bad = applyOptionsPatch(cur, { profilePalette: ['nope'], anchorMode: 'x' as never })
  assert.equal(bad.ok, false)
  assert.deepEqual(cur, defaultOptions(), 'the current options are not touched')
})
