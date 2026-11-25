/**
 * Whether the fleet timeline panel is shown. Default: visible. The choice is kept in
 * localStorage. Pure functions on an injected Storage, so they are testable without a DOM.
 * Hiding only hides the panel: no data, session or selection is touched.
 */
import type { StorageLike } from './fleet-selection'

export const FLEET_TIMELINE_KEY = 'agent-flow:fleet-timeline-visible:v1'

/** Height the map reserves for the timeline panel when it is shown, px. */
export const FLEET_TIMELINE_INSET = 380

export function parseTimelineVisible(raw: string | null | undefined): boolean {
  // Only an explicit "hidden" hides; a missing or garbled value keeps the default (visible).
  return raw !== 'hidden'
}

export function loadTimelineVisible(storage: StorageLike | null | undefined, key = FLEET_TIMELINE_KEY): boolean {
  if (!storage) return true
  try {
    return parseTimelineVisible(storage.getItem(key))
  } catch {
    return true
  }
}

/** Returns false when the write failed (quota, private mode); the toggle still works in memory. */
export function saveTimelineVisible(storage: StorageLike | null | undefined, visible: boolean, key = FLEET_TIMELINE_KEY): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, visible ? 'visible' : 'hidden')
    return true
  } catch {
    return false
  }
}

/** Height of the playback bar that floats over the bottom of the screen, px. It stays when the timeline is hidden. */
export const PLAYBACK_BAR_INSET = 72

/**
 * The space the map keeps free at the bottom: the timeline panel's, or, when it is hidden, only what the
 * playback bar covers (the map takes the rest: the full height of the screen above the bar).
 */
export function mapInsetBottom(timelineVisible: boolean): number {
  return timelineVisible ? FLEET_TIMELINE_INSET : PLAYBACK_BAR_INSET
}
