'use client'

import { useEffect, useState } from 'react'

/** Window width, updated on resize. `fallback` is used on the server and for the first client render. */
export function useViewportWidth(fallback = 1280): number {
  const [width, setWidth] = useState(fallback)
  useEffect(() => {
    const update = () => setWidth(window.innerWidth)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return width
}
