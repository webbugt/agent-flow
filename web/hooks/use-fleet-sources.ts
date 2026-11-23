import { useEffect, useState } from 'react'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'

export interface FleetSources {
  kanban: PublicKanbanBoardNode[]
  supermemory: SupermemoryNamespaceNode[]
}

const EMPTY: FleetSources = { kanban: [], supermemory: [] }

/**
 * Poll the read-only fleet endpoint (/api/fleet) for Kanban board and
 * Supermemory namespace nodes. Only polls while `enabled` (panel open and not
 * in demo mode). A failed poll keeps the previous data; the endpoint being
 * absent (VS Code webview, static build) just leaves the lanes empty.
 */
export function useFleetSources(enabled: boolean, intervalMs = 10_000, endpoint = '/api/fleet'): FleetSources {
  const [sources, setSources] = useState<FleetSources>(EMPTY)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(endpoint, { cache: 'no-store' })
        if (!res.ok) return
        const data = await res.json() as Partial<FleetSources>
        if (!cancelled) setSources({ kanban: data.kanban ?? [], supermemory: data.supermemory ?? [] })
      } catch {
        // endpoint unavailable: keep what we have
      }
    }
    void poll()
    const timer = setInterval(poll, intervalMs)
    return () => { cancelled = true; clearInterval(timer) }
  }, [enabled, intervalMs, endpoint])

  return sources
}
