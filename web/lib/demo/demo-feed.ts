/**
 * What the /demo route hands to the visualiser besides the bridge: its own Kanban and Supermemory nodes, and
 * two counters that tell the view the demo state changed. Present = the view is the demo, and no live read is made.
 */
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'

/** The shape of what the Fleet view reads from /api/fleet (same fields as `FleetSources` in hooks/use-fleet-sources). */
export interface DemoSources {
  kanban: PublicKanbanBoardNode[]
  supermemory: SupermemoryNamespaceNode[]
}

export interface DemoFeed {
  /** The demo's boards and namespaces (in live mode these come from /api/fleet). */
  sources: DemoSources
  /** Changes with every demo action: the view refreshes the Fleet map from the buffers at once. */
  version: number
  /** Counts resets: the view clears its canvas when it grows. */
  resetCount: number
  /** Width in px the Fleet map and timeline leave free on the right for the open demo panel (0 = none). */
  rightInset: number
}

/** Width of the demo control panel and the gap to the screen edge. */
export const DEMO_PANEL_WIDTH = 300
export const DEMO_PANEL_GAP = 16

/**
 * What the map keeps free for the demo panel: its width while it is open, unless that would leave the map narrower
 * than `minMapWidth` (a phone: the panel then overlays the map, as the session detail does).
 */
export function demoPanelInset(open: boolean, viewportWidth: number, minMapWidth = 280): number {
  if (!open) return 0
  const w = DEMO_PANEL_WIDTH + DEMO_PANEL_GAP
  return viewportWidth - w >= minMapWidth ? w : 0
}

/**
 * Whether the Fleet view polls the live /api/fleet endpoint. Never in the demo (it has its own sources), never
 * with the built-in mock data, only while the Fleet view is open.
 */
export function shouldPollLiveFleet(opts: { showFleet: boolean; useMockData: boolean; demo: boolean }): boolean {
  return opts.showFleet && !opts.useMockData && !opts.demo
}
