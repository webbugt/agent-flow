/**
 * How fresh the data of the browser build is, for the top bar. Pure, so it is tested without a DOM or a clock.
 *
 * Two different clocks, on purpose:
 *  - LIVE / STALE / OFFLINE answers "is the relay up and talking to this page?". It follows ANY stream message
 *    (context_update, model_detected, the relay's one-per-second agent_idle ticks, history replays) and the connection.
 *    A stream that goes silent turns STALE after STALE_AFTER_MS; a dropped connection is OFFLINE.
 *  - The visible age is the age of the last REAL activity (a tool call, a message, a spawn, a model call: `showsLiveActivity`). The relay's
 *    agent_idle ticks and its quiet-timeout completion (`agent_complete` with `reason: 'quiet'`, sent by the relay, the extension,
 *    the Codex watcher and the Hermes log watcher alike) are NOT activity, so a session that went quiet reads
 *    "LIVE · last activity 3m 04s ago" and the age grows, instead of "last event 0s ago" forever.
 */
import { countsAsActivity } from './fleet/fleet-model'

/** No stream message for this long while connected: the stream is called stale, ms. */
export const STALE_AFTER_MS = 60_000

export type FreshnessLevel = 'live' | 'stale' | 'offline'

export interface Freshness {
  level: FreshnessLevel
  /** Short label for the indicator: LIVE, STALE or OFFLINE. */
  label: string
  /**
   * LIVE: "last activity 12s ago" (or "no activity since connect (8s ago)"). STALE: "no message from the relay for 1m 12s",
   * plus " · last activity ..." when known. OFFLINE: "no connection", plus the age of the last message and of the last activity.
   */
  detail: string
  /** Just an age, for a narrow screen, where the title attribute cannot be opened by touch: the age of the last activity when
   * LIVE, of the silence when STALE, of the last message when OFFLINE. Empty when unknown. */
  short: string
  /** Milliseconds since the last stream message (or since the connection when none arrived yet); null when there is neither. */
  sinceMs: number | null
}

export interface FreshnessInput {
  now: number
  connected: boolean
  /** Arrival time of the last stream message of ANY type (liveness of the relay), ms since epoch; null = none since the page loaded. */
  lastEventAt: number | null
  /** Arrival time of the last message that shows real activity (tool call, message, spawn...): this is the age that is shown. */
  lastActivityAt?: number | null
  /** When the stream last connected, ms since epoch; null = never. */
  connectedAt: number | null
  staleAfterMs?: number
}

/** "5s", "3m 04s", "2h 05m": whole units, never negative, never NaN. */
export function formatAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h ${String(m % 60).padStart(2, '0')}m`
}

export function dataFreshness({ now, connected, lastEventAt, lastActivityAt = null, connectedAt, staleAfterMs = STALE_AFTER_MS }: FreshnessInput): Freshness {
  const activityMs = lastActivityAt !== null ? Math.max(0, now - lastActivityAt) : null
  const activity = activityMs !== null ? ` \u00b7 last activity ${formatAgo(activityMs)} ago` : ''
  if (!connected) {
    const sinceMs = lastEventAt !== null ? Math.max(0, now - lastEventAt) : null
    return {
      level: 'offline',
      label: 'OFFLINE',
      detail: (sinceMs !== null ? `no connection, last message ${formatAgo(sinceMs)} ago` : 'no connection') + activity,
      short: sinceMs !== null ? formatAgo(sinceMs) : '',
      sinceMs,
    }
  }
  // Liveness counts from the last stream message, or from the connection when none arrived yet.
  const base = lastEventAt ?? connectedAt
  const sinceMs = base === null ? null : Math.max(0, now - base)
  if (sinceMs !== null && sinceMs >= staleAfterMs) {
    return { level: 'stale', label: 'STALE', detail: `no message from the relay for ${formatAgo(sinceMs)}${activity}`, short: formatAgo(sinceMs), sinceMs }
  }
  // Live: the age shown is the age of the last real activity, never the age of an idle tick.
  const sinceConnect = connectedAt !== null ? Math.max(0, now - connectedAt) : null
  const detail = activityMs !== null
    ? `last activity ${formatAgo(activityMs)} ago`
    : sinceConnect !== null ? `no activity since connect (${formatAgo(sinceConnect)} ago)` : 'no activity yet'
  return { level: 'live', label: 'LIVE', detail, short: activityMs !== null ? formatAgo(activityMs) : '', sinceMs }
}

/**
 * Does this LIVE stream message show real activity, for the age in the top bar? The fleet activity filter's rule
 * (`countsAsActivity`: tool call, message, spawn, a real completion; not agent_idle, not the quiet-timeout completion) plus
 * `context_update`: the relay emits it only when a model call or turn just reported usage (never on a timer), so it proves a
 * session worked just now even when its tool and message events arrive from another source. agent_idle, model_detected
 * (sent once when the model name changes) and history replays are not activity.
 */
export function showsLiveActivity(type: string, payload: Record<string, unknown> | undefined, history: boolean | undefined): boolean {
  if (history) return false
  return type === 'context_update' || countsAsActivity(type, payload)
}

/** What the top bar remembers about the stream. */
export interface StreamStamps {
  /** Last stream message of any type, agent_idle ticks included: liveness of the relay only, never shown as an age. */
  lastEventAt: number | null
  /** Last live message that shows real activity (not an agent_idle tick, not a history replay): the age that is shown. */
  lastActivityAt: number | null
}

/** The stamps are written at most once per this long, so a busy stream does not re-render the app on every event, ms. */
export const STAMP_THROTTLE_MS = 1000

/**
 * New stamps after one stream message, or `prev` itself (same object) when nothing needs to be written. Every message
 * refreshes `lastEventAt`, which only drives LIVE / STALE ("is the relay still talking"): agent_idle ticks, context_update,
 * model_detected and history replays all prove it is. Only `activity` messages refresh `lastActivityAt`, the age that is
 * shown, so the relay's agent_idle ticks (one per quiet session per second) never reset it.
 * `activity` is `showsLiveActivity(type, payload, history)` and is false for a history replay (it says nothing about now).
 */
export function stampStreamMessage(prev: StreamStamps, now: number, activity: boolean): StreamStamps {
  const eventDue = prev.lastEventAt === null || now - prev.lastEventAt >= STAMP_THROTTLE_MS
  const activityDue = activity && (prev.lastActivityAt === null || now - prev.lastActivityAt >= STAMP_THROTTLE_MS)
  if (!eventDue && !activityDue) return prev
  return {
    lastEventAt: eventDue ? now : prev.lastEventAt,
    lastActivityAt: activityDue ? now : prev.lastActivityAt,
  }
}
