/**
 * Entry and exit of things on the Fleet map: session nodes, resource nodes and clouds (halo + caption).
 *
 * A thing that appears fades and scales in; one that disappears is kept as a ghost for the exit
 * duration, fades and shrinks, then is removed. All of it is a pure function of elapsed time:
 *
 *   - {@link levelOf} turns a {@link PresenceStamp} and a time into a level 0..1 (opacity directly,
 *     size through {@link scaleOf}). It reads no clock; the caller passes `now`, so the result does
 *     not depend on the frame rate and the tests need no timers.
 *   - {@link PresenceTracker} turns "which ids are on the map now" (an update per scene build) into
 *     stamps, and keeps the last snapshot of every id that left, as its ghost.
 *
 * A thing that reverses (leaves while still entering, comes back while leaving) continues from its
 * current level instead of jumping, so a flickering filter does not make nodes pop.
 */

/** A node fades in over this long, ms. */
export const NODE_ENTER_MS = 450
/** A node's ghost is shown this long while it fades out, ms. */
export const NODE_EXIT_MS = 600
/** A cloud (halo) grows from its centre over this long, ms. */
export const CLOUD_ENTER_MS = 700
/** A cloud fades once its last member left, over this long, ms. */
export const CLOUD_EXIT_MS = 800

/** Size at level 0: an entering node starts at this share of its size, an exiting one ends at it. */
export const NODE_SCALE_MIN = 0.35
/** Halo size at level 0 (it grows from its centre). */
export const CLOUD_SCALE_MIN = 0.1

export type PresenceDir = 'in' | 'out' | 'steady'

export interface PresenceStamp {
  dir: PresenceDir
  /** When this transition began, epoch ms. Unused for `steady`. */
  since: number
  /** Level the transition started from, 0..1: 0 for a fresh entry, 1 for a plain exit, the current level for a reversal. */
  from: number
  /** Length of the transition, ms. */
  duration: number
}

export const STEADY: PresenceStamp = { dir: 'steady', since: 0, from: 1, duration: 0 }

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t)
  return 1 - u * u * u
}

export function easeInOutQuad(t: number): number {
  const x = clamp01(t)
  return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2
}

/** Inverse of {@link easeOutCubic} on 0..1 (used to carry a level over a reversal). */
export function easeOutCubicInverse(level: number): number {
  return 1 - Math.cbrt(1 - clamp01(level))
}

function progress(stamp: PresenceStamp, now: number): number {
  if (stamp.duration <= 0) return 1
  const p = (now - stamp.since) / stamp.duration
  return clamp01(Number.isFinite(p) ? p : 1)
}

/**
 * Level of a thing, 0..1: its opacity, and (through {@link scaleOf}) its size. 1 when it is just
 * there. `null` once an exit is over: the ghost must be dropped.
 * A `now` before the start counts as the start (clock skew, a stamp taken a moment ahead).
 */
export function levelOf(stamp: PresenceStamp, now: number): number | null {
  if (stamp.dir === 'steady') return 1
  const p = progress(stamp, now)
  if (stamp.dir === 'in') return stamp.from + (1 - stamp.from) * easeOutCubic(p)
  if (p >= 1) return null
  return stamp.from * (1 - easeInOutQuad(p))
}

/** Size factor for a level: `min` at level 0, 1 at level 1. */
export function scaleOf(level: number, min: number = NODE_SCALE_MIN): number {
  return min + (1 - min) * clamp01(level)
}

/** Halo size factor of a cloud at a level: it grows from its centre. */
export function cloudScale(level: number): number {
  return scaleOf(level, CLOUD_SCALE_MIN)
}

/** True while the stamp still changes with time (an entry not finished, or an exit not over). */
export function isAnimating(stamp: PresenceStamp, now: number): boolean {
  if (stamp.dir === 'steady') return false
  if (stamp.dir === 'out') return true
  return progress(stamp, now) < 1
}

/** Durations of an id's entry and exit. */
export interface PresenceDurations { enterMs: number; exitMs: number }

export const NODE_DURATIONS: PresenceDurations = { enterMs: NODE_ENTER_MS, exitMs: NODE_EXIT_MS }
export const CLOUD_DURATIONS: PresenceDurations = { enterMs: CLOUD_ENTER_MS, exitMs: CLOUD_EXIT_MS }

/** Stamp of a thing that has just appeared at `now`, or that comes back while `prev` is still on its way out. */
export function enterStamp(prev: PresenceStamp | undefined, now: number, durations: PresenceDurations): PresenceStamp {
  const from = prev ? (levelOf(prev, now) ?? 0) : 0
  if (from >= 1) return STEADY
  // Resume on the entry curve at the level it has now, so nothing jumps.
  const resumed = easeOutCubicInverse(from)
  return { dir: 'in', since: now - resumed * durations.enterMs, from: 0, duration: durations.enterMs }
}

/** Stamp of a thing that has just left at `now` (it may be half way through its entry). */
export function exitStamp(prev: PresenceStamp | undefined, now: number, durations: PresenceDurations): PresenceStamp {
  const from = prev ? (levelOf(prev, now) ?? 0) : 1
  // Shorten the exit in proportion to what is left to fade, so a thing that was barely in is gone quickly.
  return { dir: 'out', since: now, from, duration: Math.max(1, durations.exitMs * from) }
}

/**
 * Tracks what is on the map between scene builds. `T` is the snapshot kept for a ghost (whatever the
 * caller needs to draw the thing again after it left).
 *
 * The first update only records what exists (opening the map must not animate everything in); later
 * updates stamp newcomers as entering and the missing as exiting.
 */
export class PresenceTracker<T> {
  private readonly stamps_ = new Map<string, PresenceStamp>()
  private readonly last = new Map<string, T>()
  private started = false

  constructor(private readonly durationsOf: (id: string) => PresenceDurations = () => NODE_DURATIONS) {}

  /** Stamps of everything drawn now: live things and ghosts that are still on their way out. */
  get stamps(): ReadonlyMap<string, PresenceStamp> { return this.stamps_ }

  /**
   * Record the things on the map at `now` and return the ghosts: snapshots of what has left and is still
   * fading. Idempotent for the same `live` map, so a second call (React strict mode) changes nothing.
   */
  update(live: ReadonlyMap<string, T>, now: number): Map<string, T> {
    const first = !this.started
    this.started = true
    for (const [id, snap] of live) {
      this.last.set(id, snap)
      const prev = this.stamps_.get(id)
      if (!prev) this.stamps_.set(id, first ? STEADY : enterStamp(undefined, now, this.durationsOf(id)))
      else if (prev.dir === 'out') this.stamps_.set(id, enterStamp(prev, now, this.durationsOf(id)))
      else if (prev.dir === 'in' && !isAnimating(prev, now)) this.stamps_.set(id, STEADY)
    }
    const ghosts = new Map<string, T>()
    for (const [id, stamp] of [...this.stamps_]) {
      if (live.has(id)) continue
      let next = stamp
      if (stamp.dir !== 'out') next = exitStamp(stamp, now, this.durationsOf(id))
      if (levelOf(next, now) === null) {
        this.stamps_.delete(id)
        this.last.delete(id)
        continue
      }
      this.stamps_.set(id, next)
      ghosts.set(id, this.last.get(id) as T)
    }
    return ghosts
  }

  /** Forget everything (the map was hidden): the next update is a first one again, so showing it animates nothing. */
  reset(): void {
    this.stamps_.clear()
    this.last.clear()
    this.started = false
  }

  /** When the next ghost is over (epoch ms), or null when none is on its way out. */
  nextExpiry(): number | null {
    let next: number | null = null
    for (const stamp of this.stamps_.values()) {
      if (stamp.dir !== 'out') continue
      const end = stamp.since + stamp.duration
      if (next === null || end < next) next = end
    }
    return next
  }
}
