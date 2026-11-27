/**
 * The position tween (lib/fleet/fleet-tween) applied to a Fleet scene frame.
 *
 *   - {@link positionsOf}: where the agents of a frame are (what {@link retarget} compares the new scene with).
 *   - {@link tweenedFrame}: the frame to draw at `now`: the scene frame (final places) with every agent
 *     that has a leg at its tweened place, its satellites keeping their offset from it, and every node
 *     the user moved (`hold`) exactly where it was dropped, so a drag never waits for a tween.
 *
 * Clouds and their halos need nothing of their own: the canvas computes them from the member positions
 * of the frame it draws, so they glide with their members. Pure: no clock (the caller passes `now`), no DOM.
 */
import type { Agent } from '@/lib/agent-types'
import type { Point } from '@/lib/fleet/fleet-placement'
import { positionsAt, type Legs } from '@/lib/fleet/fleet-tween'
import type { SimulationState } from './types'

/** Positions of the agents (sessions, resources, ghosts) of a frame, by scene id. */
export function positionsOf(frame: Pick<SimulationState, 'agents'>): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const [id, a] of frame.agents) out.set(id, { x: a.x, y: a.y })
  return out
}

export interface TweenedFrame {
  frame: SimulationState
  /** No leg is running any more at `now`. */
  settled: boolean
}

/**
 * `target` is the scene frame as built (everything at its final place). Returns `target` itself when
 * nothing is away from its place (no copies per frame once the map is at rest).
 */
export function tweenedFrame(
  target: SimulationState, legs: Legs | null | undefined, now: number, hold?: ReadonlyMap<string, Point>,
): TweenedFrame {
  const { positions, settled } = positionsAt(legs, now)
  // A held node is where the user put it, whatever its leg says.
  if (hold) for (const [id, p] of hold) if (target.agents.has(id)) positions.set(id, p)

  let agents: Map<string, Agent> | null = null
  // How far each moved agent is from its place in `target`: its satellites follow by the same amount.
  const shift = new Map<string, Point>()
  for (const [id, p] of positions) {
    const a = target.agents.get(id)
    if (!a || (a.x === p.x && a.y === p.y)) continue
    if (!agents) agents = new Map(target.agents)
    agents.set(id, { ...a, x: p.x, y: p.y })
    shift.set(id, { x: p.x - a.x, y: p.y - a.y })
  }
  if (!agents) return { frame: target, settled }

  const toolCalls = new Map(target.toolCalls)
  for (const [tid, tc] of target.toolCalls) {
    const d = shift.get(tc.agentId)
    if (d) toolCalls.set(tid, { ...tc, x: tc.x + d.x, y: tc.y + d.y })
  }
  return { frame: { ...target, agents, toolCalls }, settled }
}
