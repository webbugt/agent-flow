import { SHOT_MODE } from '@/lib/shot-mode'

declare global {
  interface Window {
    /** Screenshot mode only (?shot=1): a number here pins the clock the entry/exit animation reads. */
    __AF_FLEET_CLOCK__?: number
  }
}

/**
 * The clock of the Fleet map's entry/exit animation, epoch ms. `Date.now()`, except in screenshot mode
 * (?shot=1) where the harness can pin it (`window.__AF_FLEET_CLOCK__ = <ms>`) to take the same frame of
 * an animation on every run. Outside screenshot mode the override is ignored.
 */
export function fleetNow(): number {
  if (SHOT_MODE && typeof window !== 'undefined' && typeof window.__AF_FLEET_CLOCK__ === 'number') return window.__AF_FLEET_CLOCK__
  return Date.now()
}
