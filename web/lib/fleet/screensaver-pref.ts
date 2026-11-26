/**
 * Screensaver mode ("hide all UI"): the choice is kept in localStorage, and the rule for what
 * leaves it. Pure functions on an injected Storage, so they are testable without a DOM.
 *
 * Default: off. Only an explicit "on" turns it on, so a reload keeps it on only if the user enabled it
 * (and left it on). Leaving it (any key, any click) writes "off".
 */
import type { StorageLike } from './fleet-selection'

export const SCREENSAVER_KEY = 'agent-flow:screensaver:v1'

/** The key that toggles it. Lower case `s` only: Shift+S keeps the old stats toggle. */
export const SCREENSAVER_TOGGLE_KEY = 's'

export function parseScreensaver(raw: string | null | undefined): boolean {
  return raw === 'on'
}

export function loadScreensaver(storage: StorageLike | null | undefined, key = SCREENSAVER_KEY): boolean {
  if (!storage) return false
  try {
    return parseScreensaver(storage.getItem(key))
  } catch {
    return false
  }
}

/** Returns false when the write failed (quota, private mode); the mode still works in memory. */
export function saveScreensaver(storage: StorageLike | null | undefined, on: boolean, key = SCREENSAVER_KEY): boolean {
  if (!storage) return false
  try {
    storage.setItem(key, on ? 'on' : 'off')
    return true
  } catch {
    return false
  }
}

/** Keys that are only a modifier being held: they do not count as "any key". */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn', 'OS'])

export interface ExitEventLike {
  type: string
  key?: string
  /** DOMHighResTimeStamp of the event (same clock as performance.now()). */
  timeStamp: number
}

/**
 * Does this input event leave the screensaver? Any key press (a lone modifier does not count) or any click /
 * touch (`pointerdown`). Events that began before the mode was entered do not: the click on the button
 * (or the "s" key) that turned it on is still bubbling when the listener is installed.
 */
export function shouldExitScreensaver(ev: ExitEventLike, enteredAt: number): boolean {
  if (ev.timeStamp < enteredAt) return false
  if (ev.type === 'pointerdown') return true
  if (ev.type === 'keydown') return !!ev.key && !MODIFIER_KEYS.has(ev.key)
  return false
}
