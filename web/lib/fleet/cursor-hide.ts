/**
 * Screensaver mouse cursor: hidden while nothing moves, shown again by any pointer movement, hidden again
 * after `CURSOR_HIDE_DELAY_MS` of stillness. Pure: the timer functions are injected, so the timing is
 * testable without a DOM or real clocks. The pointer move never leaves the screensaver (only a key or a click
 * does, see screensaver-pref.ts); this only decides whether the cursor is drawn.
 */

/** Stillness after which the cursor hides again, ms. */
export const CURSOR_HIDE_DELAY_MS = 500

export interface CursorHiderOptions {
  /** Called with the new value whenever the hidden state changes (and once on `start`). */
  onHiddenChange: (hidden: boolean) => void
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  delayMs?: number
}

export interface CursorHider {
  /** Screensaver went on: the cursor is hidden. */
  start: () => void
  /** A pointer event at (x, y). A repeat of the same position (a synthetic move after a layout change) is not a movement. */
  move: (x: number, y: number) => void
  /** Screensaver went off or the component unmounted: the timer is gone; no callback fires afterwards. */
  stop: () => void
}

export function createCursorHider(opts: CursorHiderOptions): CursorHider {
  const delay = opts.delayMs ?? CURSOR_HIDE_DELAY_MS
  let timer: unknown = null
  let hidden = true
  let running = false
  let last: { x: number; y: number } | null = null

  const emit = (next: boolean) => {
    if (hidden === next) return
    hidden = next
    opts.onHiddenChange(next)
  }
  const clear = () => {
    if (timer !== null) { opts.clearTimer(timer); timer = null }
  }

  return {
    start() {
      running = true
      last = null
      clear()
      hidden = true
      opts.onHiddenChange(true)
    },
    move(x, y) {
      if (!running) return
      if (last && last.x === x && last.y === y) return
      last = { x, y }
      emit(false)
      clear()
      timer = opts.setTimer(() => { timer = null; emit(true) }, delay)
    },
    stop() {
      running = false
      last = null
      clear()
    },
  }
}
