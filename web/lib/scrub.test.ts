import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_BAR_NARROW_PX, SCRUBBER_MIN_WIDTH_PX, SCRUB_KEY_STEP_S, scrubKeyTarget, scrubRatio } from './scrub'

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

test('scrubKeyTarget: arrows step, PageUp / PageDown move 10 %, Home / End jump to the ends', () => {
  assert.equal(scrubKeyTarget('ArrowRight', 20, 100), 20 + SCRUB_KEY_STEP_S)
  assert.equal(scrubKeyTarget('ArrowUp', 20, 100), 25)
  assert.equal(scrubKeyTarget('ArrowLeft', 20, 100), 15)
  assert.equal(scrubKeyTarget('ArrowDown', 20, 100), 15)
  assert.equal(scrubKeyTarget('PageUp', 20, 100), 30)
  assert.equal(scrubKeyTarget('PageDown', 20, 100), 10)
  assert.equal(scrubKeyTarget('Home', 20, 100), 0)
  assert.equal(scrubKeyTarget('End', 20, 100), 100)
})

test('scrubKeyTarget clamps to the recording and ignores other keys', () => {
  assert.equal(scrubKeyTarget('ArrowLeft', 2, 100), 0)
  assert.equal(scrubKeyTarget('ArrowRight', 98, 100), 100)
  assert.equal(scrubKeyTarget(' ', 20, 100), null, 'Space still plays / pauses')
  assert.equal(scrubKeyTarget('Tab', 20, 100), null)
  assert.equal(scrubKeyTarget('a', 20, 100), null)
})

test('scrubKeyTarget is inert for an empty or broken recording', () => {
  assert.equal(scrubKeyTarget('ArrowRight', 0, 0), null)
  assert.equal(scrubKeyTarget('End', 0, NaN), null)
  assert.equal(scrubKeyTarget('ArrowRight', NaN, 100), 5)
})
