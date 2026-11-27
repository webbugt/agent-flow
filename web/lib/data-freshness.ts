/**
 * How fresh the data of the browser build is, for the top bar (review item: the bar showed counts only, so a relay that
 * silently stopped sending looked exactly like a quiet session). Pure, so it is tested without a DOM or a clock.
 *
 * Inputs are what the app already has: whether the event stream is connected, when the last LIVE event arrived (history
 * replays do not count: they say nothing about now) and when the stream connected.
 */

/** No event for this long while connected: the data is called stale, ms. */
export const STALE_AFTER_MS = 60_000

export type FreshnessLevel = 'live' | 'stale' | 'offline'

export interface Freshness {
  level: FreshnessLevel
  /** Short label for the indicator: LIVE, STALE or OFFLINE. */
  label: string
  /** "last event 12s ago", "no event yet (connected 8s ago)" or "no connection". */
  detail: string
  /** Milliseconds since the last event (or since the connection when none arrived yet); null when there is neither. */
  sinceMs: number | null
}

export interface FreshnessInput {
  now: number
  connected: boolean
  /** Arrival time of the last live event, ms since epoch; null = none since the page loaded. */
  lastEventAt: number | null
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

export function dataFreshness({ now, connected, lastEventAt, connectedAt, staleAfterMs = STALE_AFTER_MS }: FreshnessInput): Freshness {
  if (!connected) {
    const sinceMs = lastEventAt !== null ? Math.max(0, now - lastEventAt) : null
    return {
      level: 'offline',
      label: 'OFFLINE',
      detail: sinceMs !== null ? `no connection, last event ${formatAgo(sinceMs)} ago` : 'no connection',
      sinceMs,
    }
  }
  // The age counts from the last event, or from the connection when none arrived yet.
  const base = lastEventAt ?? connectedAt
  const sinceMs = base === null ? null : Math.max(0, now - base)
  const detail = lastEventAt !== null
    ? `last event ${formatAgo(sinceMs ?? 0)} ago`
    : sinceMs !== null ? `no event yet (connected ${formatAgo(sinceMs)} ago)` : 'no event yet'
  const stale = sinceMs !== null && sinceMs >= staleAfterMs
  return { level: stale ? 'stale' : 'live', label: stale ? 'STALE' : 'LIVE', detail, sinceMs }
}
