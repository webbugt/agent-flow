import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Layout guard for the top bar on a phone (390px). A real browser check lives in the task
 * notes (Fleet button x=334..378 of 390, clickable); node has no layout engine, so this
 * pins the classes that make it work: the bar and its control group must wrap instead of
 * running off the right edge, and the Fleet toggle must be findable by test id.
 */
const src = readFileSync(fileURLToPath(new URL('../../components/agent-visualizer/top-bar.tsx', import.meta.url)), 'utf8')

test('top bar wraps on narrow screens so the Fleet toggle stays reachable', () => {
  const bar = src.match(/data-testid="top-bar"[^>]*?\bclassName="([^"]+)"/)
  assert.ok(bar, 'top bar root has a test id')
  assert.match(bar![1], /\bflex-wrap\b/)
  assert.doesNotMatch(bar![1], /\bflex-nowrap\b/)
  const controls = src.match(/className="(ml-auto[^"]*)"/)
  assert.ok(controls, 'control group present')
  assert.match(controls![1], /\bflex-wrap\b/)
  assert.match(controls![1], /\bmax-w-full\b/)
  assert.doesNotMatch(controls![1], /\bflex-shrink-0\b|\bshrink-0\b/, 'the control group must be allowed to wrap')
})

test('Fleet toggle is a button with a stable test id', () => {
  assert.match(src, /onClick=\{onToggleFleet\} testId="fleet-toggle"/)
  assert.match(src, /data-testid=\{testId\}/)
})

test('floating message card sits below the wrapped bar on small screens', () => {
  const feed = readFileSync(fileURLToPath(new URL('../../components/agent-visualizer/message-feed-panel.tsx', import.meta.url)), 'utf8')
  // The card no longer guesses "two rows" (a fixed max-sm:top-24): it sits under whatever height the bar really has.
  // The bar publishes its bottom edge; both the collapsed and the expanded card use it, never below the old 3rem.
  assert.doesNotMatch(feed, /max-sm:top-24/, 'no fixed phone offset left')
  assert.match(feed, /const BELOW_TOP_BAR = 'max\(3rem, calc\(var\(--af-top-bar-bottom, 0px\) \+ 8px\)\)'/)
  assert.equal((feed.match(/top: BELOW_TOP_BAR/g) ?? []).length, 2, 'collapsed and expanded card both use it')
  assert.match(src, /setProperty\('--af-top-bar-bottom'/, 'the top bar publishes its bottom edge')
  assert.match(src, /new ResizeObserver\(publish\)/, 'and keeps it current when the bar wraps or unwraps')
})
