import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BELOW_TOP_BAR, DEFAULT_BAR_TOP_PX, LIMITS_AUTO_FOLD_PX, LIMITS_STACK_PX, MIN_PANEL_HEIGHT_PX, STACK_BOTTOM, STACK_PANEL_MAX_HEIGHT,
  VAR_BAR_TOP, VAR_LIMITS_TOP, VAR_TOP_BAR_BOTTOM, limitsAutoFolded, limitsStacked,
} from './bottom-stack'

test('a bottom panel sits above the higher of the bar and the stacked LIMITS panel, with a fallback for the first frame', () => {
  assert.equal(STACK_BOTTOM, `calc(max(var(${VAR_BAR_TOP}, ${DEFAULT_BAR_TOP_PX}px), var(${VAR_LIMITS_TOP}, 0px)) + 8px)`)
})

test('the panel height cap leaves the top bar and the stack free and never drops below the minimum', () => {
  assert.ok(STACK_PANEL_MAX_HEIGHT.startsWith(`max(${MIN_PANEL_HEIGHT_PX}px, calc(100dvh - var(${VAR_TOP_BAR_BOTTOM}`))
  assert.ok(STACK_PANEL_MAX_HEIGHT.includes(STACK_BOTTOM))
})

test('a sheet starts below the top bar rows, never above 36 px', () => {
  assert.equal(BELOW_TOP_BAR, `max(36px, calc(var(${VAR_TOP_BAR_BOTTOM}, 0px) + 4px))`)
})

test('LIMITS stacks above the bar wherever the two would overlap (phone, 844 landscape, tablet, 1280)', () => {
  for (const w of [320, 390, 768, 844, 1024, 1280, LIMITS_STACK_PX - 1]) assert.equal(limitsStacked(w), true, `width ${w}`)
  for (const w of [LIMITS_STACK_PX, 1440, 1920]) assert.equal(limitsStacked(w), false, `width ${w}`)
})

test('the overlap threshold is the real geometry: 300 px panel + 16 px margins against the 680 px centred bar', () => {
  // the bar spans [(w-680)/2, (w+680)/2]; the panel [w-316, w-16]
  const overlaps = (w: number) => (w + 680) / 2 > w - 316
  assert.equal(overlaps(LIMITS_STACK_PX - 1), true)
  assert.equal(overlaps(LIMITS_STACK_PX), false)
})

test('LIMITS folds itself only on a small screen while another bottom panel is open', () => {
  assert.equal(limitsAutoFolded(390, true), true)
  assert.equal(limitsAutoFolded(LIMITS_AUTO_FOLD_PX - 1, true), true)
  assert.equal(limitsAutoFolded(LIMITS_AUTO_FOLD_PX, true), false)
  assert.equal(limitsAutoFolded(390, false), false)
})
