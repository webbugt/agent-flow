import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  fitToNodes, pickFitAgents, screensaverCameraPlan, screensaverCameraStep, MIN_VISIBLE_OPACITY,
  type FitAgentLike, type FitOptions, type ScreensaverCameraPlan,
} from './screensaver-fit'

const OPTS: FitOptions = { marginPx: 40, labelRoom: 0, minScale: 0.2, maxScale: 2 }
const VIEW = { width: 1000, height: 600 }

/** Screen rectangle of a node under a transform. */
const screenBox = (t: { x: number; y: number; scale: number }, n: { x: number; y: number; r: number }) => ({
  left: t.x + (n.x - n.r) * t.scale, right: t.x + (n.x + n.r) * t.scale,
  top: t.y + (n.y - n.r) * t.scale, bottom: t.y + (n.y + n.r) * t.scale,
})

test('nothing to fit, or a view without size: null', () => {
  assert.equal(fitToNodes([], VIEW, OPTS), null)
  assert.equal(fitToNodes([{ x: 0, y: 0, r: 10 }], { width: 0, height: 600 }, OPTS), null)
})

test('every node, radius included, ends up inside the view with the margin free (wide spread)', () => {
  const nodes = [{ x: -800, y: 0, r: 30 }, { x: 800, y: 40, r: 20 }, { x: 0, y: -100, r: 30 }]
  const t = fitToNodes(nodes, VIEW, OPTS)!
  assert.ok(t.scale < 1, 'zoomed out')
  for (const n of nodes) {
    const b = screenBox(t, n)
    assert.ok(b.left >= OPTS.marginPx - 1e-6 && b.right <= VIEW.width - OPTS.marginPx + 1e-6, `x inside: ${JSON.stringify(b)}`)
    assert.ok(b.top >= OPTS.marginPx - 1e-6 && b.bottom <= VIEW.height - OPTS.marginPx + 1e-6, `y inside: ${JSON.stringify(b)}`)
  }
})

test('the limiting axis touches the margin exactly (width-bound)', () => {
  const nodes = [{ x: -1000, y: 0, r: 50 }, { x: 1000, y: 0, r: 50 }]
  const t = fitToNodes(nodes, VIEW, OPTS)!
  assert.equal(t.scale, (VIEW.width - 80) / 2100)
  const left = screenBox(t, nodes[0]).left
  assert.ok(Math.abs(left - 40) < 1e-6)
})

test('the limiting axis touches the margin exactly (height-bound), and the bounds are centred', () => {
  const nodes = [{ x: 0, y: -600, r: 20 }, { x: 10, y: 600, r: 20 }]
  const t = fitToNodes(nodes, VIEW, OPTS)!
  assert.equal(t.scale, (VIEW.height - 80) / 1240)
  const top = screenBox(t, nodes[0]).top
  const bottom = screenBox(t, nodes[1]).bottom
  assert.ok(Math.abs(top - 40) < 1e-6 && Math.abs(VIEW.height - bottom - 40) < 1e-6)
  const midX = (screenBox(t, nodes[0]).left + screenBox(t, nodes[1]).right) / 2
  assert.ok(Math.abs(midX - VIEW.width / 2) < 1e-6)
})

test('a single node is zoomed in, but never beyond maxScale, and sits in the centre', () => {
  const t = fitToNodes([{ x: 300, y: -200, r: 30 }], VIEW, OPTS)!
  assert.equal(t.scale, 2)
  assert.ok(Math.abs(t.x + 300 * t.scale - VIEW.width / 2) < 1e-6)
  assert.ok(Math.abs(t.y + -200 * t.scale - VIEW.height / 2) < 1e-6)
})

test('scale never goes below minScale', () => {
  const t = fitToNodes([{ x: -1e6, y: 0, r: 30 }, { x: 1e6, y: 0, r: 30 }], VIEW, OPTS)!
  assert.equal(t.scale, OPTS.minScale)
})

test('label room is kept under the lowest node', () => {
  const withLabel = { ...OPTS, labelRoom: 60 }
  const nodes = [{ x: 0, y: -500, r: 20 }, { x: 0, y: 500, r: 20 }]
  const t = fitToNodes(nodes, VIEW, withLabel)!
  const bottomOfLabel = t.y + (500 + 20 + 60) * t.scale
  assert.ok(bottomOfLabel <= VIEW.height - OPTS.marginPx + 1e-6)
  assert.ok(t.scale < fitToNodes(nodes, VIEW, OPTS)!.scale, 'label room costs zoom')
})

test('a margin bigger than the view does not flip the scale negative', () => {
  const t = fitToNodes([{ x: 0, y: 0, r: 100 }, { x: 500, y: 0, r: 10 }], { width: 100, height: 100 }, { ...OPTS, marginPx: 80 })!
  assert.ok(t.scale >= OPTS.minScale && Number.isFinite(t.x) && Number.isFinite(t.y))
})

test('adding an active node far away zooms out to keep both in view; removing it zooms back in', () => {
  const a = { x: 0, y: 0, r: 30 }
  const b = { x: 1500, y: 0, r: 30 }
  const one = fitToNodes([a], VIEW, OPTS)!
  const two = fitToNodes([a, b], VIEW, OPTS)!
  assert.ok(two.scale < one.scale)
  assert.equal(fitToNodes([a], VIEW, OPTS)!.scale, one.scale)
})

// --- which nodes count -------------------------------------------------------------------------

// A real agent has a `state` too; the fit must not care about it.
const ag = (id: string, over: Partial<FitAgentLike> & { state?: string } = {}): FitAgentLike & { state: string } =>
  ({ id, state: 'idle', x: 0, y: 0, opacity: 1, isMain: false, ...over })

test('pickFitAgents: every drawn node counts, whatever its state (idle, complete, working)', () => {
  const picked = pickFitAgents([
    ag('a', { state: 'tool_calling' }), ag('b', { state: 'idle' }), ag('c', { state: 'thinking' }),
    ag('d', { state: 'complete' }), ag('e', { state: 'error' }), ag('f', { state: 'waiting_permission' }),
  ])
  assert.deepEqual(picked.map(p => p.id), ['a', 'b', 'c', 'd', 'e', 'f'])
})

test('pickFitAgents: idle nodes are kept even when other nodes are working (no active-only rule)', () => {
  const picked = pickFitAgents([ag('work', { state: 'tool_calling', x: 0 }), ag('idle', { state: 'idle', x: 5000 })])
  assert.deepEqual(picked.map(p => p.id), ['work', 'idle'])
})

test('pickFitAgents: a ghost (leaving node) does not hold the view, even if it is still working', () => {
  const picked = pickFitAgents([ag('a', { state: 'tool_calling' }), ag('g', { state: 'tool_calling' }), ag('i')], new Set(['g']))
  assert.deepEqual(picked.map(p => p.id), ['a', 'i'])
})

test('pickFitAgents: faded nodes (opacity at or below MIN_VISIBLE_OPACITY) are left out', () => {
  const picked = pickFitAgents([
    ag('a'), ag('f', { opacity: 0.02 }), ag('edge', { opacity: MIN_VISIBLE_OPACITY }), ag('just', { opacity: MIN_VISIBLE_OPACITY + 0.01 }),
  ])
  assert.deepEqual(picked.map(p => p.id), ['a', 'just'])
})

test('pickFitAgents: ghosts and faded nodes are both left out of an otherwise idle map', () => {
  const picked = pickFitAgents([ag('a'), ag('b', { state: 'complete' }), ag('f', { opacity: 0.02 }), ag('g')], new Set(['g']))
  assert.deepEqual(picked.map(p => p.id), ['a', 'b'])
})

test('pickFitAgents: everything faded or leaving -> still returns nodes (never an empty fit by accident), empty only for an empty map', () => {
  assert.deepEqual(pickFitAgents([ag('f', { opacity: 0.02 })]).map(p => p.id), ['f'])
  assert.deepEqual(pickFitAgents([ag('g')], new Set(['g'])).map(p => p.id), ['g'])
  // all faded, one of them leaving: the one that stays is preferred
  assert.deepEqual(pickFitAgents([ag('f', { opacity: 0.02 }), ag('g', { opacity: 0.02 })], new Set(['g'])).map(p => p.id), ['f'])
  assert.deepEqual(pickFitAgents([]), [])
})

test('pickFitAgents: accepts any iterable (a Map.values())', () => {
  const m = new Map([['a', ag('a')], ['b', ag('b', { state: 'tool_calling' })]])
  assert.deepEqual(pickFitAgents(m.values()).map(p => p.id), ['a', 'b'])
})

// --- the setting: what the camera does -----------------------------------------------------------

test('screensaverCameraPlan: fit only in the fleet map, in the screensaver, with the option on', () => {
  assert.equal(screensaverCameraPlan(true, true, true), 'fit')
  assert.equal(screensaverCameraPlan(true, true, false), 'hold')
  assert.equal(screensaverCameraPlan(true, false, true), 'release')
  assert.equal(screensaverCameraPlan(true, false, false), 'release')
  assert.equal(screensaverCameraPlan(false, true, true), 'none')
  assert.equal(screensaverCameraPlan(false, true, false), 'none')
})

test('screensaverCameraStep: option on -> entering the screensaver fits at once; leaving hands the view back', () => {
  assert.equal(screensaverCameraStep('release', 'fit'), 'fit')
  assert.equal(screensaverCameraStep(null, 'fit'), 'fit')
  assert.equal(screensaverCameraStep('fit', 'release'), 'release')
})

test('screensaverCameraStep: option switched ON while in the screensaver fits at once', () => {
  assert.equal(screensaverCameraStep('hold', 'fit'), 'fit')
})

test('screensaverCameraStep: option switched OFF while it fitted freezes the camera', () => {
  assert.equal(screensaverCameraStep('fit', 'hold'), 'freeze')
})

test('screensaverCameraStep: option off -> entering or leaving the screensaver never moves the camera', () => {
  const quiet: [ScreensaverCameraPlan | null, ScreensaverCameraPlan][] = [
    [null, 'hold'], ['release', 'hold'], ['hold', 'hold'], ['hold', 'release'], ['none', 'hold'],
  ]
  for (const [prev, next] of quiet) assert.equal(screensaverCameraStep(prev, next), 'none', `${prev} -> ${next}`)
})

test('screensaverCameraStep: outside the fleet map nothing happens; the first run outside the screensaver releases as before', () => {
  assert.equal(screensaverCameraStep('fit', 'none'), 'none')
  assert.equal(screensaverCameraStep(null, 'none'), 'none')
  assert.equal(screensaverCameraStep(null, 'release'), 'release')
  assert.equal(screensaverCameraStep('none', 'release'), 'release')
})
