'use client'

import { useEffect, type RefObject } from 'react'
import { publishInset } from '@/lib/bottom-stack'

/**
 * Publishes the distance from the bottom of the screen to the TOP of an element as a CSS variable on <html>, and keeps it
 * current when the element resizes (a review bar that wraps, a LIMITS panel that folds) or the window does. Panels that
 * sit above it read the variable in `bottom:` (see lib/bottom-stack.ts), so they stack instead of overlapping.
 * `enabled` false clears the variable (the element is not part of the stack right now).
 */
export function usePublishInset(ref: RefObject<HTMLElement | null>, name: string, enabled = true): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) { publishInset(name, null); return }
    const update = () => publishInset(name, window.innerHeight - el.getBoundingClientRect().top)
    update()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update)
    observer?.observe(el)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
      publishInset(name, null)
    }
  }, [ref, name, enabled])
}
