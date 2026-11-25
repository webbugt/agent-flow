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
/** Distance between units, world units. */
export const BLOB_GAP = 16
const BLOB_STEP = 28

/**
 * Pack units around a centroid. The first unit sits in the middle, the next ones on a seeded
 * golden-angle spiral, each at the first spiral spot where it does not touch a unit placed
 * before it. `seed` (the profile name) rotates the spiral, so two profiles do not look alike.
 */
export function placeBlob(units: readonly BlobUnit[], seed: string): Blob {
  const s = hashString(seed)
  const theta0 = seeded(s, 0) * Math.PI * 2
  const placed: Array<{ id: string; x: number; y: number; r: number }> = []
  for (const unit of units) {
    let spot: Point = { x: 0, y: 0 }
    for (let j = 0; j < 20000; j++) {
      const d = BLOB_STEP * Math.sqrt(j) + (j === 0 ? 0 : (seeded(s, 2 * j + 1) - 0.5) * BLOB_STEP * 0.5)
      const a = theta0 + j * GOLDEN_ANGLE + (j === 0 ? 0 : (seeded(s, 2 * j + 2) - 0.5) * 0.4)
      spot = { x: d * Math.cos(a), y: d * Math.sin(a) }
      if (placed.every(p => Math.hypot(p.x - spot.x, p.y - spot.y) >= p.r + unit.radius + BLOB_GAP)) break
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
}

export interface PlacementResource {
  id: string
  /** The clouds the resource is linked to, weight = event count. Unknown cloud ids are ignored. */
  links: ReadonlyArray<{ cloudId: string; weight: number }>
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
      const w = Math.max(link.weight, 1)
      wsum += w; x += c.x * w; y += c.y * w
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
    }
    pos.set(id, p)
  }
  return pos
}
