/**
 * Geometry of an agent cloud on the Fleet canvas. The halo follows its session nodes live
 * (a dragged node pulls the halo along), so it is computed from the current positions at draw
 * time, not stored. Pure: the draw code and the tests share it.
 */
import type { FleetInstanceStatus } from './fleet-model'

/** Extra radius of the halo around the outermost unit, world units. */
export const HALO_PAD = 30

export interface CloudMember {
  /** Scene id of a session node. */
  id: string
  /** Radius of the node and its satellites around its position. */
  pad: number
}

/** A cloud as the canvas draws it: soft halo, profile name as caption. Not a node. */
export interface CloudView {
  id: string
  /** Profile name. */
  label: string
  color: string
  status: FleetInstanceStatus
  members: CloudMember[]
}

export interface CloudGeometry { x: number; y: number; r: number }

/** Centre = mean of the member positions; radius reaches the farthest member plus its pad plus the halo padding. */
export function cloudGeometry(cloud: CloudView, positions: ReadonlyMap<string, { x: number; y: number }>): CloudGeometry | null {
  const pts: Array<{ x: number; y: number; pad: number }> = []
  for (const m of cloud.members) {
    const p = positions.get(m.id)
    if (p) pts.push({ x: p.x, y: p.y, pad: m.pad })
  }
  if (pts.length === 0) return null
  const x = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const y = pts.reduce((s, p) => s + p.y, 0) / pts.length
  const r = pts.reduce((m, p) => Math.max(m, Math.hypot(p.x - x, p.y - y) + p.pad), 0) + HALO_PAD
  return { x, y, r }
}

/** Geometry of every cloud that still has a member on the map. */
export function cloudGeometries(
  clouds: readonly CloudView[], positions: ReadonlyMap<string, { x: number; y: number }>,
): Map<string, CloudGeometry> {
  const out = new Map<string, CloudGeometry>()
  for (const c of clouds) {
    const g = cloudGeometry(c, positions)
    if (g) out.set(c.id, g)
  }
  return out
}
