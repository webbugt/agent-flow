import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_BAR_NARROW_PX, SCRUBBER_MIN_WIDTH_PX, scrubRatio } from './scrub'

test('scrubRatio maps a pointer to 0..1 along the track', () => {
  assert.equal(scrubRatio(150, 100, 200), 0.25)
  assert.equal(scrubRatio(100, 100, 200), 0)
  assert.equal(scrubRatio(300, 100, 200), 1)
})

test('scrubRatio clamps a pointer outside the track (a captured pointer keeps moving past the ends)', () => {
  assert.equal(scrubRatio(-50, 100, 200), 0)
  assert.equal(scrubRatio(900, 100, 200), 1)
})

test('scrubRatio never returns NaN for a collapsed track', () => {
  assert.equal(scrubRatio(150, 100, 0), 0)
  assert.equal(scrubRatio(150, 100, -5), 0)
  assert.equal(scrubRatio(NaN, 100, 200), 0)
})

test('the narrow breakpoint and the track minimum match the review (<480 px, min-width 120 px)', () => {
  assert.equal(REVIEW_BAR_NARROW_PX, 480)
  assert.equal(SCRUBBER_MIN_WIDTH_PX, 120)
})
