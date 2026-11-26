/**
 * Swallow the rest of the press that left the screensaver. A press is pointerdown, then mousedown, mouseup
 * and click. The canvas selects a node on mouseup (and starts a drag on mousedown), so swallowing only the
 * click is not enough: all three must stop in the capture phase, before React's root listener sees them.
 * Pure on an injected EventTarget and timer, so it is testable without a DOM.
 */

/**
 * Longest the guard waits for the click after the button is released (pointerup / pointercancel). The guard is
 * armed while the press is still down, so it never expires under a held button; this timer only covers a press
 * that ends without a click (released elsewhere, cancelled, touch where the mouse events follow the pointerup). ms.
 */
export const SWALLOW_GESTURE_MS = 600

const GESTURE_EVENTS = ['mousedown', 'mouseup', 'click'] as const
const RELEASE_EVENTS = ['pointerup', 'pointercancel'] as const

export interface SwallowTimer {
  set: (fn: () => void, ms: number) => unknown
  clear: (id: unknown) => void
}

const REAL_TIMER: SwallowTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: id => clearTimeout(id as ReturnType<typeof setTimeout>),
}

/**
 * Starts swallowing mousedown / mouseup / click on `target` (capture phase). Call it from the pointerdown of the
 * press: the press is then still down, so there is no timer yet. It stops after the click (the end of the press),
 * or SWALLOW_GESTURE_MS after pointerup / pointercancel when no click follows, or when a new pointerdown starts
 * (a press whose release we never saw must not eat the next one). Returns a function that stops it at once.
 */
export function swallowGesture(target: EventTarget, timer: SwallowTimer = REAL_TIMER, ms = SWALLOW_GESTURE_MS): () => void {
  let stopped = false
  let timerId: unknown
  const handler = (e: Event) => {
    e.stopImmediatePropagation()
    e.preventDefault()
    if (e.type === 'click') stop()
  }
  // Not swallowed: the page still sees the pointer events. The release only starts the fallback timer.
  const onRelease = () => {
    if (stopped) return
    timer.clear(timerId)
    timerId = timer.set(stop, ms)
  }
  const onNewPress = () => stop()
  function stop() {
    if (stopped) return
    stopped = true
    timer.clear(timerId)
    for (const t of GESTURE_EVENTS) target.removeEventListener(t, handler, true)
    for (const t of RELEASE_EVENTS) target.removeEventListener(t, onRelease, true)
    target.removeEventListener('pointerdown', onNewPress, true)
  }
  for (const t of GESTURE_EVENTS) target.addEventListener(t, handler, true)
  for (const t of RELEASE_EVENTS) target.addEventListener(t, onRelease, true)
  target.addEventListener('pointerdown', onNewPress, true)
  return stop
}
