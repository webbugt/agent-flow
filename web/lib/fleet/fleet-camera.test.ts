import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { BUTTON_ZOOM_STEP, FLEET_WHEEL_STEP, REFIT_SIZE_THRESHOLD, shouldRefit, wheelZoomFactor, zoomAt, type FitBasis } from './fleet-camera'

const LIMITS = { min: 0.2, max: 4 }
const base: FitBasis = { nodeCount: 8, width: 1200, height: 700 }

// ─── re-fit rule ────────────────────────────────────────────────────────────

test('first load fits once there are nodes and a measured area', () => {
  assert.equal(shouldRefit(null, base, false), true)
  assert.equal(shouldRefit(null, base, true), true)
  assert.equal(shouldRefit(null, { ...base, nodeCount: 0 }, false), false, 'nothing to fit yet')
  assert.equal(shouldRefit(null, { ...base, width: 0 }, false), false, 'not measured yet')
  assert.equal(shouldRefit({ ...base, nodeCount: 0 }, base, false), true, 'first nodes after an empty map')
})

test('no re-fit when only node ids churn (same count, same area), e.g. on a poll or clock tick', () => {
  // The rule only sees count and size, so any number of id-different rebuilds with the same count do nothing.
  for (let i = 0; i < 50; i++) assert.equal(shouldRefit(base, { ...base }, false), false)
  assert.equal(shouldRefit(base, { ...base }, true), false)
})

test('re-fit when the node count changes (user has not moved the camera)', () => {
  assert.equal(shouldRefit(base, { ...base, nodeCount: 9 }, false), true)
  assert.equal(shouldRefit(base, { ...base, nodeCount: 7 }, false), true)
})

test('re-fit when the free area changes by more than the threshold, in either direction', () => {
  assert.equal(shouldRefit(base, { ...base, width: base.width + REFIT_SIZE_THRESHOLD + 1 }, false), true)
  assert.equal(shouldRefit(base, { ...base, height: base.height - REFIT_SIZE_THRESHOLD - 1 }, false), true)
  assert.equal(shouldRefit(base, { ...base, width: base.width - 400 }, false), true, 'session detail opened')
})

test('small area jitter at or below the threshold does not re-fit', () => {
  assert.equal(shouldRefit(base, { ...base, width: base.width + REFIT_SIZE_THRESHOLD }, false), false)
  assert.equal(shouldRefit(base, { ...base, height: base.height - 3 }, false), false)
})

test('once the user zoomed or panned, a poll that adds nodes or resizes the area does not re-fit', () => {
  assert.equal(shouldRefit(base, { ...base, nodeCount: 12 }, true), false)
  assert.equal(shouldRefit(base, { ...base, width: 700 }, true), false)
})

// ─── zoom centred on the pointer ────────────────────────────────────────────

test('zoom keeps the world point under the pointer fixed on screen', () => {
  const t = { x: 120, y: -40, scale: 0.8 }
  const px = 500, py = 300
  const world = { x: (px - t.x) / t.scale, y: (py - t.y) / t.scale }
  const z = zoomAt(t, px, py, 1.08 * 1.08, LIMITS)
  assert.ok(z.scale > t.scale)
  assert.ok(Math.abs(world.x * z.scale + z.x - px) < 1e-9)
  assert.ok(Math.abs(world.y * z.scale + z.y - py) < 1e-9)
  // and zooming out again around the same pointer restores the camera
  const back = zoomAt(z, px, py, t.scale / z.scale, LIMITS)
  assert.ok(Math.abs(back.x - t.x) < 1e-9 && Math.abs(back.y - t.y) < 1e-9 && Math.abs(back.scale - t.scale) < 1e-12)
})

test('zoom at the origin only changes the scale', () => {
  const z = zoomAt({ x: 0, y: 0, scale: 1 }, 0, 0, 2, LIMITS)
  assert.deepEqual(z, { x: 0, y: 0, scale: 2 })
})

test('camera limits are kept: scale is clamped, and at a limit nothing moves', () => {
  const t = { x: 10, y: 20, scale: 3.9 }
  const z = zoomAt(t, 300, 200, 2, LIMITS)
  assert.equal(z.scale, LIMITS.max)
  // still centred on the pointer while clamped
  assert.ok(Math.abs(((300 - t.x) / t.scale) - ((300 - z.x) / z.scale)) < 1e-9)
  const atMax = { x: 5, y: 6, scale: LIMITS.max }
  assert.equal(zoomAt(atMax, 100, 100, 1.5, LIMITS), atMax)
  const atMin = { x: 5, y: 6, scale: LIMITS.min }
  assert.equal(zoomAt(atMin, 100, 100, 0.5, LIMITS), atMin)
  assert.equal(zoomAt({ x: 0, y: 0, scale: 0.21 }, 0, 0, 0.1, LIMITS).scale, LIMITS.min)
})

test('wheel: scrolling up zooms in, down zooms out, one notch is one step', () => {
  assert.ok(Math.abs(wheelZoomFactor(-100, 0, 1.08) - 1.08) < 1e-12)
  assert.ok(Math.abs(wheelZoomFactor(100, 0, 1.08) - 1 / 1.08) < 1e-12)
  assert.equal(wheelZoomFactor(0, 0, 1.08), 1)
})

test('wheel: small trackpad / pinch deltas zoom gently, huge deltas are capped, line mode is normalised', () => {
  const small = wheelZoomFactor(-4, 0, 1.08)
  assert.ok(small > 1 && small < 1.01)
  assert.equal(wheelZoomFactor(-5000, 0, 1.08), Math.pow(1.08, 1.5))
  assert.ok(Math.abs(wheelZoomFactor(-3, 1, 1.08) - wheelZoomFactor(-48, 0, 1.08)) < 1e-12)
})

test('two mouse-wheel notches zoom in step^2 around the pointer; button step is a fixed 1.25', () => {
  const f = wheelZoomFactor(-100, 0, FLEET_WHEEL_STEP)
  const z = zoomAt(zoomAt({ x: 0, y: 0, scale: 1 }, 400, 300, f, LIMITS), 400, 300, f, LIMITS)
  assert.ok(Math.abs(z.scale - FLEET_WHEEL_STEP * FLEET_WHEEL_STEP) < 1e-12)
  assert.equal(BUTTON_ZOOM_STEP, 1.25)
})
