/**
 * Screensaver auto view: zoom the fleet map so every DRAWN node is in view, keep it that way as nodes come
 * and go. Pure, so the bounding math is testable without a canvas.
 *
 * "Drawn node" = a node on the map after the activity filter (the activity window decides what is on the map):
 * it is not a ghost (a node that is leaving) and it is not faded out. Its agent state does not matter: idle and
 * complete nodes count like working ones. When every node is faded or leaving, all of them count.
 *
 * The fit is behind the `screensaverAutoFit` option; `screensaverCameraPlan` says what the camera does when the
 * screensaver or that option changes.
 */
import type { Transform } from './fleet-camera'

export interface FitNode { x: number; y: number; r: number }

export interface FitView { width: number; height: number }

export interface FitOptions {
  /** Screen margin kept free on every side, px. */
  marginPx: number
  /** Extra room under the nodes for their label, world units. */
  labelRoom: number
  minScale: number
  maxScale: number
}

/** What the screensaver fit needs of a node (a subset of `Agent`). */
export interface FitAgentLike {
  id: string
  x: number
  y: number
  opacity: number
  isMain: boolean
}

/** Below this opacity a node is not visible enough to need room (it is fading in or out). */
export const MIN_VISIBLE_OPACITY = 0.1

/**
 * The nodes the screensaver view has to keep in sight: every drawn one (no filter on active/idle state), else
 * (all faded) every node that is not leaving, else every node. Ghosts (leaving nodes) never count while another
 * node is left.
 */
export function pickFitAgents<A extends FitAgentLike>(agents: Iterable<A>, ghosts: ReadonlySet<string> = new Set()): A[] {
  const all = [...agents]
  const live = all.filter(a => !ghosts.has(a.id))
  const drawn = live.filter(a => a.opacity > MIN_VISIBLE_OPACITY)
  if (drawn.length > 0) return drawn
  return live.length > 0 ? live : all
}

/**
 * What the camera does with the screensaver auto view, from the fleet map, the screensaver and the
 * `screensaverAutoFit` option:
 * - `fit`     screensaver on and the option on: drop the user's navigation and fit at once (also when the option
 *             is switched on while the screensaver runs).
 * - `hold`    screensaver on, option off: no auto zoom. The camera stays where it is (a running fit animation
 *             stops; the user's zoom and pan keep working).
 * - `release` not in the screensaver: back to the normal fit, as before the screensaver.
 * - `none`    not the fleet map.
 */
export type ScreensaverCameraPlan = 'fit' | 'hold' | 'release' | 'none'

export function screensaverCameraPlan(fleetView: boolean, screensaver: boolean, autoFit: boolean): ScreensaverCameraPlan {
  if (!fleetView) return 'none'
  if (!screensaver) return 'release'
  return autoFit ? 'fit' : 'hold'
}

/** What the camera has to do when the plan changes from `prev` (null = first run) to `next`. */
export type ScreensaverCameraStep = 'fit' | 'freeze' | 'release' | 'none'

/**
 * - `fit`     start the fit (the user's navigation is dropped first).
 * - `freeze`  the auto view was on and is switched off: stop where the camera is and take the auto-follow away,
 *             so nothing zooms by itself afterwards.
 * - `release` hand the view back to the normal fit (leaving a screensaver that fitted).
 * - `none`    nothing: with the option off the screensaver does not touch the camera at all, so entering or
 *             leaving it keeps the view (and the user's zoom/pan state) as it is.
 */
export function screensaverCameraStep(prev: ScreensaverCameraPlan | null, next: ScreensaverCameraPlan): ScreensaverCameraStep {
  switch (next) {
    case 'none': return 'none'
    case 'fit': return 'fit'
    case 'hold': return prev === 'fit' ? 'freeze' : 'none'
    case 'release': return prev === 'hold' ? 'none' : 'release'
  }
}

/**
 * The camera transform that puts every node (its radius included) inside the view with `marginPx` free on
 * each side. The scale is clamped to [minScale, maxScale] (a single node must not fill the screen); the
 * bounds are centred. Null when there is nothing to fit or the view has no size.
 */
export function fitToNodes(nodes: readonly FitNode[], view: FitView, opts: FitOptions): Transform | null {
  if (nodes.length === 0 || view.width <= 1 || view.height <= 1) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r)
    maxX = Math.max(maxX, n.x + n.r)
    minY = Math.min(minY, n.y - n.r)
    maxY = Math.max(maxY, n.y + n.r + opts.labelRoom)
  }
  const boundsW = Math.max(maxX - minX, 1)
  const boundsH = Math.max(maxY - minY, 1)
  // A margin larger than the view would make the available room negative: keep at least a sliver.
  const availW = Math.max(view.width - 2 * opts.marginPx, view.width * 0.2)
  const availH = Math.max(view.height - 2 * opts.marginPx, view.height * 0.2)
  const scale = Math.max(opts.minScale, Math.min(opts.maxScale, availW / boundsW, availH / boundsH))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { scale, x: view.width / 2 - cx * scale, y: view.height / 2 - cy * scale }
}
