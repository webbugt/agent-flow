'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { loadScreensaver, saveScreensaver, shouldExitScreensaver } from '@/lib/fleet/screensaver-pref'
import { swallowGesture } from '@/lib/fleet/swallow-gesture'
import { parseViewParams } from '@/lib/fleet/url-view'

export interface Screensaver {
  /** Screensaver mode is on: the UI is hidden, the map and its activity animation stay. */
  on: boolean
  toggle: () => void
  exit: () => void
}

/**
 * Screensaver mode ("hide all UI"). Off by default; the choice is kept in localStorage (read after
 * mount, so server and client render the same first frame), so a reload keeps it on only when the user
 * left it on. While it is on, any key or click leaves it. The press that leaves it is consumed (a key
 * does not also fire its shortcut, a click does not also select the node under it or start a drag).
 */
export function useScreensaver(): Screensaver {
  const [on, setOn] = useState(false)
  const onRef = useRef(false)
  // performance.now() when the mode was entered: input that began before it must not leave it again
  // (the click on the button, or the `s` key, that turned it on is still bubbling when the listener is added).
  const enteredAtRef = useRef(0)

  const set = useCallback((next: boolean) => {
    if (next) enteredAtRef.current = performance.now()
    onRef.current = next
    saveScreensaver(window.localStorage, next)
    setOn(next)
  }, [])

  // Restored after mount: only a mode the user left on comes back. `?screensaver=1|0` in the URL wins over the stored
  // choice (and is saved, so the stored choice matches what is shown); without it the stored choice applies.
  useEffect(() => {
    const fromUrl = parseViewParams(window.location.search).screensaver
    if (fromUrl !== undefined) saveScreensaver(window.localStorage, fromUrl)
    if (fromUrl ?? loadScreensaver(window.localStorage)) {
      enteredAtRef.current = performance.now()
      onRef.current = true
      setOn(true)
    }
  }, [])

  const exit = useCallback(() => set(false), [set])
  const toggle = useCallback(() => set(!onRef.current), [set])

  useEffect(() => {
    if (!on) return
    const onInput = (e: KeyboardEvent | PointerEvent) => {
      if (!shouldExitScreensaver({ type: e.type, key: (e as KeyboardEvent).key, timeStamp: e.timeStamp }, enteredAtRef.current)) return
      if (e.type === 'keydown') e.stopPropagation()
      if (e.type === 'pointerdown') {
        // The rest of this press (mousedown starts a drag, mouseup selects the node, then click) must not reach the
        // canvas. It goes away by itself after the click.
        swallowGesture(window)
      }
      set(false)
    }
    window.addEventListener('keydown', onInput, true)
    window.addEventListener('pointerdown', onInput, true)
    return () => {
      window.removeEventListener('keydown', onInput, true)
      window.removeEventListener('pointerdown', onInput, true)
    }
  }, [on, set])

  return { on, toggle, exit }
}
