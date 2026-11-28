/**
 * The latest app state, kept in localStorage under ONE versioned key, so a reload comes back to the open tab,
 * the mode and the panels the user left. Pure functions on an injected Storage (same pattern as
 * screensaver-pref.ts), so they are testable without a DOM.
 *
 * Strict parse: anything that is not exactly the expected type falls back to the default of THAT field, a
 * missing, garbled or non-object value gives the defaults. Nothing transient is stored (hover, selection pulses,
 * drag, camera position).
 *
 * Not in here, on purpose:
 *  - screensaver mode stays on its own key (screensaver-pref.ts); options, fleet timeline visibility, the
 *    activity window and the fleet selection stay on theirs.
 *  - the session detail panel: it needs the id of the node it was opened for, and node ids do not outlive the
 *    page, so a restored open panel would show something else than what was left.
 */
import type { StorageLike } from './fleet-selection'

export const APP_STATE_KEY = 'agent-flow:app-state:v1'

export interface AppState {
  showFleet: boolean
  showTimeline: boolean
  showStats: boolean
  showHexGrid: boolean
  showCostOverlay: boolean
  showFileAttention: boolean
  showTranscript: boolean
  /** The LIMITS panel is folded. */
  limitsCollapsed: boolean
  /** The open tab (a bridge session id), or null when none was open. */
  selectedSessionId: string | null
}

export const DEFAULT_APP_STATE: AppState = {
  showFleet: false,
  showTimeline: false,
  showStats: false,
  showHexGrid: true,
  showCostOverlay: false,
  showFileAttention: false,
  showTranscript: false,
  limitsCollapsed: true,
  selectedSessionId: null,
}

const BOOLEAN_FIELDS = [
  'showFleet', 'showTimeline', 'showStats', 'showHexGrid', 'showCostOverlay', 'showFileAttention', 'showTranscript', 'limitsCollapsed',
] as const

/** The right-hand panels are mutually exclusive in the UI (opening one closes the others). */
const EXCLUSIVE_PANELS = ['showFileAttention', 'showTranscript', 'showCostOverlay'] as const

const MAX_SESSION_ID_LENGTH = 200

export function parseAppState(raw: string | null | undefined): AppState {
  const out: AppState = { ...DEFAULT_APP_STATE }
  if (typeof raw !== 'string' || raw === '') return out
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return out
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return out
  const obj = data as Record<string, unknown>
  for (const k of BOOLEAN_FIELDS) {
    if (typeof obj[k] === 'boolean') out[k] = obj[k] as boolean
  }
  const id = obj.selectedSessionId
  if (typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID_LENGTH) out.selectedSessionId = id
  // A stored state with two exclusive panels open (hand-edited, or from a bug) keeps the first one only.
  let open = false
  for (const k of EXCLUSIVE_PANELS) {
    if (!out[k]) continue
    if (open) out[k] = false
    open = true
  }
  return out
}

export function serializeAppState(state: AppState): string {
  const o: Record<string, unknown> = {}
  for (const k of BOOLEAN_FIELDS) o[k] = state[k]
  o.selectedSessionId = state.selectedSessionId
  return JSON.stringify(o)
}

export function loadAppState(storage: StorageLike | null | undefined, key = APP_STATE_KEY): AppState {
  if (!storage) return { ...DEFAULT_APP_STATE }
  try {
    return parseAppState(storage.getItem(key))
  } catch {
    return { ...DEFAULT_APP_STATE }
  }
}

/** Returns false when the write failed (quota, private mode); the app still works in memory. */
export function saveAppState(storage: StorageLike | null | undefined, state: AppState, key = APP_STATE_KEY): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, serializeAppState(state))
    return true
  } catch {
    return false
  }
}

/** What the session list needs of a session to pick the tab that opens on its own. */
export interface PickableSession {
  id: string
  status: string
  lastActivityTime: number
  idle?: boolean
}

/**
 * The tab that opens when the session list arrives and nothing is open: the tab the user left (when it is
 * still there and selectable), else the active one, else the most recently active. Idle sessions
 * (history only) are fleet-only and never auto-selected. Null when nothing is selectable.
 */
export function pickInitialSession(list: readonly PickableSession[], preferredId: string | null): string | null {
  const selectable = list.filter(s => !s.idle)
  if (selectable.length === 0) return null
  if (preferredId && selectable.some(s => s.id === preferredId)) return preferredId
  const sorted = [...selectable].sort((a, b) => {
    const aActive = a.status === 'active' ? 1 : 0
    const bActive = b.status === 'active' ? 1 : 0
    if (aActive !== bActive) return bActive - aActive
    return b.lastActivityTime - a.lastActivityTime
  })
  return sorted[0].id
}
