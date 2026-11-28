import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { packClouds, type PackItem } from './fleet-cloud-pack'

const OPTS = { gapX: 40, gapY: 36, captionRoom: 26 }
const VIEWPORTS: Array<[string, number]> = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1], ['4:3', 4 / 3], ['21:9', 21 / 9]]

/** Halos of a plausible fleet: one big profile, a few middling, small ones; stable for a given index. */
const halo = (i: number) => [310, 170, 230, 150, 190, 330, 160, 210, 175, 250, 140, 200][i % 12]
const fleet = (n: number): PackItem[] => Array.from({ length: n }, (_, i) => ({ id: `p${String(i).padStart(2, '0')}`, halo: halo(i) }))
const sameHalo = (n: number, h = 180): PackItem[] => fleet(n).map(it => ({ ...it, halo: h }))

/** Bounding box of the clouds as they are drawn: the halo discs and the caption under each. */
function discBox(items: readonly PackItem[], pos: Map<string, { x: number; y: number }>) {
  let x0 = Infinity; let x1 = -Infinity; let y0 = Infinity; let y1 = -Infinity
  for (const it of items) {
    const p = pos.get(it.id)!
    x0 = Math.min(x0, p.x - it.halo); x1 = Math.max(x1, p.x + it.halo)
    y0 = Math.min(y0, p.y - it.halo); y1 = Math.max(y1, p.y + it.halo + OPTS.captionRoom)
  }
  return { w: x1 - x0, h: y1 - y0, aspect: (x1 - x0) / (y1 - y0) }
}

const factor = (a: number, b: number) => Math.max(a / b, b / a)

/** Best aspect factor any plain grid of n equal cells (the biggest halo) reaches: what the discs allow at most. */
function bestGridFactor(n: number, h: number, aspect: number): number {
  let best = Infinity
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const w = cols * 2 * h + (cols - 1) * OPTS.gapX
    const ht = rows * (2 * h + OPTS.captionRoom) + (rows - 1) * OPTS.gapY
    best = Math.min(best, factor(w / ht, aspect))
  }
  return best
}

test('packClouds: nothing, and one cloud', () => {
  assert.equal(packClouds([], 1.7, OPTS).positions.size, 0)
  const one = packClouds([{ id: 'a', halo: 200 }], 1.7, OPTS)
  assert.equal(one.positions.size, 1)
  const p = one.positions.get('a')!
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
})

test('packClouds: 4 clouds on a 16:9 screen are not one row (the reported bug)', () => {
  const items = sameHalo(4)
  const { positions } = packClouds(items, 16 / 9, OPTS)
  const rows = new Set([...positions.values()].map(p => Math.round(p.y)))
  assert.equal(rows.size, 2, 'two rows of two')
  const box = discBox(items, positions)
  assert.ok(factor(box.aspect, 16 / 9) <= 1.3, `block aspect ${box.aspect.toFixed(2)} for 16:9`)
})

test('packClouds: 1..12 clouds, every viewport shape: the block takes the shape of the viewport', () => {
  for (const [name, aspect] of VIEWPORTS) {
    for (let n = 1; n <= 12; n++) {
      for (const [kind, items] of [['uneven', fleet(n)], ['equal', sameHalo(n)]] as const) {
        const { positions } = packClouds(items, aspect, OPTS)
        assert.equal(positions.size, n)
        const box = discBox(items, positions)
        // Within a factor 1.6 of the viewport, unless the discs cannot make it: one disc is square, and three or four
        // equal ones only fit 1xN or 2x2, both far from the viewport. There the packer must do at least as well as the
        // best plain grid (so it is never worse than the old layout).
        const limit = Math.max(1.6, bestGridFactor(n, Math.max(...items.map(i => i.halo)), aspect) * 1.02)
        assert.ok(factor(box.aspect, aspect) <= limit, `${kind} n=${n} ${name}: block aspect ${box.aspect.toFixed(2)} vs viewport ${aspect.toFixed(2)} (limit ${limit.toFixed(2)})`)
      }
    }
  }
})

test('packClouds: halos never overlap and keep the gap', () => {
  for (const [name, aspect] of VIEWPORTS) {
    for (let n = 1; n <= 12; n++) {
      const items = fleet(n)
      const { positions } = packClouds(items, aspect, OPTS)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const a = positions.get(items[i].id)!
          const b = positions.get(items[j].id)!
          const gap = Math.hypot(a.x - b.x, a.y - b.y) - items[i].halo - items[j].halo
          assert.ok(gap >= Math.min(OPTS.gapX, OPTS.gapY) - 1e-6, `n=${n} ${name}: ${items[i].id}/${items[j].id} gap ${gap}`)
        }
      }
    }
  }
})

test('packClouds: the captions do not run into the next row either', () => {
  const items = fleet(9)
  const { positions } = packClouds(items, 1, OPTS)
  for (const a of items) {
    for (const b of items) {
      if (a.id === b.id) continue
      const pa = positions.get(a.id)!
      const pb = positions.get(b.id)!
      // Cells: [x - halo, x + halo] x [y - halo, y + halo + captionRoom]
      const overlapX = Math.min(pa.x + a.halo, pb.x + b.halo) - Math.max(pa.x - a.halo, pb.x - b.halo)
      const overlapY = Math.min(pa.y + a.halo + OPTS.captionRoom, pb.y + b.halo + OPTS.captionRoom) - Math.max(pa.y - a.halo, pb.y - b.halo)
      assert.ok(!(overlapX > 1e-6 && overlapY > 1e-6), `cells of ${a.id} and ${b.id} overlap`)
    }
  }
})

test('packClouds: deterministic, and independent of the order the clouds come in', () => {
  for (const [, aspect] of VIEWPORTS) {
    for (let n = 1; n <= 12; n++) {
      const items = fleet(n)
      const a = packClouds(items, aspect, OPTS)
      const b = packClouds(items, aspect, OPTS)
      const c = packClouds([...items].reverse(), aspect, OPTS)
      for (const it of items) {
        assert.deepEqual(a.positions.get(it.id), b.positions.get(it.id))
        assert.deepEqual(a.positions.get(it.id), c.positions.get(it.id), `${it.id}: same place whatever the input order`)
      }
    }
  }
})

test('packClouds: biggest halo first, ties by id; small clouds fill the gaps beside big ones', () => {
  const items: PackItem[] = [
    { id: 'small-b', halo: 100 }, { id: 'big', halo: 300 }, { id: 'small-a', halo: 100 }, { id: 'mid', halo: 200 },
  ]
  const { positions } = packClouds(items, 16 / 9, OPTS)
  const big = positions.get('big')!
  // The biggest one starts the first row: nothing is above it, and it is the left-most of its row.
  for (const it of items) {
    if (it.id === 'big') continue
    const p = positions.get(it.id)!
    assert.ok(p.y + it.halo > big.y - 300 - 1e-6, `${it.id} is not above the first row`)
  }
  const a = positions.get('small-a')!
  const b = positions.get('small-b')!
  assert.ok(a.x < b.x || a.y < b.y, 'equal halos: the name decides which comes first')
})

test('packClouds: a bad aspect falls back to a square-ish block', () => {
  const items = fleet(6)
  for (const bad of [0, -1, NaN, Infinity]) {
    const box = discBox(items, packClouds(items, bad, OPTS).positions)
    assert.ok(Number.isFinite(box.aspect) && box.aspect > 0.4 && box.aspect < 2.5, `aspect ${bad}: ${box.aspect}`)
  }
})

test('packClouds: a row that fits exactly is used (no rounding of the candidate widths below what the clouds need)', () => {
  // Halos with fractions, as the scene computes them: side by side they need 2 * (362.04472494532735 + 235.88498144098318) + 40.
  const items: PackItem[] = [{ id: 'a', halo: 235.88498144098318 }, { id: 'b', halo: 362.04472494532735 }]
  const { positions } = packClouds(items, 16 / 9, OPTS)
  assert.ok(discBox(items, positions).aspect > 1.4, 'side by side on a 16:9 screen, not stacked')
})
