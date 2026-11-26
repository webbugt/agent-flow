import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EDGE_FADE_MS, EDGE_LINGER_MS, EDGE_VISIBLE_MS, edgeAlpha, isEdgeDrawn, lifeAlpha } from './fleet-edge-life'

const T = Date.UTC(2026, 10, 25, 12, 0, 0)

test('linger window is 90 seconds', () => {
  assert.equal(EDGE_LINGER_MS, 90_000)
  assert.equal(EDGE_VISIBLE_MS, EDGE_LINGER_MS + EDGE_FADE_MS)
})

test('a link is fully drawn for 90 s after its last use, then fades out', () => {
  assert.equal(edgeAlpha(T, T), 1)
  assert.equal(edgeAlpha(T, T + 89_999), 1)
  assert.equal(edgeAlpha(T, T + 90_000), 1)
  const mid = edgeAlpha(T, T + 90_000 + EDGE_FADE_MS / 2)
  assert.ok(Math.abs(mid - 0.5) < 1e-9, `half way through the fade: ${mid}`)
  assert.ok(edgeAlpha(T, T + 91_000) < 1)
  assert.ok(edgeAlpha(T, T + 91_000) > edgeAlpha(T, T + 100_000), 'fade is monotonic')
  assert.equal(edgeAlpha(T, T + EDGE_VISIBLE_MS), 0)
  assert.equal(edgeAlpha(T, T + 10 * 60_000), 0)
})

test('a new use restarts the window', () => {
  const now = T + 200_000
  assert.equal(isEdgeDrawn(T, now), false)
  assert.equal(isEdgeDrawn(now - 5_000, now), true)
})

test('never-used and bad times are not drawn; a future time (clock skew) counts as just now', () => {
  assert.equal(edgeAlpha(null, T), 0)
  assert.equal(edgeAlpha(undefined, T), 0)
  assert.equal(edgeAlpha(NaN, T), 0)
  assert.equal(edgeAlpha(T + 5_000, T), 1)
})

test('visibility does not depend on whether the profile runs: only on lastUsedAt', () => {
  // The function has no status input at all; the same time gives the same answer.
  assert.equal(edgeAlpha(T - 60_000, T), edgeAlpha(T - 60_000, T))
  assert.equal(isEdgeDrawn(T - 60_000, T), true)
})

// --- generalised rule (lifeAlpha), shared with resource blocks ---

test('edgeAlpha is lifeAlpha with the edge constants, for every age', () => {
  for (const dt of [0, 1, 89_999, 90_000, 90_001, 97_500, 104_999, 105_000, 200_000]) {
    assert.equal(edgeAlpha(T, T + dt), lifeAlpha(T, T + dt, EDGE_LINGER_MS, EDGE_FADE_MS), `age ${dt}`)
  }
})

test('lifeAlpha: custom window, linger 0 hides at once, fade 0 is a hard cut', () => {
  assert.equal(lifeAlpha(T, T, 20_000, 15_000), 1)
  assert.equal(lifeAlpha(T, T + 20_000, 20_000, 15_000), 1)
  assert.ok(Math.abs(lifeAlpha(T, T + 27_500, 20_000, 15_000) - 0.5) < 1e-9)
  assert.equal(lifeAlpha(T, T + 35_000, 20_000, 15_000), 0)
  assert.equal(lifeAlpha(T, T, 0, 15_000), 0, 'linger 0: not even drawn at the moment of use')
  assert.equal(lifeAlpha(T, T + 1, 0, 15_000), 0)
  assert.equal(lifeAlpha(T, T + 20_000, 20_000, 0), 1)
  assert.equal(lifeAlpha(T, T + 20_001, 20_000, 0), 0)
  assert.equal(lifeAlpha(T, T, NaN, 15_000), 0)
  assert.equal(lifeAlpha(T, T + 5, 20_000, NaN), 1)
  assert.equal(lifeAlpha(T, T + 20_001, 20_000, NaN), 0)
})
