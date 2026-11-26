import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { swallowGesture, SWALLOW_GESTURE_MS, type SwallowTimer } from './swallow-gesture'

function fakeTimer() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const timer: SwallowTimer = {
    set: (fn, ms) => { const id = next++; pending.set(id, { fn, ms }); return id },
    clear: id => { pending.delete(id as number) },
  }
  return { timer, pending, fire: () => { for (const [id, p] of [...pending]) { pending.delete(id); p.fn() } } }
}

/** Dispatches `type` on a target that has a bubbling "page" listener after the guard; returns whether the page saw it. */
function reachesPage(target: EventTarget, type: string): boolean {
  let seen = false
  const page = () => { seen = true }
  target.addEventListener(type, page) // bubble phase, like React's root listener
  target.dispatchEvent(new Event(type, { cancelable: true }))
  target.removeEventListener(type, page)
  return seen
}

test('swallowGesture stops mousedown, mouseup and click of the press (selection runs on mouseup)', () => {
  const t = new EventTarget(); const { timer } = fakeTimer()
  swallowGesture(t, timer)
  assert.equal(reachesPage(t, 'mousedown'), false)
  assert.equal(reachesPage(t, 'mouseup'), false)
  assert.equal(reachesPage(t, 'click'), false)
})

test('swallowGesture stops swallowing after the click, so the next press works', () => {
  const t = new EventTarget(); const { timer, pending } = fakeTimer()
  swallowGesture(t, timer)
  reachesPage(t, 'mousedown'); reachesPage(t, 'mouseup'); reachesPage(t, 'click')
  assert.equal(pending.size, 0)
  assert.equal(reachesPage(t, 'mousedown'), true)
  assert.equal(reachesPage(t, 'mouseup'), true)
  assert.equal(reachesPage(t, 'click'), true)
})

test('swallowGesture stops by itself when no click arrives', () => {
  const t = new EventTarget(); const { timer, pending, fire } = fakeTimer()
  swallowGesture(t, timer)
  assert.equal([...pending.values()][0].ms, SWALLOW_GESTURE_MS)
  fire()
  assert.equal(reachesPage(t, 'mousedown'), true)
})

test('swallowGesture does not swallow other events (keys, wheel, mousemove)', () => {
  const t = new EventTarget(); const { timer } = fakeTimer()
  swallowGesture(t, timer)
  assert.equal(reachesPage(t, 'keydown'), true)
  assert.equal(reachesPage(t, 'wheel'), true)
  assert.equal(reachesPage(t, 'mousemove'), true)
})

test('swallowGesture: the returned stop function ends it at once and is idempotent', () => {
  const t = new EventTarget(); const { timer } = fakeTimer()
  const stop = swallowGesture(t, timer)
  stop(); stop()
  assert.equal(reachesPage(t, 'mouseup'), true)
})
