/**
 * Observed-limits message types (P6a). Mirror of `LimitsUpdatePayload` in extension/src/protocol.ts (the extension's
 * rootDir is `src`, so the two copies cannot share a file; web/lib/limits-runtime.test.ts keeps the shapes honest by
 * building payloads with the host's own builder). Keep them in sync.
 */
export type ObservedWindowKind = 'five_hour' | 'seven_day' | 'other'

export interface ObservedLimitWindow {
  key: string
  kind: ObservedWindowKind
  /** Used percentage 0-100; null when unknown or when the window has ended (`expired`). */
  usedPct: number | null
  /** End of the window, ms epoch. */
  resetsAt: number | null
  state: 'fresh' | 'stale' | 'expired'
}

/** One stored reading of the meter (numbers only; the estimate pairs it with the local usage at that time). Times are ms epoch. */
export interface ObservedReading {
  at: number
  fiveHour?: { usedPct: number; resetsAt: number }
  sevenDay?: { usedPct: number; resetsAt: number }
}

export interface LimitsUpdatePayload {
  version: 1
  seq: number
  provider: 'claude'
  source: 'statusline'
  /** The host can install / remove the wrapper when the person clicks in the UI (VS Code only). */
  canConfigure: boolean
  install: {
    state: 'not-installed' | 'installed' | 'refused' | 'broken'
    canInstall: boolean
    reason?: string
    code?: string
    shadowedBy?: string[]
    warnings?: string[]
  }
  observed: null | { at: number; stale: boolean; modelId?: string; windows: ObservedLimitWindow[] }
  /** Past readings (oldest first, at most 200). */
  history?: ObservedReading[]
  fileError?: string
}

/** Answer to a wrapper install / remove request. */
export interface StatusLineActionResult { ok: boolean; message: string }
