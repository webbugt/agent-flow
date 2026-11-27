/**
 * Position tween of the Fleet map's nodes. When the scene is rebuilt (a node or cloud entered or left,
 * a weight changed) every node that stays gets a new place; without this it jumps there in one frame.
 * Here each node that has to move gets a LEG: from where it is drawn now to its new place, started at
 * the time of the rebuild and eased over {@link TWEEN_MS}. Everything is a pure function of time: the
 * caller passes `now` (the Fleet clock, see fleet-clock), no timers, so the tests need none and the
 * frame at +N ms is the same on every run.
 *
 *   - {@link retarget}: turns "where nodes are drawn now" and "where the new scene wants them" into legs.
 *     A node that is new on the map has no leg (it appears at its place; its entry animation is the
 *     presence module's business). A node the user holds (dragged) has none either: a drag applies at
 *     once. A leg that already runs towards the same place is kept, so a rebuild that changes nothing
 *     for a node (every event tick) does not restart its motion.
 *   - {@link positionsAt}: where every node with a leg is at `now`, and whether all legs are over.
 *
 * Satellites are not tweened on their own: the scene layer keeps them at their offset from their node.
 */
import type { Point } from './fleet-placement'
import { easeInOutQuad } from './fleet-presence'

/** A node eases to its new place over this long, ms. */
export const TWEEN_MS = 450
/** Closer than this (world units) a node is already there: no leg. */
export const TWEEN_EPSILON = 0.4

export interface Leg {
  from: Point
  to: Point
  /** Epoch ms (the Fleet clock) at which the leg started. */
  since: number
}

export type Legs = ReadonlyMap<string, Leg>

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Progress 0..1 of a leg at `now`; a `now` before the start counts as the start. */
function progressOf(leg: Leg, now: number): number {
  const p = (now - leg.since) / TWEEN_MS
  if (!(p > 0)) return 0 // NaN or before the start
  return p >= 1 ? 1 : p
}

export function legDone(leg: Leg, now: number): boolean {
  return progressOf(leg, now) >= 1
}

/** Where a leg is at `now`; exactly `to` once it is over (no endless tail). */
export function legPosition(leg: Leg, now: number): Point {
  const p = progressOf(leg, now)
  if (p >= 1) return { x: leg.to.x, y: leg.to.y }
  const k = easeInOutQuad(p)
  return { x: leg.from.x + (leg.to.x - leg.from.x) * k, y: leg.from.y + (leg.to.y - leg.from.y) * k }
}

/**
 * Legs for a rebuilt scene.
 *   - `shown`: where the nodes are drawn right now (the frame the canvas reads).
 *   - `targets`: where the new scene puts them (final places, ghosts included).
 *   - `prev`: the legs that were running; one with the same target and not over is kept as it is.
 *   - `hold`: ids of nodes the user moved; they get no leg.
 */
export function retarget(
  prev: Legs | null | undefined,
  shown: ReadonlyMap<string, Point>,
  targets: ReadonlyMap<string, Point>,
  now: number,
  hold?: ReadonlyMap<string, unknown>,
): Map<string, Leg> {
  const out = new Map<string, Leg>()
  for (const [id, to] of targets) {
    const at = shown.get(id)
    if (!at || hold?.has(id)) continue
    const old = prev?.get(id)
    if (old && dist(old.to, to) <= TWEEN_EPSILON && !legDone(old, now)) { out.set(id, old); continue }
    if (dist(at, to) <= TWEEN_EPSILON) continue
    out.set(id, { from: { x: at.x, y: at.y }, to: { x: to.x, y: to.y }, since: now })
  }
  return out
}

export interface TweenPositions {
  /** Position of every node that has a leg. */
  positions: Map<string, Point>
  /** Every leg is over at `now`: the caller can stop its frame loop. */
  settled: boolean
}

export function positionsAt(legs: Legs | null | undefined, now: number): TweenPositions {
  const positions = new Map<string, Point>()
  let settled = true
  if (legs) {
    for (const [id, leg] of legs) {
      positions.set(id, legPosition(leg, now))
      if (!legDone(leg, now)) settled = false
    }
  }
  return { positions, settled }
}
