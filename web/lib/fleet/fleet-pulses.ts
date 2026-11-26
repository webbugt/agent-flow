/**
 * Pulses of the Fleet map: a dot that travels along a link when an interaction (a Kanban event,
 * a Supermemory store, search or forget) is NEW.
 *
 * "New" means: not seen by an earlier call and young. The first call that has any link only
 * records what exists (a page load must not replay history), so only later events pulse.
 * Pure and clock-free: the caller passes `now`; drawing derives the dot position from `startedAt`.
 */
import type { FleetEdgeKind, FleetGraphEdge } from './fleet-graph'
import { KANBAN_COLOR, SUPERMEMORY_COLOR } from './fleet-colors'

/** One dot's trip along its link, ms. */
export const PULSE_MS = 1800
/** An unseen event older than this is not animated (it is history), ms. */
export const PULSE_MAX_AGE_MS = 60_000
/** Dots started per link per update; a burst is spread out instead of stacked. */
export const MAX_PULSES_PER_EDGE = 6
/** Delay between the dots of a burst, ms. */
export const PULSE_STAGGER_MS = 250

export interface FleetPulse {
  id: string
  /** Id of the link (`<cloud>><resource>`), as in the scene's edges. */
  edgeId: string
  kind: FleetEdgeKind
  color: string
  /** Epoch ms the dot leaves its session node. Can lie slightly in the future (staggered burst). */
  startedAt: number
  /**
   * Scene id of the session node the dot leaves from (the one that did the interaction). Absent when the
   * source is unknown, or no longer on the map: the dot then leaves from the cloud's rim.
   */
  sourceId?: string
}

/** Colour of a pulse: one for Kanban events, one for memory store/search/forget. */
export function pulseColor(kind: FleetEdgeKind): string {
  return kind === 'kanban' ? KANBAN_COLOR : SUPERMEMORY_COLOR
}

/** Progress of a pulse, 0..1, or null when it has not started or is over. */
export function pulseProgress(pulse: FleetPulse, now: number): number | null {
  const t = (now - pulse.startedAt) / PULSE_MS
  return t < 0 || t > 1 ? null : t
}

export class FleetPulseTracker {
  private seen = new Set<string>()
  private primed = false
  private pulses: FleetPulse[] = []

  /**
   * Feed the current links. Returns the pulses still travelling (or about to start) at `now`,
   * including the ones started by this call. Calling twice with the same edges starts nothing twice.
   */
  update(edges: readonly FleetGraphEdge[], now: number): FleetPulse[] {
    const present = new Set<string>()
    const fresh: FleetPulse[] = []
    if (edges.length > 0) {
      for (const edge of edges) {
        let burst = 0
        // Oldest first, so the dots leave in the order the events happened.
        for (const ev of [...edge.events].reverse()) {
          present.add(ev.key)
          if (this.seen.has(ev.key)) continue
          this.seen.add(ev.key)
          if (!this.primed || now - ev.at > PULSE_MAX_AGE_MS || burst >= MAX_PULSES_PER_EDGE) continue
          fresh.push({
            id: `${edge.id}@${ev.key}`, edgeId: edge.id, kind: ev.kind, color: pulseColor(ev.kind),
            startedAt: now + burst * PULSE_STAGGER_MS, sourceId: ev.sessionId,
          })
          burst++
        }
      }
      this.primed = true
      // Forget events that left every list, so the set does not grow without bound.
      for (const key of this.seen) if (!present.has(key)) this.seen.delete(key)
    }
    this.pulses = [...this.pulses, ...fresh].filter(p => now - p.startedAt <= PULSE_MS)
    return this.pulses
  }

  /** Pulses still travelling at `now`, without feeding new links. */
  active(now: number): FleetPulse[] {
    return this.pulses.filter(p => now - p.startedAt <= PULSE_MS)
  }
}
