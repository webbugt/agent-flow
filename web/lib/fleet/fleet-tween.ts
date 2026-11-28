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
  /** How long the leg takes, ms. Default {@link TWEEN_MS}; resource-anchor mode uses a longer one so a session drifts. */
  ms?: number
  /**
   * Velocity the node had when the leg started, world units per ms. A leg with one leaves at that speed (cubic Hermite
   * curve) instead of from rest, so a node whose target is moved again while it glides keeps gliding: no stop and
   * restart at every rebuild. A leg without one eases in and out as before.
   */
  v?: Point
}

export type Legs = ReadonlyMap<string, Leg>

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

/** Progress 0..1 of a leg at `now`; a `now` before the start counts as the start. */
function progressOf(leg: Leg, now: number): number {
  const p = (now - leg.since) / (leg.ms ?? TWEEN_MS)
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
  if (leg.v) {
    // Hermite: start at `from` with speed `v`, arrive at `to` at rest.
    const d = leg.ms ?? TWEEN_MS
    const p2 = p * p
    const p3 = p2 * p
    const h00 = 2 * p3 - 3 * p2 + 1
    const h10 = p3 - 2 * p2 + p
    const h01 = -2 * p3 + 3 * p2
    return {
      x: h00 * leg.from.x + h10 * leg.v.x * d + h01 * leg.to.x,
      y: h00 * leg.from.y + h10 * leg.v.y * d + h01 * leg.to.y,
    }
  }
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
  /** Length of a new leg, ms (default {@link TWEEN_MS}). */
  durationMs?: number,
  /** A node that is still gliding when its target moves keeps its speed (see {@link Leg.v}). Default off. */
  carryVelocity = false,
): Map<string, Leg> {
  const out = new Map<string, Leg>()
  for (const [id, to] of targets) {
    const at = shown.get(id)
    if (!at || hold?.has(id)) continue
    const old = prev?.get(id)
    if (old && dist(old.to, to) <= TWEEN_EPSILON && !legDone(old, now)) { out.set(id, old); continue }
    if (dist(at, to) <= TWEEN_EPSILON) continue
    const leg: Leg = { from: { x: at.x, y: at.y }, to: { x: to.x, y: to.y }, since: now, ...(durationMs !== undefined ? { ms: durationMs } : {}) }
    if (carryVelocity && old && !legDone(old, now)) {
      const v = speedOf(old, now)
      // Never leave faster than it takes to cross the distance in half the leg: no wild overshoot for a far new target.
      const cap = (2 * dist(at, to)) / (durationMs ?? TWEEN_MS)
      const m = Math.hypot(v.x, v.y)
      const k = m > cap && m > 0 ? cap / m : 1
      if (m > 1e-6) leg.v = { x: v.x * k, y: v.y * k }
    }
    out.set(id, leg)
  }
  return out
}

/** Velocity of a leg at `now`, world units per ms (central difference over a few ms; the start and the end clamp). */
function speedOf(leg: Leg, now: number): Point {
  const h = 8
  const a = legPosition(leg, now - h)
  const b = legPosition(leg, now + h)
  const span = Math.min(now + h, leg.since + (leg.ms ?? TWEEN_MS)) - Math.max(now - h, leg.since)
  return span > 0 ? { x: (b.x - a.x) / span, y: (b.y - a.y) / span } : { x: 0, y: 0 }
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
