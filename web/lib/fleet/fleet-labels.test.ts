import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { LABEL_MAX_PX, LABEL_MIN_PX, LabelPlacer, fitText, labelScreenPx, rectsOverlap } from './fleet-labels'

test('labelScreenPx: never below the legible minimum, never above the maximum', () => {
  // A phone fit (zoom 0.15): 10 px nominal would be 1.5 px; it is drawn at the minimum instead.
  assert.equal(labelScreenPx(10, 0.15), LABEL_MIN_PX)
  assert.equal(labelScreenPx(10, 0.05), LABEL_MIN_PX)
  // Zoomed far in the text stops growing.
  assert.equal(labelScreenPx(10, 4), LABEL_MAX_PX)
  // In between it follows the zoom.
  assert.equal(labelScreenPx(10, 1), 10)
  // Own limits (captions).
  assert.equal(labelScreenPx(13, 0.1, 11, 15), 11)
  assert.equal(labelScreenPx(13, 9, 11, 15), 15)
  // A broken zoom does not produce NaN.
  assert.equal(labelScreenPx(10, 0), 10)
  assert.ok(Number.isFinite(labelScreenPx(10, Number.NaN)))
})

test('fitText: cuts by the width that is available, not by a character count', () => {
  const w = (s: string) => s.length * 6
  assert.equal(fitText('Agent Flow', 60, w), 'Agent Flow')
  assert.equal(fitText('Agent Flow', 168, w), 'Agent Flow')
  assert.equal(fitText('omh_family', 1000, w), 'omh_family')
  assert.equal(fitText('Agent Flow', 36, w), 'Agent\u2026')
  assert.equal(fitText('Agent Flow', 6, w), '\u2026')
  assert.ok(w(fitText('a very long board name indeed', 100, w)) <= 100)
  // More room, more characters: not a fixed 8.
  assert.ok(fitText('a very long board name indeed', 168, w).length > fitText('a very long board name indeed', 60, w).length)
  assert.ok(fitText('New board 0 with a long name', 168, w).length > 9)
})

test('LabelPlacer: a label on top of a taken area is refused, a free one is taken', () => {
  const p = new LabelPlacer()
  p.reserve({ x0: 0, y0: 0, x1: 10, y1: 10 })
  assert.equal(p.tryPlace({ x0: 5, y0: 5, x1: 20, y1: 20 }), false)
  assert.equal(p.tryPlace({ x0: 30, y0: 0, x1: 40, y1: 10 }), true)
  assert.equal(p.tryPlace({ x0: 35, y0: 5, x1: 50, y1: 15 }), false, 'overlaps the one just placed')
  assert.equal(p.tryPlace({ x0: 11, y0: 0, x1: 20, y1: 10 }, 2), false, 'padding counts')
  assert.equal(p.tryPlace({ x0: 11, y0: 0, x1: 20, y1: 10 }, 0), true)
  assert.equal(rectsOverlap({ x0: 0, y0: 0, x1: 1, y1: 1 }, { x0: 1, y0: 0, x1: 2, y1: 1 }), false, 'touching is not overlapping')
})
