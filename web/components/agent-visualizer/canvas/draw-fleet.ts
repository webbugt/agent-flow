import type { Agent, Edge } from '@/lib/agent-types'
import { BEAM, ANIM } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { alphaHex } from '@/lib/utils'
import { MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { edgeAlpha } from '@/lib/fleet/fleet-edge-life'
import type { CloudGeometry, CloudView } from '@/lib/fleet/fleet-cloud-geometry'
import { pulseProgress, type FleetPulse } from '@/lib/fleet/fleet-pulses'
import { bezierPoint, computeControlPoints, drawTaperedBezier } from './draw-edges'

/** Fleet map only: agent clouds, links from a cloud to a resource, and the dots on those links. */

/**
 * How much to enlarge strokes, captions and dots so they stay readable when the camera has zoomed
 * out to fit a big fleet: 1 at normal zoom, up to 4 when far out. Uses the current canvas transform.
 */
export function overviewBoost(ctx: CanvasRenderingContext2D): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const zoom = ctx.getTransform().a / dpr
  return zoom > 0 && Number.isFinite(zoom) ? Math.min(Math.max(1 / zoom, 1), 4) : 1
}

/** The two ends of a cloud-to-resource link: where it leaves the cloud's halo and the resource node. */
export function fleetLinkEnds(
  edge: Edge, agents: ReadonlyMap<string, Agent>, clouds: ReadonlyMap<string, CloudGeometry>,
): { fromX: number; fromY: number; toX: number; toY: number } | null {
  const cloud = clouds.get(edge.from)
  const target = agents.get(edge.to)
  if (!cloud || !target || target.opacity < MIN_VISIBLE_OPACITY) return null
  const dx = target.x - cloud.x
  const dy = target.y - cloud.y
  const d = Math.hypot(dx, dy)
  if (d < 1) return null
  // Leave at the halo's rim, in the direction of the resource (the link does not cross the blob).
  const reach = Math.min(cloud.r, d * 0.9)
  return { fromX: cloud.x + (dx / d) * reach, fromY: cloud.y + (dy / d) * reach, toX: target.x, toY: target.y }
}

/** Soft halo and the profile name around each cloud. Drawn under the links and nodes. */
export function drawClouds(
  ctx: CanvasRenderingContext2D, clouds: readonly CloudView[], geometries: ReadonlyMap<string, CloudGeometry>, time: number,
) {
  for (const cloud of clouds) {
    const g = geometries.get(cloud.id)
    if (!g) continue
    const active = cloud.status === 'active'
    ctx.save()
    const grad = ctx.createRadialGradient(g.x, g.y, g.r * 0.15, g.x, g.y, g.r)
    const core = active ? 0.2 + Math.sin(time * ANIM.pulseSpeed * 0.5) * 0.03 : 0.12
    grad.addColorStop(0, cloud.color + alphaHex(core))
    grad.addColorStop(0.7, cloud.color + alphaHex(core * 0.5))
    grad.addColorStop(1, cloud.color + alphaHex(0))
    ctx.fillStyle = grad
    ctx.beginPath()
    ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.setLineDash([3, 7])
    ctx.strokeStyle = cloud.color + alphaHex(0.22)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(g.x, g.y, g.r * 0.96, 0, Math.PI * 2)
    ctx.stroke()
    ctx.setLineDash([])
    // The caption sits under the halo.
    const k = overviewBoost(ctx)
    ctx.font = `600 ${Math.round(13 * k)}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = cloud.color + alphaHex(active ? 0.95 : 0.75)
    ctx.fillText(cloud.label, g.x, g.y + g.r + 6 * k)
    ctx.restore()
  }
}

/**
 * Links from a cloud to a Kanban board or Supermemory namespace. A link is drawn for the linger
 * window after its last use, then fades out (see fleet-edge-life); it does not depend on whether
 * the profile is running.
 */
export function drawFleetLinks(
  ctx: CanvasRenderingContext2D, edges: readonly Edge[], agents: ReadonlyMap<string, Agent>,
  clouds: ReadonlyMap<string, CloudGeometry>, now: number,
) {
  for (const edge of edges) {
    if (!edge.fromCloud) continue
    const life = edgeAlpha(edge.lastUsedAt, now)
    if (life <= 0) continue
    const ends = fleetLinkEnds(edge, agents, clouds)
    if (!ends) continue
    const cp = computeControlPoints(ends.fromX, ends.fromY, ends.toX, ends.toY)
    if (!cp) continue
    ctx.save()
    const k = overviewBoost(ctx)
    drawTaperedBezier(ctx, ends.fromX, ends.fromY, cp.cp1x, cp.cp1y, cp.cp2x, cp.cp2y, ends.toX, ends.toY,
      BEAM.parentChild.startW * k, BEAM.parentChild.endW * k, edge.color ?? COLORS.holoBase, BEAM.activeAlpha * life)
    ctx.restore()
  }
}

/** A dot travelling from the cloud to the resource for each new interaction, in the colour of its kind. */
export function drawPulses(
  ctx: CanvasRenderingContext2D, pulses: readonly FleetPulse[], edges: readonly Edge[],
  agents: ReadonlyMap<string, Agent>, clouds: ReadonlyMap<string, CloudGeometry>, now: number,
) {
  if (pulses.length === 0) return
  const byId = new Map(edges.map(e => [e.id, e]))
  for (const pulse of pulses) {
    const t = pulseProgress(pulse, now)
    if (t === null) continue
    const edge = byId.get(pulse.edgeId)
    if (!edge) continue
    const ends = fleetLinkEnds(edge, agents, clouds)
    if (!ends) continue
    const cp = computeControlPoints(ends.fromX, ends.fromY, ends.toX, ends.toY)
    if (!cp) continue
    const at = (u: number) => ({
      x: bezierPoint(u, ends.fromX, cp.cp1x, cp.cp2x, ends.toX),
      y: bezierPoint(u, ends.fromY, cp.cp1y, cp.cp2y, ends.toY),
    })
    ctx.save()
    const k = overviewBoost(ctx)
    // Short comet trail, then the dot with its glow.
    for (let i = 5; i >= 1; i--) {
      const p = at(Math.max(0, t - i * 0.025))
      ctx.fillStyle = pulse.color + alphaHex(0.5 * (1 - i / 6))
      ctx.beginPath()
      ctx.arc(p.x, p.y, 4.5 * k * (1 - i / 7), 0, Math.PI * 2)
      ctx.fill()
    }
    const p = at(t)
    ctx.fillStyle = pulse.color + alphaHex(0.3)
    ctx.beginPath()
    ctx.arc(p.x, p.y, 11 * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = pulse.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, 5 * k, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
  }
}
