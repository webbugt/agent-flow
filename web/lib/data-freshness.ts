/**
 * How fresh the data of the browser build is, for the top bar (review item: the bar showed counts only, so a relay that
 * silently stopped sending looked exactly like a quiet session). Pure, so it is tested without a DOM or a clock.
 *
 * Inputs are what the app already has: whether the event stream is connected, when the last message of the stream arrived
 * (ANY message: context_update, model_detected, agent_idle and history replays all prove that the relay is alive and
 * sending) and when the stream connected. Real activity (a tool call, a message) is tracked separately and shown as
 * extra text: a calm but healthy session is LIVE, not STALE.
 */

/** No event for this long while connected: the data is called stale, ms. */
export const STALE_AFTER_MS = 60_000

export type FreshnessLevel = 'live' | 'stale' | 'offline'

export interface Freshness {
  level: FreshnessLevel
  /** Short label for the indicator: LIVE, STALE or OFFLINE. */
  label: string
  /** "last event 12s ago", "no event yet (connected 8s ago)" or "no connection"; plus " · last activity 3m 04s ago" when known. */
  detail: string
  /** Just the age, "12s": for a narrow screen, where the title attribute cannot be opened by touch. Empty when unknown. */
  short: string
  /** Milliseconds since the last event (or since the connection when none arrived yet); null when there is neither. */
  sinceMs: number | null
}

export interface FreshnessInput {
  now: number
  connected: boolean
  /** Arrival time of the last stream message of any type, ms since epoch; null = none since the page loaded. */
  lastEventAt: number | null
  /** Arrival time of the last message that shows real activity (tool call, message, spawn...), for the extra text only. */
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
  const activity = lastActivityAt !== null ? ` \u00b7 last activity ${formatAgo(Math.max(0, now - lastActivityAt))} ago` : ''
  if (!connected) {
    const sinceMs = lastEventAt !== null ? Math.max(0, now - lastEventAt) : null
    return {
      level: 'offline',
      label: 'OFFLINE',
      detail: sinceMs !== null ? `no connection, last event ${formatAgo(sinceMs)} ago` : 'no connection',
      short: sinceMs !== null ? formatAgo(sinceMs) : '',
      sinceMs,
    }
  }
  // The age counts from the last event, or from the connection when none arrived yet.
  const base = lastEventAt ?? connectedAt
  const sinceMs = base === null ? null : Math.max(0, now - base)
  const detail = lastEventAt !== null
    ? `last event ${formatAgo(sinceMs ?? 0)} ago${activity}`
    : sinceMs !== null ? `no event yet (connected ${formatAgo(sinceMs)} ago)` : 'no event yet'
  const stale = sinceMs !== null && sinceMs >= staleAfterMs
  return { level: stale ? 'stale' : 'live', label: stale ? 'STALE' : 'LIVE', detail, short: sinceMs !== null ? formatAgo(sinceMs) : '', sinceMs }
}

/** What the top bar remembers about the stream. */
export interface StreamStamps {
  /** Last stream message of any type. */
  lastEventAt: number | null
  /** Last message that shows real activity. */
  lastActivityAt: number | null
}

/** The stamps are written at most once per this long, so a busy stream does not re-render the app on every event, ms. */
export const STAMP_THROTTLE_MS = 1000

/**
 * New stamps after one stream message, or `prev` itself (same object) when nothing needs to be written. Every message
 * refreshes `lastEventAt`: the freshness marker answers "is the stream alive", and agent_idle ticks, context_update,
 * model_detected and history replays all prove it is. Only `activity` messages refresh `lastActivityAt`.
 * `activity` is `countsAsActivity(type, payload)` and is false for a history replay (it says nothing about now).
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
