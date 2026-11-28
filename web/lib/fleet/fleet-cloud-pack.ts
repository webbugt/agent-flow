/**
 * Shelf packing of the Fleet map's clouds (pure, deterministic: no clock, no randomness).
 *
 * A cloud is a disc (its halo) with a caption under it, so its cell is `2 * halo` wide and `2 * halo + captionRoom`
 * tall. The cells are packed into rows ("shelves") so that the whole block has the shape of the free viewport area
 * (`aspect` = width / height): a 4-profile fleet on a 16:9 screen becomes 2 x 2, not one long row, and on a phone it
 * becomes a tall column. Clouds are taken biggest halo first (ties by id), a smaller cloud goes into the first row with
 * room left (first-fit decreasing), so uneven clouds fill the gaps beside the big ones.
 *
 * The row width is the free parameter: every candidate width is packed, and the best one wins by (1) how close the
 * block's aspect is to the target, then (2) how little of the block is empty. All ties are broken by the smaller width,
 * so the same input always gives the same map.
 */

export interface PackItem {
  id: string
  /** Halo radius, world units. */
  halo: number
}

export interface PackOptions {
  /** Gap between two cells of a row, world units. */
  gapX: number
  /** Gap between two rows. */
  gapY: number
  /** Room under a halo for the caption (the cell is this much taller than the halo disc). */
  captionRoom: number
}

export interface PackResult {
  /** Cloud centre (the middle of the halo disc) by id; the block is centred on the origin. */
  positions: Map<string, { x: number; y: number }>
  /** Size of the block (cells, captions included). */
  width: number
  height: number
}

interface Shelf {
  /** Cell height of the shelf: that of its first (biggest) cloud. */
  height: number
  used: number
  items: PackItem[]
}

function packAt(sorted: readonly PackItem[], rowWidth: number, o: PackOptions): { shelves: Shelf[]; width: number; height: number } {
  const shelves: Shelf[] = []
  for (const item of sorted) {
    const w = 2 * item.halo
    let shelf = shelves.find(s => s.used + o.gapX + w <= rowWidth + 1e-9)
    if (!shelf) {
      shelf = { height: 2 * item.halo + o.captionRoom, used: 0, items: [] }
      shelves.push(shelf)
      shelf.used = w
    } else {
      shelf.used += o.gapX + w
    }
    shelf.items.push(item)
  }
  const width = shelves.reduce((m, s) => Math.max(m, s.used), 0)
  const height = shelves.reduce((sum, s) => sum + s.height, 0) + Math.max(0, shelves.length - 1) * o.gapY
  return { shelves, width, height }
}

/** Row widths worth trying: what 1..n of the biggest clouds need side by side, plus a geometric scan between the extremes. */
function candidateWidths(sorted: readonly PackItem[], gapX: number): number[] {
  const out: number[] = []
  let acc = 0
  sorted.forEach((it, k) => { acc += 2 * it.halo + (k > 0 ? gapX : 0); out.push(acc) })
  const lo = 2 * sorted[0].halo
  const hi = acc
  if (hi > lo) for (let k = 0; k <= 32; k++) out.push(lo * Math.pow(hi / lo, k / 32))
  return [...new Set(out.map(v => Math.ceil(v * 1000) / 1000))].sort((a, b) => a - b)
}

/** Tolerance (natural-log of the aspect ratio) inside which a fuller block beats a more exact aspect. */
const ASPECT_SLACK = 0.04

export function packClouds(items: readonly PackItem[], aspect: number, opts: PackOptions): PackResult {
  const positions = new Map<string, { x: number; y: number }>()
  if (items.length === 0) return { positions, width: 0, height: 0 }
  const target = Number.isFinite(aspect) && aspect > 0 ? aspect : 1
  const sorted = [...items].sort((a, b) => b.halo - a.halo || a.id.localeCompare(b.id))
  const discArea = sorted.reduce((s, it) => s + Math.PI * it.halo * it.halo, 0)

  const scored = candidateWidths(sorted, opts.gapX).map(w => {
    const p = packAt(sorted, w, opts)
    return { ...p, err: Math.abs(Math.log(p.width / p.height / target)), fill: discArea / (p.width * p.height) }
  })
  const bestErr = scored.reduce((m, s) => Math.min(m, s.err), Infinity)
  // Among the near-exact shapes take the fullest; the candidates are in ascending width, so ties keep the narrowest.
  let best = scored[0]
  let found = false
  for (const s of scored) {
    if (s.err > bestErr + ASPECT_SLACK) continue
    if (!found || s.fill > best.fill + 1e-9 || (Math.abs(s.fill - best.fill) <= 1e-9 && s.err < best.err - 1e-9)) { best = s; found = true }
  }

  let top = -best.height / 2
  for (const shelf of best.shelves) {
    // Rows are centred in the block; the clouds of a row sit on the row's middle line.
    let left = -best.width / 2 + (best.width - shelf.used) / 2
    for (const item of shelf.items) {
      const cellH = 2 * item.halo + opts.captionRoom
      positions.set(item.id, {
        x: left + item.halo,
        y: top + (shelf.height - cellH) / 2 + item.halo,
      })
      left += 2 * item.halo + opts.gapX
    }
    top += shelf.height + opts.gapY
  }
  return { positions, width: best.width, height: best.height }
}
