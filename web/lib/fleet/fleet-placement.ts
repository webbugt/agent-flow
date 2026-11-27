/**
 * Fleet map placement: pure, deterministic geometry (same input, same map; no Math.random, no clock).
 *
 *   - {@link placeBlob}: the session nodes of one profile as a stable, seeded blob around the
 *     profile centroid (a golden-angle spiral with a small seeded jitter, packed so no two
 *     units overlap). Units are placed in the given order and never move when later ones are
 *     added, apart from the final re-centring on the centroid.
 *   - {@link placeResources}: each Kanban board and Supermemory namespace goes near the weighted
 *     centroid of the clouds it links to (weight = event count), outside every cloud's halo.
 *     Resources without a link go on an elliptical rim around all clouds.
 */

export interface Point { x: number; y: number }

/** FNV-1a, 32 bit. */
export function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** Deterministic pseudo-random number in [0, 1) from a seed and an index. */
export function seeded(seed: number, i: number): number {
  let h = (seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// ─── Blob of sessions ───────────────────────────────────────────────────────

export interface BlobUnit {
  id: string
  /** Radius of the unit (the node and its satellites), world units. */
  radius: number
}

export interface Blob {
  /** Unit centres relative to the blob centroid. */
  positions: Map<string, Point>
  /** Radius of the smallest circle around the centroid that holds every unit. */
  radius: number
}

const GOLDEN_ANGLE = 2.399963229728653
/** Free space between two units (edge to edge), world units. */
export const BLOB_GAP = 6
/** Spacing of the fallback spiral (see {@link placeBlob}); smaller = finer search. */
export const BLOB_STEP = 12

/**
 * Up to this many placed units a candidate spot is scored by the halo it would give (cubic work per unit);
 * beyond it, by its distance to the centre of the blob (cheap), so a profile with hundreds of sessions stays fast.
 */
const BLOB_EXACT_MAX = 40

interface Placed { id: string; x: number; y: number; r: number }

/** The points where a circle of radius `r` touches both `a` and `b` (each kept {@link BLOB_GAP} away): 0, 1 or 2 points. */
function touchingBoth(a: Placed, b: Placed, r: number): Point[] {
  const da = a.r + r + BLOB_GAP
  const db = b.r + r + BLOB_GAP
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9 || d > da + db || d < Math.abs(da - db)) return []
  const t = (da * da - db * db + d * d) / (2 * d)
  const h2 = da * da - t * t
  const h = h2 > 0 ? Math.sqrt(h2) : 0
  const mx = a.x + (dx * t) / d
  const my = a.y + (dy * t) / d
  return [{ x: mx - (dy * h) / d, y: my + (dx * h) / d }, { x: mx + (dy * h) / d, y: my - (dx * h) / d }]
}

/**
 * Pack units around a centroid, as tight as {@link BLOB_GAP} allows. The first unit sits at the origin,
 * the second touches it at a seeded angle (`seed`, the profile name, so two profiles do not look
 * alike). Each later unit goes to the spot where it touches two units already placed, does not overlap
 * any and lies closest to the centre of the units placed so far (ties: a seeded pick). That grows a
 * compact, roughly round blob. A unit's spot depends only on the units before it, so adding a session
 * never moves the earlier ones relative to each other. If no touching spot exists (cannot happen
 * for real inputs) a seeded golden-angle spiral with step {@link BLOB_STEP} finds the first free spot.
 */
export function placeBlob(units: readonly BlobUnit[], seed: string): Blob {
  const s = hashString(seed)
  const theta0 = seeded(s, 0) * Math.PI * 2
  const placed: Placed[] = []
  for (const unit of units) {
    const clear = (at: Point) => placed.every(p => Math.hypot(p.x - at.x, p.y - at.y) >= p.r + unit.radius + BLOB_GAP - 1e-6)
    let spot: Point | null = null
    if (placed.length === 0) {
      spot = { x: 0, y: 0 }
    } else if (placed.length === 1) {
      const d = placed[0].r + unit.radius + BLOB_GAP
      spot = { x: placed[0].x + d * Math.cos(theta0), y: placed[0].y + d * Math.sin(theta0) }
    } else {
      const mx = placed.reduce((sum, p) => sum + p.x, 0) / placed.length
      const my = placed.reduce((sum, p) => sum + p.y, 0) / placed.length
      let best = Infinity
      let k = 0
      for (let i = 0; i < placed.length; i++) {
        for (let j = i + 1; j < placed.length; j++) {
          for (const c of touchingBoth(placed[i], placed[j], unit.radius)) {
            k++
            if (!clear(c)) continue
            // What the halo would be with this unit added (its centre is the mean of the unit centres, as in
            // cloudGeometry); the distance to the current centre breaks ties between equally round blobs; the
            // seeded term is far below a world unit and only decides between identical spots.
            const dToMean = Math.hypot(c.x - mx, c.y - my)
            let score = dToMean + seeded(s, 1000 + k) * 1e-3
            if (placed.length <= BLOB_EXACT_MAX) {
              const nx = (mx * placed.length + c.x) / (placed.length + 1)
              const ny = (my * placed.length + c.y) / (placed.length + 1)
              let radius = Math.hypot(c.x - nx, c.y - ny) + unit.radius
              for (const p of placed) radius = Math.max(radius, Math.hypot(p.x - nx, p.y - ny) + p.r)
              score = radius + 0.05 * dToMean + seeded(s, 1000 + k) * 1e-3
            }
            if (score < best) { best = score; spot = c }
          }
        }
      }
    }
    if (!spot) {
      spot = { x: 0, y: 0 }
      for (let j = 0; j < 20000; j++) {
        const d = BLOB_STEP * Math.sqrt(j) + (j === 0 ? 0 : (seeded(s, 2 * j + 1) - 0.5) * BLOB_STEP * 0.5)
        const a = theta0 + j * GOLDEN_ANGLE + (j === 0 ? 0 : (seeded(s, 2 * j + 2) - 0.5) * 0.4)
        spot = { x: d * Math.cos(a), y: d * Math.sin(a) }
        if (clear(spot)) break
      }
    }
    placed.push({ id: unit.id, x: spot.x, y: spot.y, r: unit.radius })
  }
  // Re-centre on the centroid of the unit centres.
  const n = placed.length || 1
  const cx = placed.reduce((sum, p) => sum + p.x, 0) / n
  const cy = placed.reduce((sum, p) => sum + p.y, 0) / n
  const positions = new Map<string, Point>()
  let radius = 0
  for (const p of placed) {
    positions.set(p.id, { x: p.x - cx, y: p.y - cy })
    radius = Math.max(radius, Math.hypot(p.x - cx, p.y - cy) + p.r)
  }
  return { positions, radius }
}

// ─── Resources ──────────────────────────────────────────────────────────────

export interface PlacementCloud extends Point {
  id: string
  /** Radius of the halo, world units: resources stay outside it. */
  r: number
  /** Session nodes of the cloud (absolute positions): what a link's `sessions` weights refer to. */
  nodes?: ReadonlyArray<{ id: string } & Point>
}

/**
 * Where a profile caption sits under its halo (world units, a generous allowance: the caption is sized
 * for the screen, so how much world it covers depends on the zoom). Resources keep clear of this box.
 */
export const CAPTION_HALF_WIDTH = 200
export const CAPTION_HEIGHT = 70
/** Free space between a resource node and the caption box. */
export const CAPTION_CLEARANCE = 110

/** Moves `p` out of the caption box of cloud `c` (plus the clearance); unchanged when already clear. */
export function clearOfCaption(p: Point, c: PlacementCloud, clearance: number = CAPTION_CLEARANCE): Point {
  const x0 = c.x - CAPTION_HALF_WIDTH
  const x1 = c.x + CAPTION_HALF_WIDTH
  const y0 = c.y + c.r - 6
  const y1 = c.y + c.r + CAPTION_HEIGHT
  const cx = Math.min(Math.max(p.x, x0), x1)
  const cy = Math.min(Math.max(p.y, y0), y1)
  const d = Math.hypot(p.x - cx, p.y - cy)
  if (d >= clearance) return p
  if (d > 1e-6) return { x: cx + ((p.x - cx) / d) * clearance, y: cy + ((p.y - cy) / d) * clearance }
  // Inside the box: leave by the nearest side.
  const exits = [
    { x: x0 - clearance, y: p.y, cost: p.x - x0 },
    { x: x1 + clearance, y: p.y, cost: x1 - p.x },
    { x: p.x, y: y1 + clearance, cost: y1 - p.y },
    { x: p.x, y: y0 - clearance, cost: p.y - y0 },
  ]
  exits.sort((a, b) => a.cost - b.cost)
  return { x: exits[0].x, y: exits[0].y }
}

export interface PlacementResource {
  id: string
  /** The clouds the resource is linked to, weight = event count. Unknown cloud ids are ignored. */
  links: ReadonlyArray<{
    cloudId: string
    weight: number
    /**
     * Which session nodes of the cloud the interactions came from (`weight` = their count). The link then
     * pulls the resource towards those nodes, not towards the cloud centre. Ids that are not nodes of the
     * cloud are ignored; without any usable one the link pulls towards the cloud centre.
     */
    sessions?: ReadonlyArray<{ id: string; weight: number }>
  }>
}

/**
 * The point a link pulls its resource to: the weighted mean of the session nodes behind it (each node's
 * share of the link weight is its share of the interactions), or the cloud centre when it is not known
 * which nodes were used. Pure; `weight` of the link is at least 1.
 */
export function linkPull(cloud: PlacementCloud, link: PlacementResource['links'][number]): { x: number; y: number; weight: number } {
  const w = Math.max(link.weight, 1)
  const at = new Map((cloud.nodes ?? []).map(n => [n.id, n]))
  const used = (link.sessions ?? []).filter(s => at.has(s.id) && s.weight > 0)
  const total = used.reduce((sum, s) => sum + s.weight, 0)
  if (total <= 0) return { x: cloud.x, y: cloud.y, weight: w }
  let x = 0
  let y = 0
  for (const s of used) {
    const n = at.get(s.id)!
    x += n.x * (s.weight / total)
    y += n.y * (s.weight / total)
  }
  return { x, y, weight: w }
}

export interface PlaceResourcesOptions {
  /** Radius a resource (node and label) takes, world units. */
  resourceRadius?: number
  /** Free space between a halo and a resource. */
  margin?: number
  /** Extra distance of the rim beyond the outermost halo. */
  rimGap?: number
}

/** Where each resource goes: near the weighted centroid of its clouds, outside every halo. */
export function placeResources(
  clouds: readonly PlacementCloud[], resources: readonly PlacementResource[], opts: PlaceResourcesOptions = {},
): Map<string, Point> {
  const resR = opts.resourceRadius ?? 46
  const margin = opts.margin ?? 36
  const rimGap = opts.rimGap ?? 90
  const cloudList = [...clouds].sort((a, b) => a.id.localeCompare(b.id))
  const byId = new Map(cloudList.map(c => [c.id, c]))
  const list = [...resources].sort((a, b) => a.id.localeCompare(b.id))

  // Bounding box of all halos: the rim is an ellipse around it, so a wide map gets a wide rim.
  const box = cloudList.length === 0
    ? { x0: 0, y0: 0, x1: 0, y1: 0 }
    : {
      x0: Math.min(...cloudList.map(c => c.x - c.r)), x1: Math.max(...cloudList.map(c => c.x + c.r)),
      y0: Math.min(...cloudList.map(c => c.y - c.r)), y1: Math.max(...cloudList.map(c => c.y + c.r)),
    }
  const mid: Point = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 }
  const halfW = (box.x1 - box.x0) / 2
  const halfH = (box.y1 - box.y0) / 2

  const pos = new Map<string, Point>()
  const unlinked: PlacementResource[] = []
  for (const res of list) {
    let wsum = 0
    let x = 0
    let y = 0
    for (const link of res.links) {
      const c = byId.get(link.cloudId)
      if (!c) continue
      const pull = linkPull(c, link)
      wsum += pull.weight; x += pull.x * pull.weight; y += pull.y * pull.weight
    }
    if (wsum === 0) { unlinked.push(res); continue }
    pos.set(res.id, { x: x / wsum, y: y / wsum })
  }
  // Rim: evenly spaced on an ellipse around all clouds. A wide map starts at the sides, a tall one at the
  // top and bottom, so the rim adds the least to the side that is already short of room.
  const start = halfW >= halfH ? 0 : -Math.PI / 2
  unlinked.forEach((res, k) => {
    const a = start + (2 * Math.PI * k) / unlinked.length
    pos.set(res.id, { x: mid.x + (halfW + rimGap) * Math.cos(a), y: mid.y + (halfH + rimGap) * Math.sin(a) })
  })

  // Relax: out of every halo, apart from each other. A fixed number of passes in id order.
  const ids = list.map(r => r.id)
  const pushDir = (id: string, from: Point, p: Point): Point => {
    const d = Math.hypot(p.x - from.x, p.y - from.y)
    if (d > 1e-6) return { x: (p.x - from.x) / d, y: (p.y - from.y) / d }
    // Exactly on the centre: away from the middle of the map when the cloud is off-centre, else any seeded way.
    const away = Math.hypot(from.x - mid.x, from.y - mid.y)
    const jitter = (seeded(hashString(id), 7) - 0.5) * 1.2
    const base = away > 1 ? Math.atan2(from.y - mid.y, from.x - mid.x) : seeded(hashString(id), 3) * Math.PI * 2
    return { x: Math.cos(base + jitter), y: Math.sin(base + jitter) }
  }
  for (let pass = 0; pass < 10; pass++) {
    for (const id of ids) {
      let p = pos.get(id)!
      for (const c of cloudList) {
        const min = c.r + resR + margin
        if (Math.hypot(p.x - c.x, p.y - c.y) < min) {
          const u = pushDir(id, c, p)
          p = { x: c.x + u.x * min, y: c.y + u.y * min }
        }
        p = clearOfCaption(p, c)
      }
      pos.set(id, p)
    }
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i])!
        const b = pos.get(ids[j])!
        const min = 2 * resR + 12
        const d = Math.hypot(b.x - a.x, b.y - a.y)
        if (d >= min) continue
        const u = d > 1e-6
          ? { x: (b.x - a.x) / d, y: (b.y - a.y) / d }
          : { x: Math.cos(seeded(hashString(ids[j]), 5) * Math.PI * 2), y: Math.sin(seeded(hashString(ids[j]), 5) * Math.PI * 2) }
        const shift = (min - d) / 2
        pos.set(ids[i], { x: a.x - u.x * shift, y: a.y - u.y * shift })
        pos.set(ids[j], { x: b.x + u.x * shift, y: b.y + u.y * shift })
      }
    }
  }
  // The last word is the halos: a resource never ends up inside one.
  for (const id of ids) {
    let p = pos.get(id)!
    for (const c of cloudList) {
      const min = c.r + resR + margin
      if (Math.hypot(p.x - c.x, p.y - c.y) < min) {
        const u = pushDir(id, c, p)
        p = { x: c.x + u.x * min, y: c.y + u.y * min }
      }
      p = clearOfCaption(p, c)
    }
    pos.set(id, p)
  }
  return pos
}
