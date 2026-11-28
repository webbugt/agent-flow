/**
 * Resource-anchor mode: pure, deterministic logic (no React, no DOM, no clock, no Math.random).
 *
 * In this mode the RESOURCES (Kanban boards, Supermemory namespaces, Bash heads, Hermes subsystems) are the
 * anchors of the map. The cloud layout (one blob and halo per profile) is not used:
 *
 *   - {@link placeAnchors}: resources are laid out by weight. Weight of a pair = co-use (how often one run,
 *     that is one session node, touched both: {@link coUseWeights}) plus explicit links (a Kanban board tied to
 *     its project memory: {@link explicitLinkPairs}). Related resources end up closer than unrelated ones.
 *   - {@link placeAnchorSessions}: a session node sits next to the resource it is using now (the newest use inside
 *     the current window) and otherwise among the resources it used before. The scene tweens nodes between two
 *     builds (slowly, see DRIFT_MS), so a session drifts there instead of jumping.
 *   - {@link profileColor}: profile colour = palette[hash(profile name) mod palette.length], a per-profile override
 *     beats it. Collisions are accepted (no "skip taken" probing). Resource colours are separate and fixed.
 *   - {@link hoverAlpha} / {@link buildRelations}: on hover the hovered node and its related nodes stay at full
 *     opacity, every other node drops to {@link ANCHOR_DIM_ALPHA}.
 */
import { hashString, seeded, type Point } from './fleet-placement'
import { DEFAULT_PROFILE_PALETTE } from './options-registry'

/** Opacity of every node that is not the hovered one or related to it (R6). */
export const ANCHOR_DIM_ALPHA = 0.8
/** Weight of an explicit link (a Kanban board and the memory namespace of the same project), in co-use units. */
export const EXPLICIT_LINK_WEIGHT = 3
/** How long a session node drifts to a new place, ms (longer than the normal scene tween, so it reads as drift). */
export const DRIFT_MS = 2400
/** A use counts as "current" for this long after it happened, ms. */
export const CURRENT_USE_MS = 120_000
/**
 * A node that is beside a resource stays there until another resource was used this much more recently, ms. Without
 * it a session that alternates between two resources hops between them on every event.
 */
export const SWITCH_MARGIN_MS = 15_000
/** A remembered slot stays valid while it overlaps a neighbour or a resource by at most this much, world units. */
export const KEEP_SLOT_SLACK = 12

// ─── Colour ─────────────────────────────────────────────────────────────────

/** Profile names compare by trimmed lower case ("Taxis" = "taxis"). */
export function profileNameKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Index into a palette of `length` colours: stable hash of the profile name, modulo the length. 0 for an empty palette. */
export function paletteIndex(name: string, length: number): number {
  if (!(length > 0)) return 0
  return hashString(profileNameKey(name)) % Math.floor(length)
}

/**
 * Colour of a profile: its override when it has one, else `palette[hash(name) mod palette.length]`.
 * Two profiles may share a colour (collisions are accepted). An empty palette falls back to the default one.
 */
export function profileColor(
  name: string, palette: readonly string[], overrides?: Readonly<Record<string, string>>,
): string {
  const own = overrides?.[profileNameKey(name)]
  if (own) return own
  const list = palette.length > 0 ? palette : DEFAULT_PROFILE_PALETTE
  return list[paletteIndex(name, list.length)]
}

// ─── Hover ──────────────────────────────────────────────────────────────────

/**
 * Opacity factor of a node while `hoveredId` is hovered: 1 for the hovered node, for the nodes related to it and
 * when nothing is hovered; {@link ANCHOR_DIM_ALPHA} for every other node.
 */
export function hoverAlpha(id: string, hoveredId: string | null | undefined, related: ReadonlySet<string> | undefined): number {
  if (!hoveredId || id === hoveredId) return 1
  return related?.has(id) ? 1 : ANCHOR_DIM_ALPHA
}

/**
 * The per-node dim factor of a frame: `null` when nothing is dimmed (mode off, or nothing hovered), else a function from
 * a node id to {@link hoverAlpha}. Tool-call satellites and tree edges borrow it from the nodes they belong to.
 */
export function hoverDimmer(
  relations: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  hoveredId: string | null | undefined,
): ((id: string) => number) | null {
  if (!relations || !hoveredId) return null
  const related = relations.get(hoveredId)
  return id => hoverAlpha(id, hoveredId, related)
}

/** Tool-call cards of a dimmed frame: a card takes the dim factor of its agent. Same map when nothing is dimmed. */
export function dimToolCalls<T extends { agentId: string; opacity: number }>(
  tools: ReadonlyMap<string, T>, dimOf: ((id: string) => number) | null,
): ReadonlyMap<string, T> {
  if (!dimOf) return tools
  const out = new Map<string, T>()
  for (const [id, t] of tools) out.set(id, { ...t, opacity: t.opacity * dimOf(t.agentId) })
  return out
}

/** A tree or tool edge of a dimmed frame: full while either end is the hovered node or related to it. `to` may be a tool-call id. */
export function edgeHoverAlpha(
  edge: { from: string; to: string }, agentOfTool: (toolId: string) => string | undefined, dimOf: ((id: string) => number) | null,
): number {
  if (!dimOf) return 1
  return Math.max(dimOf(edge.from), dimOf(agentOfTool(edge.to) ?? edge.to))
}

// ─── Weights ────────────────────────────────────────────────────────────────

/** One interaction summary: `unit` (a session node, or a profile when the node is not known) used `resource` `weight` times. */
export interface UseItem {
  unit: string
  resource: string
  weight: number
}

export type PairWeights = Map<string, number>

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`
}

export function weightOf(weights: ReadonlyMap<string, number>, a: string, b: string): number {
  return weights.get(pairKey(a, b)) ?? 0
}

/**
 * Co-use of resource pairs: for every unit (run) that touched both, min(uses of a, uses of b), summed over units.
 * A resource never pairs with itself; a use with weight <= 0 is ignored.
 */
export function coUseWeights(uses: readonly UseItem[]): PairWeights {
  const byUnit = new Map<string, Map<string, number>>()
  for (const u of uses) {
    if (!(u.weight > 0)) continue
    const m = byUnit.get(u.unit) ?? new Map<string, number>()
    m.set(u.resource, (m.get(u.resource) ?? 0) + u.weight)
    byUnit.set(u.unit, m)
  }
  const out: PairWeights = new Map()
  for (const m of byUnit.values()) {
    const list = [...m].sort((a, b) => a[0].localeCompare(b[0]))
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const k = pairKey(list[i][0], list[j][0])
        out.set(k, (out.get(k) ?? 0) + Math.min(list[i][1], list[j][1]))
      }
    }
  }
  return out
}

/**
 * Co-use for ONE session (the single view): two resources used within `windowMs` of each other count once per
 * pair of uses. `events` need no order. Only the newest `MAX_PROXIMITY_EVENTS` are read.
 */
export const MAX_PROXIMITY_EVENTS = 600
export function proximityWeights(events: ReadonlyArray<{ resource: string; at: number }>, windowMs: number): PairWeights {
  const sorted = [...events].sort((a, b) => a.at - b.at || a.resource.localeCompare(b.resource)).slice(-MAX_PROXIMITY_EVENTS)
  const out: PairWeights = new Map()
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && sorted[j].at - sorted[i].at <= windowMs; j++) {
      if (sorted[i].resource === sorted[j].resource) continue
      const k = pairKey(sorted[i].resource, sorted[j].resource)
      out.set(k, (out.get(k) ?? 0) + 1)
    }
  }
  return out
}

/** Name of a board or namespace without a `project:` / `project ` prefix, lower case, for matching. */
function projectKey(label: string): string {
  return label.trim().toLowerCase().replace(/^project[:\s_-]+/, '')
}

/**
 * Explicit links: a Kanban board is tied to the memory namespace of the same project (same name once a `project:`
 * prefix is dropped). Returns each pair of resource ids once.
 */
export function explicitLinkPairs(nodes: ReadonlyArray<{ id: string; kind: string; label: string }>): Array<[string, string]> {
  const boards = new Map<string, string[]>()
  for (const n of nodes) {
    if (n.kind !== 'kanban') continue
    const k = projectKey(n.label)
    boards.set(k, [...(boards.get(k) ?? []), n.id])
  }
  const out: Array<[string, string]> = []
  for (const n of nodes) {
    if (n.kind !== 'supermemory') continue
    for (const b of boards.get(projectKey(n.label)) ?? []) out.push([b, n.id])
  }
  return out
}

/** Pair weights for the layout: co-use plus the explicit links (each worth {@link EXPLICIT_LINK_WEIGHT}). */
export function layoutWeights(coUse: ReadonlyMap<string, number>, explicit: ReadonlyArray<readonly [string, string]>): PairWeights {
  const out: PairWeights = new Map(coUse)
  for (const [a, b] of explicit) {
    if (a === b) continue
    const k = pairKey(a, b)
    out.set(k, (out.get(k) ?? 0) + EXPLICIT_LINK_WEIGHT)
  }
  return out
}

// ─── Resource anchors ───────────────────────────────────────────────────────

export interface AnchorLayoutOptions {
  /** Least distance between two anchor centres, world units. Default leaves room for sessions to sit beside an anchor. */
  minSeparation?: number
  /** Solver passes (cold start). A warm start uses {@link WARM_ITERATIONS} unless this is set. */
  iterations?: number
  /**
   * Where the resources were laid out last time (the previous build). The solver then starts from those places and only
   * relaxes (low temperature), so a changed weight, a new or a removed resource moves the others a little instead of
   * re-solving the whole map from the hash seeds. Same inputs plus the same `prev` still give the same map.
   */
  prev?: ReadonlyMap<string, Point>
  /** Warm start only: the furthest a resource that was on the map may move in one build, world units. Default {@link WARM_MAX_MOVE} x least separation. */
  maxMove?: number
}

/** Solver passes of a warm start, and the temperature it starts at (a cold start is 1). */
export const WARM_ITERATIONS = 200
export const WARM_TEMPERATURE = 0.25
/** Furthest a resource moves in one warm build, in least separations (see {@link AnchorLayoutOptions.maxMove}). */
export const WARM_MAX_MOVE = 0.4
/**
 * Fraction of the net force applied per pass. A full step (1) overshoots and oscillates where the 1/d repulsion is steep,
 * so the layout never settled and any change of input landed in another local state (the nodes jumped). A damped step
 * relaxes to a real equilibrium: unchanged weights give back the same map, a small change a small move.
 */
export const SOLVER_DT = 0.3
/** Two anchors further apart than this many least-separations do not push each other. */
const REPEL_RANGE = 1.8
const COLD_ITERATIONS = 900
const GRAVITY = 0.04

/** Radius of a resource node with its label, world units (same as the cloud layout). */
export const ANCHOR_RESOURCE_RADIUS = 46
/** Default least distance between anchors: two resource radii, two typical session units and a gap. */
export const ANCHOR_SPACING = 2 * ANCHOR_RESOURCE_RADIUS + 2 * 70 + 40

/**
 * Where each resource goes. A deterministic force layout: every pair repels (so the map spreads and nothing
 * overlaps), a pair with weight w > 0 is pulled to a rest distance that shrinks as w grows (the pull depends on that
 * pair's weight only, so one new use does not change every spring), and a weak pull to the middle keeps the map
 * together. A cold start begins at hash-of-id positions, so the same input always gives the same map, and is centred
 * on the middle of its bounding box. With `opts.prev` (the previous build) the solver starts from there and relaxes,
 * so a rebuild moves only what the changed weights pull.
 */
export function placeAnchors(
  ids: readonly string[], weights: ReadonlyMap<string, number>, opts: AnchorLayoutOptions = {},
): Map<string, Point> {
  const list = [...new Set(ids)].sort((a, b) => a.localeCompare(b))
  const n = list.length
  const out = new Map<string, Point>()
  if (n === 0) return out
  if (n === 1) { out.set(list[0], { x: 0, y: 0 }); return out }
  const sep = opts.minSeparation ?? ANCHOR_SPACING
  const prev = opts.prev
  const warm = !!prev && list.some(id => prev.has(id))
  const iterations = opts.iterations ?? (warm ? WARM_ITERATIONS : COLD_ITERATIONS)
  const t0 = warm ? WARM_TEMPERATURE : 1

  // Warm start: a resource that was on the map starts where it was; a new one starts beside the resources it is tied
  // to (a seeded offset, so it is not on top of them), else on a ring outside the known map.
  const known = warm ? list.filter(id => prev!.has(id)) : []
  const pos = list.map(id => {
    const h = hashString(id)
    const was = warm ? prev!.get(id) : undefined
    if (was) return { x: was.x, y: was.y }
    if (warm) {
      let sx = 0, sy = 0, sw = 0
      for (const other of known) {
        const w = weightOf(weights, id, other)
        if (!(w > 0)) continue
        const q = prev!.get(other) as Point
        sx += q.x * w; sy += q.y * w; sw += w
      }
      const a = seeded(h, 2) * Math.PI * 2
      if (sw > 0) return { x: sx / sw + Math.cos(a) * sep * 0.6, y: sy / sw + Math.sin(a) * sep * 0.6 }
      const reach = known.reduce((m, k) => Math.max(m, Math.hypot((prev!.get(k) as Point).x, (prev!.get(k) as Point).y)), 0)
      return { x: Math.cos(a) * (reach + sep), y: Math.sin(a) * (reach + sep) }
    }
    const angle = seeded(h, 0) * Math.PI * 2
    const radius = sep * (0.5 + 0.28 * Math.sqrt(n)) * (0.45 + 0.55 * seeded(h, 1))
    return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }
  })
  const maxMove = opts.maxMove ?? WARM_MAX_MOVE * sep
  const start = list.map(id => (warm ? prev!.get(id) : undefined))
  // Pairs with a pull, with their rest distance: the stronger the tie, the closer.
  const springs: Array<{ i: number; j: number; rest: number; k: number }> = []
  const tied = new Set<number>() // i * n + j of every pair with a spring: those do not take the soft repulsion
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const w = weightOf(weights, list[i], list[j])
      if (!(w > 0)) continue
      // A tie pulls the pair to a rest distance between 1.02 and 1.72 x sep (the stronger, the closer); that is inside
      // REPEL_RANGE, so a tied pair always ends closer than a pair with no tie.
      springs.push({ i, j, rest: sep * (1.02 + 0.7 / (1 + w)), k: 0.4 * (w / (w + 3)) })
      tied.add(i * n + j)
    }
  }

  for (let it = 0; it < iterations; it++) {
    const cool = t0 * (1 - 0.7 * it / iterations)
    const maxStep = sep * 0.25 * cool + 0.5
    const fx = new Array<number>(n).fill(0)
    const fy = new Array<number>(n).fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = pos[j].x - pos[i].x
        let dy = pos[j].y - pos[i].y
        let d = Math.hypot(dx, dy)
        if (d < 1e-6) { // exactly on top of each other: a seeded direction
          const a = seeded(hashString(list[j]), 5) * Math.PI * 2
          dx = Math.cos(a); dy = Math.sin(a); d = 1e-6
        } else { dx /= d; dy /= d }
        // Repulsion is short-range (zero beyond REPEL_RANGE x sep): a long-range 1/d push never reaches an equilibrium
        // (the map keeps expanding against the weak pull to the middle, so every rebuild moved everything). Hard push
        // when closer than the least separation.
        const rep = (tied.has(i * n + j) ? 0 : Math.max(0, REPEL_RANGE * sep - d) * 0.25) + (d < sep ? (sep - d) * 0.5 : 0)
        fx[i] -= dx * rep; fy[i] -= dy * rep
        fx[j] += dx * rep; fy[j] += dy * rep
      }
    }
    for (const s of springs) {
      const dx = pos[s.j].x - pos[s.i].x
      const dy = pos[s.j].y - pos[s.i].y
      const d = Math.max(Math.hypot(dx, dy), 1e-6)
      const f = (d - s.rest) * s.k
      fx[s.i] += (dx / d) * f; fy[s.i] += (dy / d) * f
      fx[s.j] -= (dx / d) * f; fy[s.j] -= (dy / d) * f
    }
    for (let i = 0; i < n; i++) {
      fx[i] -= pos[i].x * GRAVITY
      fy[i] -= pos[i].y * GRAVITY
      fx[i] *= SOLVER_DT; fy[i] *= SOLVER_DT
      const m = Math.hypot(fx[i], fy[i])
      const k = m > maxStep ? maxStep / m : 1
      pos[i].x += fx[i] * k
      pos[i].y += fy[i] * k
      // Warm start: no resource that was on the map travels further than `maxMove` in one build. A big change (a new
      // strong tie) is followed over the next builds, not in one jump.
      const s0 = start[i]
      if (s0) {
        const mx = pos[i].x - s0.x
        const my = pos[i].y - s0.y
        const md = Math.hypot(mx, my)
        if (md > maxMove) { pos[i].x = s0.x + (mx / md) * maxMove; pos[i].y = s0.y + (my / md) * maxMove }
      }
    }
  }
  // Last word: nothing closer than the least separation.
  for (let pass = 0; pass < 12; pass++) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[j].x - pos[i].x
        const dy = pos[j].y - pos[i].y
        const d = Math.hypot(dx, dy)
        if (d >= sep - 1e-6) continue
        const ux = d > 1e-6 ? dx / d : Math.cos(seeded(hashString(list[j]), 7) * Math.PI * 2)
        const uy = d > 1e-6 ? dy / d : Math.sin(seeded(hashString(list[j]), 7) * Math.PI * 2)
        const shift = (sep - d) / 2 + 0.01
        pos[i].x -= ux * shift; pos[i].y -= uy * shift
        pos[j].x += ux * shift; pos[j].y += uy * shift
      }
    }
  }
  if (warm) { // no re-centring: moving every node by the same amount because one moved is what a warm start avoids
    list.forEach((id, i) => out.set(id, { x: pos[i].x, y: pos[i].y }))
    return out
  }
  const x0 = Math.min(...pos.map(p => p.x)); const x1 = Math.max(...pos.map(p => p.x))
  const y0 = Math.min(...pos.map(p => p.y)); const y1 = Math.max(...pos.map(p => p.y))
  const mx = (x0 + x1) / 2
  const my = (y0 + y1) / 2
  list.forEach((id, i) => out.set(id, { x: pos[i].x - mx, y: pos[i].y - my }))
  return out
}

/**
 * Room the nodes around an anchor take, world units: the resource itself, a session node beside it (with its tool cards)
 * and the nodes that use nothing on the rim. The shape the viewport sees is
 * that of the anchors' bounding box grown by this on every side.
 */
export const ANCHOR_VIEW_PAD = ANCHOR_RESOURCE_RADIUS + 2 * 70 + 14 + 100

/**
 * Flow the anchors toward the shape of the viewport (`aspect` = width / height). The bounding box of the anchors, grown
 * by `pad` (the room of the nodes around an anchor), is stretched along one axis until it has that shape. Stretching
 * by a factor >= 1 only moves points apart, so the least separation of {@link placeAnchors} always holds. When the
 * layout is a lot wider than tall (or the other way round) and the viewport is the opposite, the layout is first turned
 * a quarter, which needs less stretching. Pure and deterministic; a single anchor, or an aspect that is not a positive
 * number, returns the input unchanged. The result is centred on the middle of its bounding box.
 */
export function fitAnchorsToAspect(
  anchors: ReadonlyMap<string, Point>, aspect: number, pad: number = ANCHOR_VIEW_PAD,
): Map<string, Point> {
  const out = new Map<string, Point>(anchors)
  if (anchors.size < 2 || !(aspect > 0) || !Number.isFinite(aspect)) return out
  const stretchFor = (pts: readonly Point[]) => {
    const x0 = Math.min(...pts.map(p => p.x)); const x1 = Math.max(...pts.map(p => p.x))
    const y0 = Math.min(...pts.map(p => p.y)); const y1 = Math.max(...pts.map(p => p.y))
    const w = x1 - x0
    const h = y1 - y0
    // Grown boxes: (w + 2 pad) / (h + 2 pad) is what the viewport sees.
    const seen = (w + 2 * pad) / (h + 2 * pad)
    let sx = 1
    let sy = 1
    if (seen < aspect && w > 1e-6) sx = Math.max(1, (aspect * (h + 2 * pad) - 2 * pad) / w)
    else if (seen > aspect && h > 1e-6) sy = Math.max(1, ((w + 2 * pad) / aspect - 2 * pad) / h)
    return { sx, sy, mx: (x0 + x1) / 2, my: (y0 + y1) / 2 }
  }
  const ids = [...anchors.keys()]
  const upright = ids.map(id => anchors.get(id) as Point)
  const turned = upright.map(p => ({ x: -p.y, y: p.x }))
  const a = stretchFor(upright)
  const b = stretchFor(turned)
  const useTurned = b.sx * b.sy < a.sx * a.sy - 1e-9
  const pts = useTurned ? turned : upright
  const s = useTurned ? b : a
  ids.forEach((id, i) => out.set(id, { x: (pts[i].x - s.mx) * s.sx, y: (pts[i].y - s.my) * s.sy }))
  return out
}

// ─── Session nodes ──────────────────────────────────────────────────────────

export interface AnchorSession {
  id: string
  /** Radius of the node with its satellites (what it needs around it), world units. */
  radius: number
  /** Resources this node used, with how often and when (epoch ms) last. */
  usage: ReadonlyArray<{ resource: string; weight: number; lastAt: number }>
}

export interface AnchorSessionPlacement extends Point {
  /** The resource the node is next to because it is using it now; null when it rests. */
  at: string | null
  /** The node's place relative to what it sits by (its resource, or the middle of the resources it used). Pass back as `prev`. */
  off?: Point
}

/** What one anchor build hands to the next as `prev`: where the resources and the session nodes were put. */
export interface AnchorLayoutState {
  anchors: ReadonlyMap<string, Point>
  sessions: ReadonlyMap<string, AnchorSessionPlacement>
}

export interface AnchorSessionOptions {
  /** Epoch ms of "now". */
  now: number
  /** A use is current for this long, ms. Default {@link CURRENT_USE_MS}. */
  currentMs?: number
  /** A node beside a resource stays until another was used this much more recently, ms. Default {@link SWITCH_MARGIN_MS}. */
  switchMarginMs?: number
  /**
   * The previous build's placements. A node keeps the same slot beside the same resource (it follows the resource when
   * that moves) and does not hop to another resource for a marginal difference in recency.
   */
  prev?: ReadonlyMap<string, AnchorSessionPlacement>
  resourceRadius?: number
  /** Free space between two nodes and between a node and a resource, world units. */
  gap?: number
}

/** The resource a node is using now: its newest use inside the window (ties: more uses, then id). */
export function currentResource(
  session: AnchorSession, now: number, currentMs: number = CURRENT_USE_MS,
  /** The resource the node was beside in the previous build, and how much newer another use must be to move it. */
  sticky?: { resource: string | null | undefined; marginMs: number },
): string | null {
  let best: AnchorSession['usage'][number] | null = null
  let held: AnchorSession['usage'][number] | null = null
  for (const u of session.usage) {
    if (now - u.lastAt > currentMs) continue
    if (sticky?.resource && u.resource === sticky.resource) held = u
    if (!best || u.lastAt > best.lastAt || (u.lastAt === best.lastAt && (u.weight > best.weight || (u.weight === best.weight && u.resource < best.resource)))) best = u
  }
  if (best && held && best.lastAt - held.lastAt < (sticky?.marginMs ?? 0)) return held.resource
  return best ? best.resource : null
}

/**
 * Where each session node goes. Nodes are placed in id order, each on the first free spot of a spiral around its
 * target: the resource it uses now (starting beside it), else the weighted middle of the resources it used before,
 * else a ring around the whole map (seeded by its id). A spot is free when it is clear of every anchor and every node
 * placed before. Pure and deterministic.
 */
export function placeAnchorSessions(
  sessions: readonly AnchorSession[], anchors: ReadonlyMap<string, Point>, opts: AnchorSessionOptions,
): Map<string, AnchorSessionPlacement> {
  const resR = opts.resourceRadius ?? ANCHOR_RESOURCE_RADIUS
  const gap = opts.gap ?? 14
  const currentMs = opts.currentMs ?? CURRENT_USE_MS
  const marginMs = opts.switchMarginMs ?? SWITCH_MARGIN_MS
  const pts = [...anchors.values()]
  const cx = pts.length ? pts.reduce((s, p) => s + p.x, 0) / pts.length : 0
  const cy = pts.length ? pts.reduce((s, p) => s + p.y, 0) / pts.length : 0
  // Nodes that use nothing sit on a rectangle around the anchors, not on a circle: a circle would put them far above or
  // below a map that was spread to a wide viewport (or the other way round), and the shape would be lost.
  const halfW = pts.reduce((m, p) => Math.max(m, Math.abs(p.x - cx)), 0) + resR + 160
  const halfH = pts.reduce((m, p) => Math.max(m, Math.abs(p.y - cy)), 0) + resR + 160
  const placed: Array<{ x: number; y: number; r: number }> = []
  const out = new Map<string, AnchorSessionPlacement>()

  const free = (p: Point, r: number, slack = 0): boolean => {
    for (const a of pts) if (Math.hypot(p.x - a.x, p.y - a.y) < resR + r + gap - slack) return false
    for (const q of placed) if (Math.hypot(p.x - q.x, p.y - q.y) < q.r + r + gap - slack) return false
    return true
  }
  /** First free spot on a spiral around `from`, starting `startDist` away. */
  const findSpot = (from: Point, r: number, startDist: number, seed: number): Point => {
    const step = r * 2 + gap
    for (let ring = 0; ring < 40; ring++) {
      const dist = ring === 0 ? startDist : startDist + ring * step * 0.8
      const count = Math.max(8, Math.ceil((2 * Math.PI * Math.max(dist, 1)) / step))
      const base = seeded(seed, ring) * Math.PI * 2
      for (let k = 0; k < count; k++) {
        const a = base + (k * 2 * Math.PI) / count
        const p = { x: from.x + Math.cos(a) * dist, y: from.y + Math.sin(a) * dist }
        if (free(p, r)) return p
      }
    }
    return { x: from.x + startDist, y: from.y }
  }

  const list = [...sessions].sort((a, b) => a.id.localeCompare(b.id))
  // Pass 1 decides, for every node, what it sits by (and whether its old slot is still good); pass 2 places the nodes
  // that keep their slot FIRST, so a node that arrives (or sorts earlier) cannot take a slot a resident still holds and
  // push it away; pass 3 places the rest in id order on the first free spot of a spiral.
  interface Plan { s: AnchorSession; at: string | null; from: Point; startDist: number; seed: number; slot: Point | null }
  const plans: Plan[] = []
  for (const s of list) {
    const seed = hashString(s.id)
    const was = opts.prev?.get(s.id)
    const target = currentResource(s, opts.now, currentMs, was ? { resource: was.at, marginMs } : undefined)
    let at: string | null = null
    let from: Point
    let startDist = 0
    const anchor = target ? anchors.get(target) : undefined
    if (target && anchor) {
      at = target
      from = anchor
      startDist = resR + s.radius + gap + 6
    } else {
      const used = s.usage.filter(u => anchors.has(u.resource) && u.weight > 0)
      const total = used.reduce((sum, u) => sum + u.weight, 0)
      if (total > 0) {
        const mid = { x: 0, y: 0 }
        for (const u of used) {
          const a = anchors.get(u.resource) as Point
          mid.x += a.x * (u.weight / total)
          mid.y += a.y * (u.weight / total)
        }
        from = mid
      } else {
        // Never used a resource that is on the map: a ring around the map, at a seeded angle.
        const a = seeded(seed, 99) * Math.PI * 2
        // The point of the rectangle (half extents halfW, halfH) in the direction of the seeded angle.
        const t = 1 / Math.max(Math.abs(Math.cos(a)) / halfW, Math.abs(Math.sin(a)) / halfH, 1e-9)
        from = { x: cx + Math.cos(a) * t, y: cy + Math.sin(a) * t }
      }
    }
    // Same resource as last build: the old slot, relative to the resource (so the node follows it), unless it is too far.
    const step = s.radius * 2 + gap
    const slot = was && was.at === at && was.off && Math.hypot(was.off.x, was.off.y) <= startDist + 6 * step
      ? { x: from.x + was.off.x, y: from.y + was.off.y } : null
    plans.push({ s, at, from, startDist, seed, slot })
  }
  const put = (pl: Plan, spot: Point) => {
    placed.push({ x: spot.x, y: spot.y, r: pl.s.radius })
    out.set(pl.s.id, { x: spot.x, y: spot.y, at: pl.at, off: { x: spot.x - pl.from.x, y: spot.y - pl.from.y } })
  }
  const rest: Plan[] = []
  for (const pl of plans) {
    // A little slack: a node whose cloud grew by a few units keeps its slot instead of hopping a ring out.
    if (pl.slot && free(pl.slot, pl.s.radius, KEEP_SLOT_SLACK)) put(pl, pl.slot)
    else rest.push(pl)
  }
  for (const pl of rest) put(pl, findSpot(pl.from, pl.s.radius, pl.startDist, pl.seed))
  return out
}

// ─── Relations (hover) ──────────────────────────────────────────────────────

export interface RelationsInput {
  /** Which units used which resources (a unit is a session node id, or a profile id when the node is not known). */
  uses: readonly UseItem[]
  /** The scene nodes a unit stands for (a session node: itself; a profile: all its nodes). Unknown units stand for themselves. */
  nodesOf: ReadonlyMap<string, readonly string[]>
  /** Pair weights of resources (co-use and explicit links): a weight > 0 relates the two. */
  weights: ReadonlyMap<string, number>
}

/**
 * Related nodes of every node (symmetric): a resource relates to the nodes that used it and to the resources it
 * shares co-use or an explicit link with; a session node relates to the resources it used.
 */
export function buildRelations(input: RelationsInput): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const link = (a: string, b: string) => {
    if (a === b) return
    ;(out.get(a) ?? out.set(a, new Set()).get(a) as Set<string>).add(b)
    ;(out.get(b) ?? out.set(b, new Set()).get(b) as Set<string>).add(a)
  }
  for (const u of input.uses) {
    if (!(u.weight > 0)) continue
    for (const node of input.nodesOf.get(u.unit) ?? [u.unit]) link(node, u.resource)
  }
  for (const key of input.weights.keys()) {
    if (!((input.weights.get(key) ?? 0) > 0)) continue
    const [a, b] = key.split('\u0000')
    if (a && b) link(a, b)
  }
  return out
}
