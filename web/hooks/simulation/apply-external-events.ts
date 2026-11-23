import type { SimulationEvent } from '@/lib/agent-types'
import type { SimulationState } from './types'
import { snapVisualState } from './snap-visual-state'

type ProcessFn = (event: SimulationEvent, state: SimulationState) => SimulationState

export interface ApplyExternalResult {
  state: SimulationState
  /** Events as applied, with the time each was placed at (append these to the event log). */
  applied: SimulationEvent[]
  /** Simulation clock after applying (never lower than `newTime`). */
  newTime: number
}

/**
 * Apply events that arrived from the relay / extension.
 *
 * Two kinds arrive:
 *  - history (`event.history`): the buffer the relay replays when a page connects, or a
 *    session's buffer on a tab switch. These already happened, so they are applied as a
 *    snapshot: each event keeps its own time (so the timeline is spaced as it really was),
 *    the clock jumps to the last one, and visuals are snapped to their settled values.
 *    Nothing spawns, fades in or flies particles. Placing them at "now" instead made the
 *    whole history appear at the same instant as one burst.
 *  - live events: placed at `max(event.time, now)` so they animate as they arrive.
 *
 * History is applied first, so live events in the same frame land after it.
 * `onHistoryApplied` runs once when history was applied (e.g. to sync the force layout).
 */
export function applyExternalEvents(
  prev: SimulationState,
  events: readonly SimulationEvent[],
  newTime: number,
  process: ProcessFn,
  opts: {
    accept?: (event: SimulationEvent) => boolean
    /** Called around history processing so the caller can skip per-event layout work. */
    setSnapshotMode?: (on: boolean) => void
    onHistoryApplied?: (state: SimulationState) => void
  } = {},
): ApplyExternalResult {
  const accept = opts.accept ?? (() => true)
  const history = events.filter(e => e.history && accept(e))
  const live = events.filter(e => !e.history && accept(e))
  const applied: SimulationEvent[] = []
  let state = prev
  let time = newTime

  if (history.length > 0) {
    opts.setSnapshotMode?.(true)
    let t = Math.max(state.currentTime, 0)
    try {
      for (const raw of history) {
        // Keep the log monotonic: a stray earlier time (a session-level event stamped 0)
        // is placed at the running time rather than moving the clock back.
        t = Math.max(t, raw.time || 0)
        const { history: _history, ...rest } = raw
        const timed: SimulationEvent = { ...rest, time: t }
        state = { ...process(timed, { ...state, currentTime: t }), currentTime: t }
        applied.push(timed)
      }
    } finally {
      opts.setSnapshotMode?.(false)
    }
    state = snapVisualState(state, t)
    state = { ...state, currentTime: t, maxTimeReached: Math.max(state.maxTimeReached, t) }
    time = Math.max(time, t)
    opts.onHistoryApplied?.(state)
  }

  for (const event of live) {
    const eventTime = Math.max(event.time || time, time)
    const timed = { ...event, time: eventTime }
    state = { ...state, currentTime: eventTime }
    state = process(timed, state)
    applied.push(timed)
  }
  if (live.length > 0) time = Math.max(time, state.currentTime)

  return { state, applied, newTime: time }
}
