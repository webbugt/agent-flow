/**
 * Swallow the rest of the press that left the screensaver. A press is pointerdown, then mousedown, mouseup
 * and click. The canvas selects a node on mouseup (and starts a drag on mousedown), so swallowing only the
 * click is not enough: all three must stop in the capture phase, before React's root listener sees them.
 * Pure on an injected EventTarget and timer, so it is testable without a DOM.
 */

/** Longest the guard lives when no click ever arrives (press released elsewhere, cancelled, touch). ms. */
export const SWALLOW_GESTURE_MS = 600

const GESTURE_EVENTS = ['mousedown', 'mouseup', 'click'] as const

export interface SwallowTimer {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
}

const REAL_TIMER: SwallowTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/**
 * Starts swallowing mousedown / mouseup / click on `target` (capture phase). It stops by itself after the
 * click (the end of the press) or after SWALLOW_GESTURE_MS. Returns a function that stops it at once.
 */
export function swallowGesture(target: EventTarget, timer: SwallowTimer = REAL_TIMER, ms = SWALLOW_GESTURE_MS): () => void {
  let stopped = false
  let timerId: unknown
  const handler = (e: Event) => {
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.type === 'click') stop()
  }
  function stop() {
    if (stopped) return
    stopped = true
    timer.clear(timerId)
    for (const t of GESTURE_EVENTS) target.removeEventListener(t, handler, true)
  }
  for (const t of GESTURE_EVENTS) target.addEventListener(t, handler, true)
  timerId = timer.set(stop, ms)
  return stop
}
