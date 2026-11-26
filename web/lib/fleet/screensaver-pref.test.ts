import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SCREENSAVER_KEY, loadScreensaver, parseScreensaver, saveScreensaver, shouldExitScreensaver } from './screensaver-pref'

function memStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, m }
}

test('default is off; only an explicit "on" turns it on', () => {
  assert.equal(loadScreensaver(memStorage()), false)
  assert.equal(loadScreensaver(null), false)
  assert.equal(parseScreensaver('garbage'), false)
  assert.equal(parseScreensaver('off'), false)
  assert.equal(parseScreensaver('on'), true)
})

test('it stays on across a reload only when the user enabled it, and leaving it clears it', () => {
  const s = memStorage()
  // user enables it -> a "reload" (new load from the same storage) sees it on
  assert.equal(saveScreensaver(s, true), true)
  assert.equal(s.m.get(SCREENSAVER_KEY), 'on')
  assert.equal(loadScreensaver(s), true)
  // any key / click leaves it -> the next reload starts normal
  saveScreensaver(s, false)
  assert.equal(s.m.get(SCREENSAVER_KEY), 'off')
  assert.equal(loadScreensaver(s), false)
})

test('broken storage does not throw: load falls back to off, save reports failure', () => {
  const boom = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
  assert.equal(loadScreensaver(boom), false)
  assert.equal(saveScreensaver(boom, true), false)
  assert.equal(saveScreensaver(null, true), false)
})

test('any key or click leaves the mode; a lone modifier does not', () => {
  const t0 = 1000
  const at = (type: string, key?: string, timeStamp = t0 + 50) => shouldExitScreensaver({ type, key, timeStamp }, t0)
  assert.equal(at('keydown', 'a'), true)
  assert.equal(at('keydown', ' '), true)
  assert.equal(at('keydown', 'Escape'), true)
  assert.equal(at('keydown', 's'), true, 's leaves it too (it is a toggle)')
  assert.equal(at('pointerdown'), true)
  for (const k of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) assert.equal(at('keydown', k), false, k)
  assert.equal(at('keydown'), false, 'no key name')
  assert.equal(at('pointermove'), false, 'moving the mouse does not leave it')
  assert.equal(at('wheel'), false, 'zooming does not leave it')
})

test('the press that entered the mode does not leave it again', () => {
  const enteredAt = 5000
  // the click on the button / the "s" key began before the mode was on
  assert.equal(shouldExitScreensaver({ type: 'pointerdown', timeStamp: 4990 }, enteredAt), false)
  assert.equal(shouldExitScreensaver({ type: 'keydown', key: 's', timeStamp: 4999 }, enteredAt), false)
  // the next press does
  assert.equal(shouldExitScreensaver({ type: 'keydown', key: 'x', timeStamp: 5100 }, enteredAt), true)
})
