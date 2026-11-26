'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { vscodeBridge } from '@/lib/vscode-bridge'
import { activeCostsVersion, subscribeActiveCosts } from '@/lib/costs/active'
import { applyCostsPayload, getCostsStatus, subscribeCostsStatus, type CostsStatus } from '@/lib/costs-runtime'

/**
 * Subscribe the page to `costs-config` messages (VS Code postMessage or the relay's SSE, both arrive through the
 * bridge) and return the current status for the error banner. Mount once, near the root.
 */
export function useCostsConfig(): CostsStatus {
  useEffect(() => {
    if (!vscodeBridge) return
    return vscodeBridge.onCostsConfig(applyCostsPayload)
  }, [])
  return useSyncExternalStore(subscribeCostsStatus, getCostsStatus, getCostsStatus)
}

/** Re-render when the active config changes (components that format money outside the canvas loop). */
export function useActiveCostsVersion(): number {
  return useSyncExternalStore(subscribeActiveCosts, activeCostsVersion, activeCostsVersion)
}
