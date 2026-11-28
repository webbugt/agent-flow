import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  buildViewSearch, parseBinaryValue, parseViewParams, parseViewValue, resolveStartView, restoreViewOption, VIEW_URL_SPECS,
} from './url-view'
import { commitChange, replaceUrlState, type UrlTarget } from './url-sync'

test('parseViewValue: 1/on/true are on, 0/off/false are off, anything else is unset', () => {
  assert.equal(parseViewValue('1'), true)
  assert.equal(parseViewValue('on'), true)
  assert.equal(parseViewValue('TRUE'), true)
  assert.equal(parseViewValue(' 0 '), false)
  assert.equal(parseViewValue('off'), false)
  assert.equal(parseViewValue('false'), false)
  assert.equal(parseViewValue('yes'), undefined)
  assert.equal(parseViewValue(''), undefined)
  assert.equal(parseViewValue(null), undefined)
  assert.equal(parseViewValue(undefined), undefined)
})

test('parseViewParams reads fleet and screensaver, with or without the leading ?', () => {
  assert.deepEqual(parseViewParams('?fleet=1&screensaver=0'), { fleet: true, screensaver: false })
  assert.deepEqual(parseViewParams('screensaver=on'), { screensaver: true })
  assert.deepEqual(parseViewParams('?shot=1&stress=heavy'), {})
  assert.deepEqual(parseViewParams(''), {})
  assert.deepEqual(parseViewParams(undefined), {})
})

test('an unrecognised value is ignored, so the stored choice applies', () => {
  assert.deepEqual(parseViewParams('?fleet=maybe'), {})
  assert.deepEqual(parseViewParams('?fleet'), {})
})


const off = { fleet: false, screensaver: false, anchorMode: false }

test('buildViewSearch writes every parameter as 1/0 and keeps other parameters', () => {
  assert.equal(buildViewSearch('', { fleet: true, screensaver: false, anchorMode: true }), '?fleet=1&screensaver=0&anchorMode=1')
  assert.equal(buildViewSearch('?shot=1', { ...off, fleet: false, screensaver: true }), '?shot=1&fleet=0&screensaver=1&anchorMode=0')
  // an existing value is replaced, not duplicated
  assert.equal(buildViewSearch('?fleet=0&screensaver=0&anchorMode=0', { fleet: true, screensaver: true, anchorMode: true }), '?fleet=1&screensaver=1&anchorMode=1')
  assert.equal(buildViewSearch(null, off), '?fleet=0&screensaver=0&anchorMode=0')
})

test('buildViewSearch is stable: a second call with the same state returns the same string', () => {
  const once = buildViewSearch('?shot=1', { fleet: true, screensaver: false, anchorMode: true })
  assert.equal(buildViewSearch(once, { fleet: true, screensaver: false, anchorMode: true }), once)
})

test('the URL wins over the stored choice; the stored choice fills in what the URL does not name', () => {
  const stored = { fleet: false, screensaver: true, anchorMode: false }
  assert.deepEqual(resolveStartView(stored, {}), stored)
  assert.deepEqual(resolveStartView(stored, { fleet: true }), { fleet: true, screensaver: true, anchorMode: false })
  assert.deepEqual(resolveStartView(stored, { screensaver: false }), { fleet: false, screensaver: false, anchorMode: false })
  assert.deepEqual(resolveStartView(stored, { anchorMode: true }), { fleet: false, screensaver: true, anchorMode: true })
  assert.deepEqual(resolveStartView(stored, { fleet: true, screensaver: false, anchorMode: true }), { fleet: true, screensaver: false, anchorMode: true })
})

// ---- anchorMode: standard values are 0 and 1 only ----

test('anchorMode=1 is on and anchorMode=0 is off', () => {
  assert.deepEqual(parseViewParams('?anchorMode=1'), { anchorMode: true })
  assert.deepEqual(parseViewParams('?anchorMode=0'), { anchorMode: false })
  assert.deepEqual(parseViewParams('anchorMode=1&fleet=0'), { fleet: false, anchorMode: true })
})

test('anchorMode with any other value is ignored (no error): yes, 2, true, on, empty, wrong case of the key', () => {
  for (const q of ['?anchorMode=yes', '?anchorMode=2', '?anchorMode=true', '?anchorMode=on', '?anchorMode=', '?anchorMode', '?anchorMode=-1', '?anchorMode=01', '?anchormode=1']) {
    assert.deepEqual(parseViewParams(q), {}, q)
  }
  assert.equal(parseBinaryValue('yes'), undefined)
  assert.equal(parseBinaryValue('2'), undefined)
  assert.equal(parseBinaryValue(null), undefined)
  // an invalid value falls back to the stored one
  assert.deepEqual(resolveStartView({ ...off, anchorMode: true }, parseViewParams('?anchorMode=yes')), { ...off, anchorMode: true })
  assert.deepEqual(resolveStartView(off, parseViewParams('?anchorMode=2')), off)
})

test('the default stays off: no URL value and nothing stored gives anchorMode false', () => {
  assert.deepEqual(resolveStartView(off, parseViewParams('')), off)
})

// ---- load: URL wins, storage is filled in or kept in sync ----

test('restoreViewOption: a valid URL value wins over storage and is saved when it differs', () => {
  const saved: boolean[] = []
  assert.equal(restoreViewOption('?anchorMode=1', 'anchorMode', false, v => saved.push(v)), true)
  assert.deepEqual(saved, [true])
  assert.equal(restoreViewOption('?anchorMode=0', 'anchorMode', true, v => saved.push(v)), false)
  assert.deepEqual(saved, [true, false])
  // the URL agrees with storage: nothing to write
  assert.equal(restoreViewOption('?anchorMode=1', 'anchorMode', true, v => saved.push(v)), true)
  assert.deepEqual(saved, [true, false])
})

test('restoreViewOption: a missing or invalid URL value keeps the stored value and writes nothing', () => {
  const saved: boolean[] = []
  assert.equal(restoreViewOption('', 'anchorMode', true, v => saved.push(v)), true)
  assert.equal(restoreViewOption('?anchorMode=yes', 'anchorMode', true, v => saved.push(v)), true)
  assert.equal(restoreViewOption('?anchorMode=2', 'anchorMode', false, v => saved.push(v)), false)
  assert.equal(restoreViewOption('?fleet=1', 'anchorMode', true, v => saved.push(v)), true)
  assert.deepEqual(saved, [])
})

test('restoreViewOption works for fleet and screensaver with their on/off/true/false values', () => {
  const saved: boolean[] = []
  assert.equal(restoreViewOption('?fleet=on', 'fleet', false, v => saved.push(v)), true)
  assert.equal(restoreViewOption('?screensaver=false', 'screensaver', true, v => saved.push(v)), false)
  assert.deepEqual(saved, [true, false])
})

// ---- address bar: missing keys appended from the active state, change writes URL and storage ----

function fakeWindow(search: string, hash = ''): UrlTarget & { calls: string[]; location: { pathname: string; search: string; hash: string } } {
  const calls: string[] = []
  const location = { pathname: '/app', search, hash }
  return {
    calls,
    location,
    history: {
      state: { __next: 1 },
      replaceState(state, _unused, url) {
        assert.deepEqual(state, { __next: 1 }, 'the history state is kept')
        calls.push(String(url))
        const u = new URL(String(url), 'http://x')
        location.search = u.search
      },
    },
  }
}

test('missing URL keys are appended from the active state, other parameters and the hash are kept', () => {
  const w = fakeWindow('?shot=1', '#top')
  assert.equal(replaceUrlState(w, { fleet: false, screensaver: true, anchorMode: true }, VIEW_URL_SPECS), true)
  assert.deepEqual(w.calls, ['/app?shot=1&fleet=0&screensaver=1&anchorMode=1#top'])
  // already says the same: no second replaceState
  assert.equal(replaceUrlState(w, { fleet: false, screensaver: true, anchorMode: true }, VIEW_URL_SPECS), false)
  assert.equal(w.calls.length, 1)
})

test('an invalid URL value is replaced by the active state in the address bar', () => {
  const w = fakeWindow('?anchorMode=yes&fleet=1&screensaver=0')
  assert.equal(replaceUrlState(w, { fleet: true, screensaver: false, anchorMode: true }, VIEW_URL_SPECS), true)
  assert.deepEqual(w.calls, ['/app?anchorMode=1&fleet=1&screensaver=0'])
})

test('an option change writes the URL (replaceState) and storage', () => {
  const w = fakeWindow('?anchorMode=0&fleet=0&screensaver=0')
  const store: Record<string, string> = { anchorMode: '0' }
  const persist = { anchorMode: (v: boolean) => { store.anchorMode = v ? '1' : '0' } }
  const state = { fleet: false, screensaver: false, anchorMode: true }
  assert.equal(commitChange(w, state, 'anchorMode', VIEW_URL_SPECS, persist), true)
  assert.equal(store.anchorMode, '1')
  assert.deepEqual(w.calls, ['/app?anchorMode=1&fleet=0&screensaver=0'])
  assert.deepEqual(parseViewParams(w.location.search), state)
  // and back to 0
  assert.equal(commitChange(w, { ...state, anchorMode: false }, 'anchorMode', VIEW_URL_SPECS, persist), true)
  assert.equal(store.anchorMode, '0')
  assert.equal(w.calls.length, 2)
  assert.equal(new URL(w.calls[1], 'http://x').searchParams.get('anchorMode'), '0')
})
