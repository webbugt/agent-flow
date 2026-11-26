import type { Agent, Edge } from '@/lib/agent-types'
import { BEAM, ANIM, NODE } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { alphaHex } from '@/lib/utils'
import { MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { edgeAlpha } from '@/lib/fleet/fleet-edge-life'
import type { CloudGeometry, CloudView } from '@/lib/fleet/fleet-cloud-geometry'
import { pulseProgress, type FleetPulse } from '@/lib/fleet/fleet-pulses'
import { LABEL_WIDTH_PX, LabelPlacer, fitText, labelScreenPx, type Rect } from '@/lib/fleet/fleet-labels'
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

/**
 * The two ends of a cloud-to-resource link: where it leaves the cloud's halo and the resource node.
 * With `sourceId` (a pulse of one interaction) it leaves the session node that did it instead, at the
 * node's edge, in the direction of the resource; an unknown or hidden source falls back to the halo.
 */
export function fleetLinkEnds(
  edge: Edge, agents: ReadonlyMap<string, Agent>, clouds: ReadonlyMap<string, CloudGeometry>, sourceId?: string,
): { fromX: number; fromY: number; toX: number; toY: number } | null {
  const cloud = clouds.get(edge.from)
  const target = agents.get(edge.to)
  if (!cloud || !target || target.opacity < MIN_VISIBLE_OPACITY) return null
  const source = sourceId ? agents.get(sourceId) : undefined
  if (source && source.opacity >= MIN_VISIBLE_OPACITY && !source.resourceKind) {
    const sx = target.x - source.x
    const sy = target.y - source.y
    const sd = Math.hypot(sx, sy)
    if (sd >= 1) {
      const lift = Math.min(NODE.radiusSub * source.scale, sd * 0.5)
      return { fromX: source.x + (sx / sd) * lift, fromY: source.y + (sy / sd) * lift, toX: target.x, toY: target.y }
    }
  }
  const dx = target.x - cloud.x
  const dy = target.y - cloud.y
  const d = Math.hypot(dx, dy)
  if (d < 1) return null
  // Leave at the halo's rim, in the direction of the resource (the link does not cross the blob).
  const reach = Math.min(cloud.r, d * 0.9)
  return { fromX: cloud.x + (dx / d) * reach, fromY: cloud.y + (dy / d) * reach, toX: target.x, toY: target.y }
}

/** Soft halo around each cloud. Drawn under the links and nodes. */
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
    // The profile caption is drawn by drawFleetLabels: on top of the nodes, sized for the screen.
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

/** A dot travelling from the session node that did the interaction to the resource, for each new interaction, in the colour of its kind. */
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
    const ends = fleetLinkEnds(edge, agents, clouds, pulse.sourceId)
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

/** Camera zoom (screen px per world unit) from the current canvas transform. */
export function currentZoom(ctx: CanvasRenderingContext2D): number {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const zoom = ctx.getTransform().a / dpr
  return zoom > 0 && Number.isFinite(zoom) ? zoom : 1
}

interface LabelJob {
  text: string
  x: number
  /** Top of the text, world units. */
  y: number
  nominalPx: number
  minPx?: number
  maxPx?: number
  /** Widest it may be on the screen; undefined = whole text. */
  widthPx?: number
  color: string
  weight: '400' | '600'
  /** Other spots to try, in order, when the first is taken: above the node, or beside it. */
  alt?: { aboveBottom: number; sideX: number; centreY: number }
}

/** Draws one label if it fits; returns the world rect it took (also when `force`d), or null when skipped. */
function drawLabelJob(ctx: CanvasRenderingContext2D, placer: LabelPlacer, job: LabelJob, zoom: number, force: boolean): Rect | null {
  const px = labelScreenPx(job.nominalPx, zoom, job.minPx, job.maxPx)
  const fontWorld = px / zoom
  ctx.font = `${job.weight} ${fontWorld}px monospace`
  const text = job.widthPx === undefined || force
    ? job.text
    : fitText(job.text, job.widthPx / zoom, s => ctx.measureText(s).width)
  const w = ctx.measureText(text).width
  const h = fontWorld * 1.25
  const spots: Array<{ x: number; y: number }> = [{ x: job.x, y: job.y }]
  if (job.alt && !force) {
    spots.push({ x: job.x, y: job.alt.aboveBottom - h })
    spots.push({ x: job.alt.sideX + w / 2, y: job.alt.centreY - h / 2 })
    spots.push({ x: 2 * job.x - job.alt.sideX - w / 2, y: job.alt.centreY - h / 2 })
  }
  let rect: Rect | null = null
  for (const spot of spots) {
    const r: Rect = { x0: spot.x - w / 2, x1: spot.x + w / 2, y0: spot.y, y1: spot.y + h }
    if (force) { placer.reserve(r); rect = r; break }
    if (placer.tryPlace(r, 2 / zoom)) { rect = r; break }
  }
  if (!rect) return null
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = job.color
  ctx.fillText(text, (rect.x0 + rect.x1) / 2, rect.y0)
  return rect
}

/**
 * Fleet map labels: profile captions, resource names, session names and resource tasks, all sized for
 * the screen (never below a legible minimum). Priority: captions, the selected / hovered node (full
 * name), resources, then sessions. A label that would sit on another label or node is skipped, so
 * a zoomed-out phone shows the captions and the names that fit instead of a smear of dashes.
 */
export function drawFleetLabels(
  ctx: CanvasRenderingContext2D, clouds: readonly CloudView[], geometries: ReadonlyMap<string, CloudGeometry>,
  agents: ReadonlyMap<string, Agent>, selectedId: string | null, hoveredId: string | null,
  /** Screensaver mode passes false: the second line under a resource (its task text) is not drawn. Names and captions stay. */
  showTaskText = true,
) {
  const zoom = currentZoom(ctx)
  const gap = 8 / Math.min(zoom, 1)
  const placer = new LabelPlacer()
  ctx.save()
  const radiusOf = (a: Agent) => (a.resourceKind ? NODE.radiusSub : a.isMain ? NODE.radiusMain : NODE.radiusSub) * a.scale
  for (const a of agents.values()) {
    if (a.opacity < MIN_VISIBLE_OPACITY) continue
    const r = radiusOf(a)
    placer.reserve({ x0: a.x - r, x1: a.x + r, y0: a.y - r, y1: a.y + r })
  }

  for (const cloud of clouds) {
    const g = geometries.get(cloud.id)
    if (!g) continue
    drawLabelJob(ctx, placer, {
      text: cloud.label, x: g.x, y: g.y + g.r + 6 / Math.min(zoom, 1), nominalPx: 13, minPx: 11, maxPx: 15, weight: '600',
      color: cloud.color + alphaHex(cloud.status === 'active' ? 0.95 : 0.75),
    }, zoom, true)
  }

  const labelled = [...agents.values()]
    .filter(a => a.opacity >= MIN_VISIBLE_OPACITY && a.name)
    .sort((a, b) => Number(!!b.resourceKind) - Number(!!a.resourceKind) || a.id.localeCompare(b.id))
  const emphasised = (a: Agent) => a.id === selectedId || a.id === hoveredId
  const draw = (a: Agent, force: boolean) => {
    const rect = drawLabelJob(ctx, placer, {
      text: a.name, x: a.x, y: a.y + radiusOf(a) + gap, nominalPx: 10, weight: '400',
      alt: { aboveBottom: a.y - radiusOf(a) - gap, sideX: a.x + radiusOf(a) + 6 / Math.min(zoom, 1), centreY: a.y },
      widthPx: a.resourceKind ? LABEL_WIDTH_PX.resource : LABEL_WIDTH_PX.session,
      color: a.id === hoveredId ? COLORS.textPrimary : COLORS.textDim,
    }, zoom, force)
    if (showTaskText && rect && a.resourceKind && a.task) {
      drawLabelJob(ctx, placer, {
        text: a.task, x: (rect.x0 + rect.x1) / 2, y: rect.y1 + 3 / zoom, nominalPx: 9, maxPx: 12, weight: '400',
        widthPx: LABEL_WIDTH_PX.task, color: COLORS.textMuted,
      }, zoom, force)
    }
  }
  for (const a of labelled) if (emphasised(a)) draw(a, true)
  for (const a of labelled) if (!emphasised(a)) draw(a, false)
  ctx.restore()
}
