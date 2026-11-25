/**
 * Screenshot mode for the verification harness (scripts/shot.ts).
 *
 * Active ONLY when the page URL has `?shot=1`. Without it nothing in this module
 * changes behaviour: SHOT_MODE is false, no globals are installed and every
 * hook registration is a no-op (covered by web/lib/shot-mode.test.ts).
 *
 * With `?shot=1`:
 *  - Math.random is replaced by a seeded generator, so background particles and
 *    other random visuals are the same on every run;
 *  - CSS animations and transitions are switched off;
 *  - the canvas draw loop uses a fixed clock (no pulsing, drifting or fading), see
 *    canvas.tsx;
 *  - `window.__AF_TEST__` exposes what the harness needs to drive the page:
 *      ready            true once the page has been frozen by `freeze()`
 *      agentNames()     names of the agents currently on the canvas
 *      agentRect(name)  viewport rectangle of an agent node ("first" = first agent)
 *      pillRect(name)   viewport rectangle of an agent's cost pill (cost overlay on)
 *      freeze()         pause the simulation so the picture stops changing
 *      settled()        true when the camera has stopped moving
 *      setPanel(name)   open a panel: 'files' | 'transcript' | 'cost' | 'session'
 *      seekEnd()        put the playhead at the last event and pause (what the screenshot shows is then
 *                       independent of how long the page has been running)
 */

export interface ShotRect { x: number; y: number; w: number; h: number }

export interface ShotHooks {
  agentNames: () => string[]
  agentRect: (name: string) => ShotRect | null
  pillRect: (name: string) => ShotRect | null
  freeze: () => void
  settled: () => boolean
  setPanel: (name: string) => void
  seekEnd: () => void
}

export interface ShotApi extends ShotHooks {
  ready: boolean
}

declare global {
  interface Window {
    __AF_TEST__?: ShotApi
  }
}

/** True when `search` (a location.search string) turns screenshot mode on. */
export function isShotSearch(search: string): boolean {
  return new URLSearchParams(search).get('shot') === '1'
}

export const SHOT_MODE: boolean = typeof window !== 'undefined' && isShotSearch(window.location.search)

/** Small seeded PRNG (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hooks: Partial<ShotHooks> = {}

/** Register a hook the harness can call. No-op outside shot mode. Returns an unregister function. */
export function registerShotHook<K extends keyof ShotHooks>(name: K, fn: ShotHooks[K]): () => void {
  if (!SHOT_MODE) return () => {}
  hooks[name] = fn
  return () => { if (hooks[name] === fn) delete hooks[name] }
}

/** Mark the page as frozen and ready for a screenshot. No-op outside shot mode. */
export function markShotReady(): void {
  if (SHOT_MODE && window.__AF_TEST__) window.__AF_TEST__.ready = true
}

if (SHOT_MODE) {
  Math.random = seededRandom(0x5eed)
  // CSS animations (the pulsing LIVE dot) would make two runs differ by a few pixels
  const style = document.createElement('style')
  style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
  document.documentElement.appendChild(style)
  const missing = (name: string) => { throw new Error(`__AF_TEST__.${name} is not available yet`) }
  window.__AF_TEST__ = {
    ready: false,
    agentNames: () => hooks.agentNames?.() ?? [],
    agentRect: name => hooks.agentRect?.(name) ?? null,
    pillRect: name => hooks.pillRect?.(name) ?? null,
    freeze: () => (hooks.freeze ? hooks.freeze() : missing('freeze')),
    settled: () => hooks.settled?.() ?? false,
    setPanel: name => (hooks.setPanel ? hooks.setPanel(name) : missing('setPanel')),
    seekEnd: () => (hooks.seekEnd ? hooks.seekEnd() : missing('seekEnd')),
  }
}
