import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exceedsPanThreshold, gestureStep, snapshotOf, TOUCH_PAN_THRESHOLD_PX } from './touch-gestures'

const LIMITS = { min: 0.2, max: 4 }
const T = { x: 10, y: 20, scale: 1 }
const approx = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('snapshotOf: no finger, one finger, two fingers (a third is ignored)', () => {
  assert.equal(snapshotOf([]), null)
  assert.deepEqual(snapshotOf([{ x: 5, y: 6 }]), { count: 1, mid: { x: 5, y: 6 }, dist: 0 })
  assert.deepEqual(snapshotOf([{ x: 0, y: 0 }, { x: 30, y: 40 }, { x: 99, y: 99 }]), { count: 2, mid: { x: 15, y: 20 }, dist: 50 })
})

test('one finger pans by its own movement and does not scale', () => {
  const next = gestureStep(T, snapshotOf([{ x: 100, y: 100 }])!, snapshotOf([{ x: 130, y: 90 }])!, LIMITS)
  assert.deepEqual(next, { x: 40, y: 10, scale: 1 })
})

test('a still finger returns the same transform object (no needless camera write)', () => {
  const s = snapshotOf([{ x: 1, y: 1 }])!
  assert.equal(gestureStep(T, s, s, LIMITS), T)
})

test('two fingers moving apart zoom in around their midpoint, which stays fixed on screen', () => {
  const prev = snapshotOf([{ x: 100, y: 100 }, { x: 200, y: 100 }])!
  const next = snapshotOf([{ x: 50, y: 100 }, { x: 250, y: 100 }])!
  const out = gestureStep(T, prev, next, LIMITS)
  approx(out.scale, 2)
  // the world point under the old midpoint (150, 100) is still under the midpoint (150, 100)
  const world = { x: (150 - T.x) / T.scale, y: (100 - T.y) / T.scale }
  approx(world.x * out.scale + out.x, 150)
  approx(world.y * out.scale + out.y, 100)
})

test('two fingers moving together zoom out', () => {
  const prev = snapshotOf([{ x: 50, y: 100 }, { x: 250, y: 100 }])!
  const next = snapshotOf([{ x: 100, y: 100 }, { x: 200, y: 100 }])!
  approx(gestureStep(T, prev, next, LIMITS).scale, 0.5)
})

test('two fingers sliding together without changing the distance pan and keep the scale', () => {
  const prev = snapshotOf([{ x: 100, y: 100 }, { x: 200, y: 100 }])!
  const next = snapshotOf([{ x: 120, y: 130 }, { x: 220, y: 130 }])!
  assert.deepEqual(gestureStep(T, prev, next, LIMITS), { x: 30, y: 50, scale: 1 })
})

test('the pinch is clamped to the zoom limits', () => {
  const prev = snapshotOf([{ x: 100, y: 100 }, { x: 110, y: 100 }])!
  const next = snapshotOf([{ x: 0, y: 100 }, { x: 400, y: 100 }])!
  assert.equal(gestureStep({ x: 0, y: 0, scale: 3 }, prev, next, LIMITS).scale, 4)
  assert.equal(gestureStep({ x: 0, y: 0, scale: 0.21 }, next, prev, LIMITS).scale, 0.2)
})

test('a changed finger count is a re-baseline: the transform does not jump', () => {
  const one = snapshotOf([{ x: 100, y: 100 }])!
  const two = snapshotOf([{ x: 10, y: 10 }, { x: 300, y: 300 }])!
  assert.equal(gestureStep(T, one, two, LIMITS), T)
  assert.equal(gestureStep(T, two, one, LIMITS), T)
})

test('two coincident fingers never produce NaN or Infinity', () => {
  const prev = snapshotOf([{ x: 100, y: 100 }, { x: 100, y: 100 }])!
  const next = snapshotOf([{ x: 90, y: 100 }, { x: 110, y: 100 }])!
  const out = gestureStep(T, prev, next, LIMITS)
  assert.ok(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.scale))
  assert.equal(out.scale, 1)
})

test('exceedsPanThreshold: a tap stays under it, a drag goes over it', () => {
  assert.equal(exceedsPanThreshold({ x: 0, y: 0 }, { x: 3, y: 4 }), false)
  assert.equal(exceedsPanThreshold({ x: 0, y: 0 }, { x: TOUCH_PAN_THRESHOLD_PX + 1, y: 0 }), true)
})
