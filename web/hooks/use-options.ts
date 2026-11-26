import { useSyncExternalStore } from 'react'
import { getOptions, getServerOptions, subscribeOptions } from '@/lib/options-store'
import type { AgentFlowOptions } from '@/lib/fleet/options-registry'

/**
 * The current options, live: a change in the options panel (or in another tab) re-renders the caller at once.
 * The first (hydration) render sees the defaults, then the stored values, so server and client markup match.
 */
export function useOptions(): AgentFlowOptions {
  return useSyncExternalStore(subscribeOptions, getOptions, getServerOptions)
}
