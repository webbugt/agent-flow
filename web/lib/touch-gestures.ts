/**
 * Touch gestures of the map canvases (one finger pans, two fingers pinch), pure so they can be tested without a DOM.
 *
 * A gesture is a sequence of snapshots of the fingers that are down. Each `step` compares the previous snapshot with the
 * current one and returns the camera transform that keeps the world point under the fingers where it was:
 *   - one finger: translate by the finger's movement;
 *   - two fingers: scale by the ratio of the finger distances and translate by the movement of their midpoint, so the
 *     content between the fingers follows them (zoom around the midpoint, plus a two-finger pan).
 * Coordinates are in the canvas' own pixel space (clientX - rect.left), the space `Transform` maps into.
 */

import { zoomAt, type Transform, type ZoomLimits } from './fleet/fleet-camera'

export interface Point { x: number; y: number }

/** What the fingers look like at one moment: how many, the point between them, how far apart. */
export interface TouchSnapshot {
  count: 1 | 2
  mid: Point
  /** Distance between the two fingers; 0 for one finger. */
  dist: number
}

/** Finger travel (px) before a touch counts as a pan and not as a tap. Matches the mouse path's ANIM.dragThresholdPx scale. */
export const TOUCH_PAN_THRESHOLD_PX = 8

/** Snapshot of the first one or two points; null when there is no finger down. Fingers beyond the second are ignored. */
export function snapshotOf(points: readonly Point[]): TouchSnapshot | null {
  if (points.length === 0) return null
  const a = points[0]
  if (points.length === 1) return { count: 1, mid: { x: a.x, y: a.y }, dist: 0 }
  const b = points[1]
  return { count: 2, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(b.x - a.x, b.y - a.y) }
}

/**
 * The transform after the fingers moved from `prev` to `next`.
 * Returns `t` itself when the finger count changed (a finger was added or lifted: the caller re-baselines, so the view
 * never jumps) or when there is nothing to move.
 */
export function gestureStep(t: Transform, prev: TouchSnapshot, next: TouchSnapshot, limits: ZoomLimits): Transform {
  if (prev.count !== next.count) return t
  const dx = next.mid.x - prev.mid.x
  const dy = next.mid.y - prev.mid.y
  if (next.count === 1) return dx === 0 && dy === 0 ? t : { ...t, x: t.x + dx, y: t.y + dy }
  // Two fingers: zoom around the previous midpoint, then follow the midpoint's own movement.
  const factor = prev.dist > 0 && next.dist > 0 ? next.dist / prev.dist : 1
  const zoomed = zoomAt(t, prev.mid.x, prev.mid.y, factor, limits)
  if (dx === 0 && dy === 0) return zoomed
  return { ...zoomed, x: zoomed.x + dx, y: zoomed.y + dy }
}

/** True once a finger has travelled far enough from where it went down to be a pan and no longer a tap. */
export function exceedsPanThreshold(from: Point, to: Point, threshold: number = TOUCH_PAN_THRESHOLD_PX): boolean {
  return Math.hypot(to.x - from.x, to.y - from.y) > threshold
}
