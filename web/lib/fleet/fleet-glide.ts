/**
 * Glide of resource nodes on the Fleet map. The scene is rebuilt whenever the data changes and
 * placeResources gives every resource a new target; without this the node jumps there (or, when the
 * target does not change, never visibly reacts to a weight). Pure: positions in, positions out; the
 * caller supplies the elapsed time.
 *
 *   - {@link startPositions}: where a rebuilt scene starts its resources: where they are NOW (so a
 *     rebuild never teleports them), a new resource directly at its target (its entry animation is not
 *     this module's business).
 *   - {@link glideStep} / {@link glideAll}: ease towards the target, frame-rate independent.
 */
import type { Point } from './fleet-placement'

/** Time constant of the glide, ms: about two thirds of the way after this, 95% after three times it. */
export const GLIDE_TAU_MS = 380
/** Closer than this to its target (world units) a node is there. */
export const GLIDE_EPSILON = 0.4

/** One step of an exponential ease towards `target`; frame-rate independent (two half steps = one whole). */
export function glideStep(cur: Point, target: Point, dtMs: number, tauMs: number = GLIDE_TAU_MS): Point {
  const dx = target.x - cur.x
  const dy = target.y - cur.y
  if (Math.hypot(dx, dy) <= GLIDE_EPSILON) return { x: target.x, y: target.y }
  if (!(dtMs > 0)) return { x: cur.x, y: cur.y }
  const k = 1 - Math.exp(-dtMs / tauMs)
  const next = { x: cur.x + dx * k, y: cur.y + dy * k }
  return Math.hypot(target.x - next.x, target.y - next.y) <= GLIDE_EPSILON ? { x: target.x, y: target.y } : next
}

/**
 * Starting positions for a rebuilt scene: `current` (where the nodes are drawn now) for every id that
 * has a target and is already on the map, the target for new ids. Ids without a target are dropped.
 */
export function startPositions(current: ReadonlyMap<string, Point>, targets: ReadonlyMap<string, Point>): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const [id, target] of targets) {
    const cur = current.get(id)
    out.set(id, cur ? { x: cur.x, y: cur.y } : { x: target.x, y: target.y })
  }
  return out
}

export interface GlideResult<T extends Point> {
  /** Same map when nothing moved, else a copy with the moved nodes replaced. */
  nodes: ReadonlyMap<string, T>
  /** No node of `targets` is away from its target any more: the caller can stop its frame loop. */
  settled: boolean
}

/**
 * Moves every node that has a target one step towards it. Ids in `hold` (nodes the user is dragging or
 * dropped) are left where they are and count as settled. Nodes without a target are left alone.
 */
export function glideAll<T extends Point>(
  nodes: ReadonlyMap<string, T>, targets: ReadonlyMap<string, Point>, dtMs: number, hold?: ReadonlyMap<string, unknown>,
): GlideResult<T> {
  let out: Map<string, T> | null = null
  let settled = true
  for (const [id, target] of targets) {
    const node = nodes.get(id)
    if (!node || hold?.has(id)) continue
    if (node.x === target.x && node.y === target.y) continue
    const next = glideStep(node, target, dtMs)
    if (next.x !== target.x || next.y !== target.y) settled = false
    if (next.x === node.x && next.y === node.y) continue
    if (!out) out = new Map(nodes)
    out.set(id, { ...node, x: next.x, y: next.y })
  }
  return { nodes: out ?? nodes, settled }
}
