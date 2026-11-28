'use client'

import { useEffect, useState } from 'react'

/** Window height, updated on resize. `fallback` is used on the server and for the first client render. */
export function useViewportHeight(fallback = 900): number {
  const [height, setHeight] = useState(fallback)
  useEffect(() => {
    const update = () => setHeight(window.innerHeight)
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return height
}

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
