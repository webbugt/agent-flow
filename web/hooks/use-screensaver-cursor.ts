'use client'

import { useEffect, useState } from 'react'
import { createCursorHider } from '@/lib/fleet/cursor-hide'

/**
 * Screensaver mouse cursor: true while it should be hidden. Hidden when the mode is on and the pointer is still,
 * shown by any pointer movement, hidden again 500 ms after the last one. The movement never leaves the mode
 * (use-screensaver.ts listens for keys and presses only). The timer is cleaned up when the mode goes off and on unmount.
 */
export function useScreensaverCursorHidden(screensaver: boolean): boolean {
  const [hidden, setHidden] = useState(true)

  useEffect(() => {
    if (!screensaver) return
    const hider = createCursorHider({
      onHiddenChange: setHidden,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: h => window.clearTimeout(h as number),
    })
    const onMove = (e: PointerEvent) => hider.move(e.clientX, e.clientY)
    hider.start()
    window.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      window.removeEventListener('pointermove', onMove)
      hider.stop()
    }
  }, [screensaver])

  return screensaver && hidden
}
