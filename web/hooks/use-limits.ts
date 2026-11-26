'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { applyLimitsPayload, getLimits, subscribeLimits } from '@/lib/limits-runtime'
import type { LimitsUpdatePayload } from '@/lib/costs/observed-types'

/**
 * Subscribe the page to `limits-update` messages (VS Code postMessage or the relay's SSE, both arrive through the
 * bridge). Mount once, near the root; components read the state with `useLimits`.
 */
export function useLimitsFeed(): void {
  useEffect(() => {
    if (!vscodeBridge) return
    return vscodeBridge.onLimitsUpdate(applyLimitsPayload)
  }, [])
}

/** The latest observed-limits payload, or null before the host sent one. */
export function useLimits(): LimitsUpdatePayload | null {
  return useSyncExternalStore(subscribeLimits, getLimits, getLimits)
}

/** Re-render once a minute while mounted: "resets in 2h" and the fresh -> stale shift must not freeze. */
export function useMinuteTick(): number {
  return useSyncExternalStore(subscribeMinute, minuteNow, minuteNow)
}

let minute = Math.floor(Date.now() / 60_000)
const minuteListeners = new Set<() => void>()
let minuteTimer: ReturnType<typeof setInterval> | null = null
function subscribeMinute(l: () => void): () => void {
  minuteListeners.add(l)
  if (!minuteTimer) {
    minuteTimer = setInterval(() => { minute = Math.floor(Date.now() / 60_000); for (const x of [...minuteListeners]) x() }, 15_000)
  }
  return () => {
    minuteListeners.delete(l)
    if (minuteListeners.size === 0 && minuteTimer) { clearInterval(minuteTimer); minuteTimer = null }
  }
}
function minuteNow(): number { return minute }
