/**
 * Fleet map camera rules, kept pure so they can be tested without a canvas.
 *
 * Two decisions live here:
 *  - when the map is fitted to the view again (`shouldRefit`),
 *  - how a wheel / button zoom moves the camera (`zoomAt`, `wheelZoomFactor`).
 */

export interface Transform { x: number; y: number; scale: number }

export interface ZoomLimits { min: number; max: number }

/** What the last fit was computed from. */
export interface FitBasis {
  /** Number of nodes on the map (agents and resources; not their ids). */
  nodeCount: number
  /** Free area the map is fitted into, in px. */
  width: number
  height: number
}

/** The free area has to change by more than this many px (either side) to count as a layout change. */
export const REFIT_SIZE_THRESHOLD = 40

/** Zoom of one mouse-wheel notch on the fleet map (the single-session canvas keeps CAMERA.zoomStepUp). */
export const FLEET_WHEEL_STEP = 1.2

/** Zoom step of the on-screen +/- buttons. */
export const BUTTON_ZOOM_STEP = 1.25

/**
 * Whether the camera should be fitted to the view again.
 *
 * - first load (nothing fitted yet): fit as soon as there are nodes and a measured area;
 * - the user has zoomed or panned: never, whatever the poll brings (only an explicit
 *   fit action overrides that, and that does not go through this rule);
 * - otherwise: when the node count changes, or the free area changes by more than the threshold.
 *   Node ids are deliberately ignored: sessions come and go and the graph is rebuilt on every
 *   clock tick and poll, which must not move the camera.
 */
export function shouldRefit(
  prev: FitBasis | null,
  next: FitBasis,
  userNavigated: boolean,
  threshold: number = REFIT_SIZE_THRESHOLD,
): boolean {
  if (next.nodeCount <= 0 || next.width <= 1 || next.height <= 1) return false
  if (prev === null || prev.nodeCount <= 0) return true
  if (userNavigated) return false
  if (prev.nodeCount !== next.nodeCount) return true
  return Math.abs(prev.width - next.width) > threshold || Math.abs(prev.height - next.height) > threshold
}

/**
 * Zoom by `factor` keeping the world point under (px, py) fixed on screen.
 * (px, py) are in the canvas' own pixel space (the space `transform` maps into).
 * The resulting scale is clamped to the limits; at a limit the transform is returned unchanged.
 */
export function zoomAt(t: Transform, px: number, py: number, factor: number, limits: ZoomLimits): Transform {
  const scale = Math.max(limits.min, Math.min(limits.max, t.scale * factor))
  if (scale === t.scale) return t
  const k = scale / t.scale
  return { scale, x: px - (px - t.x) * k, y: py - (py - t.y) * k }
}

/**
 * Zoom factor of one wheel event. A mouse notch (deltaY ±100 px) is one `step`; smaller
 * deltas (trackpad scrolling, pinch gestures arrive as ctrl+wheel) scale smoothly;
 * very large deltas are capped at 1.5 notches.
 * Scrolling up (negative deltaY) zooms in.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, step: number): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY
  const notches = Math.max(-1.5, Math.min(1.5, px / 100))
  return Math.pow(step, -notches)
}
