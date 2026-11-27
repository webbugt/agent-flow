/**
 * Screensaver auto view: zoom the fleet map so every ACTIVE node is in view, keep it that way as nodes come
 * and go. Pure, so the bounding math is testable without a canvas.
 *
 * "Active node" = a node drawn at full strength: agent state is not `idle` / `complete` (resource blocks and
 * session nodes use `tool_calling` while active and `idle` otherwise, see fleet-scene.ts), it is not a ghost
 * (a node that is leaving) and it is not faded out. When nothing is active, every node that is drawn counts.
 */
import type { Transform } from './fleet-camera'

export interface FitNode { x: number; y: number; r: number }

export interface FitView { width: number; height: number }

export interface FitOptions {
  /** Screen margin kept free on every side, px. */
  marginPx: number
  /** Extra room under the nodes for their label, world units. */
  labelRoom: number
  minScale: number
  maxScale: number
}

/** What the screensaver fit needs of a node (a subset of `Agent`). */
export interface FitAgentLike {
  id: string
  state: string
  x: number
  y: number
  opacity: number
  isMain: boolean
}

/** Below this opacity a node is not visible enough to need room (it is fading in or out). */
export const MIN_VISIBLE_OPACITY = 0.1

export function isActiveNode(a: Pick<FitAgentLike, 'state' | 'opacity'>): boolean {
  return a.state !== 'idle' && a.state !== 'complete' && a.opacity > MIN_VISIBLE_OPACITY
}

/**
 * The nodes the screensaver view has to keep in sight: the active ones, else every drawn one, else
 * (all faded) every node. Ghosts (leaving nodes) never count while another node is left.
 */
export function pickFitAgents<A extends FitAgentLike>(agents: Iterable<A>, ghosts: ReadonlySet<string> = new Set()): A[] {
  const all = [...agents]
  const live = all.filter(a => !ghosts.has(a.id))
  const active = live.filter(isActiveNode)
  if (active.length > 0) return active
  const drawn = live.filter(a => a.opacity > MIN_VISIBLE_OPACITY)
  if (drawn.length > 0) return drawn
  return live.length > 0 ? live : all
}

/**
 * The camera transform that puts every node (its radius included) inside the view with `marginPx` free on
 * each side. The scale is clamped to [minScale, maxScale] (a single node must not fill the screen); the
 * bounds are centred. Null when there is nothing to fit or the view has no size.
 */
export function fitToNodes(nodes: readonly FitNode[], view: FitView, opts: FitOptions): Transform | null {
  if (nodes.length === 0 || view.width <= 1 || view.height <= 1) return null
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x - n.r)
    maxX = Math.max(maxX, n.x + n.r)
    minY = Math.min(minY, n.y - n.r)
    maxY = Math.max(maxY, n.y + n.r + opts.labelRoom)
  }
  const boundsW = Math.max(maxX - minX, 1)
  const boundsH = Math.max(maxY - minY, 1)
  // A margin larger than the view would make the available room negative: keep at least a sliver.
  const availW = Math.max(view.width - 2 * opts.marginPx, view.width * 0.2)
  const availH = Math.max(view.height - 2 * opts.marginPx, view.height * 0.2)
  const scale = Math.max(opts.minScale, Math.min(opts.maxScale, availW / boundsW, availH / boundsH))
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return { scale, x: view.width / 2 - cx * scale, y: view.height / 2 - cy * scale }
}
