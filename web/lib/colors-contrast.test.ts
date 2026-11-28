import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COLORS } from './colors'

/** WCAG 2.x relative luminance and contrast ratio. */
function channel(c: number): number {
  const v = c / 255
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}
function luminance([r, g, b]: [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}
/** '#rrggbbaa' laid over an opaque background, as the browser composites it. */
function over(hex: string, bg: [number, number, number]): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i.exec(hex)
  assert.ok(m, `not a hex colour: ${hex}`)
  const a = m[4] ? parseInt(m[4], 16) / 255 : 1
  return [1, 2, 3].map(i => Math.round(parseInt(m[i], 16) * a + bg[i - 1] * (1 - a))) as [number, number, number]
}

const PAGE_BG: [number, number, number] = [0x0a, 0x0a, 0x1a] // the page background the browser build paints
const VOID: [number, number, number] = [0x05, 0x05, 0x10]    // COLORS.void, the canvas

test('the contrast function reproduces the reviewed failure: rgba(102,204,255,0.314) on #0a0a1a is 2.02:1', () => {
  const old = over('#66ccff50', PAGE_BG)
  assert.equal(contrast(old, PAGE_BG).toFixed(2), '2.02')
})

test('inactive text (tab labels, chip names, counters, mute icon) is at least 4.5:1 on the page and canvas background', () => {
  for (const [name, hex] of [['textMuted', COLORS.textMuted], ['textDim', COLORS.textDim]] as const) {
    for (const bg of [PAGE_BG, VOID]) {
      const ratio = contrast(over(hex, bg), bg)
      assert.ok(ratio >= 4.5, `${name} ${hex} on ${bg.join(',')} is ${ratio.toFixed(2)}:1`)
    }
  }
})

test('textDim stays brighter than textMuted, and both stay dimmer than primary text', () => {
  const lum = (hex: string) => luminance(over(hex, PAGE_BG))
  assert.ok(lum(COLORS.textDim) > lum(COLORS.textMuted))
  assert.ok(lum(COLORS.textPrimary) > lum(COLORS.textDim))
})
