import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { placeBlob, placeResources, linkPull, hashString, BLOB_GAP, clearOfCaption, CAPTION_HALF_WIDTH, CAPTION_HEIGHT, type BlobUnit, type PlacementCloud } from './fleet-placement'

const units = (n: number, r = 80): BlobUnit[] => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, radius: r }))

test('placeBlob: same input, same blob; the seed (profile) changes the shape', () => {
  const a = placeBlob(units(7), 'taxis')
  const b = placeBlob(units(7), 'taxis')
  assert.deepEqual([...a.positions], [...b.positions])
  assert.equal(a.radius, b.radius)
  const c = placeBlob(units(7), 'sophia')
  assert.notDeepEqual([...a.positions], [...c.positions])
})

test('placeBlob: units never overlap, are centred on the centroid, and fit in the reported radius', () => {
  const blob = placeBlob(units(25, 70), 'omh-coder')
  const pts = [...blob.positions.values()]
  assert.equal(pts.length, 25)
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  assert.ok(Math.abs(cx) < 1e-6 && Math.abs(cy) < 1e-6, 'centroid at the origin')
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Math.hypot(pts[i].x, pts[i].y) + 70 <= blob.radius + 1e-6)
    for (let j = i + 1; j < pts.length; j++) assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) >= 140, `units ${i} and ${j} apart`)
  }
})

/** Smallest edge-to-edge gap between two units of a blob (negative = overlap). */
function minEdgeGap(blob: ReturnType<typeof placeBlob>, us: readonly BlobUnit[]): number {
  let min = Infinity
  for (let i = 0; i < us.length; i++) {
    for (let j = i + 1; j < us.length; j++) {
      const a = blob.positions.get(us[i].id)!
      const b = blob.positions.get(us[j].id)!
      min = Math.min(min, Math.hypot(a.x - b.x, a.y - b.y) - us[i].radius - us[j].radius)
    }
  }
  return min
}

test('placeBlob: no two units overlap and none is further apart than BLOB_GAP needs (mixed sizes, many seeds and counts)', () => {
  for (const seed of ['taxis', 'sophia', 'omh-coder', 'a', 'hestia', 'alpha demo']) {
    for (const n of [2, 3, 4, 5, 8, 13, 21, 34]) {
      const us: BlobUnit[] = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, radius: [70, 130, 222, 90][i % 4] }))
      const blob = placeBlob(us, seed)
      const gap = minEdgeGap(blob, us)
      assert.ok(gap >= BLOB_GAP - 1e-6, `${seed} n=${n}: smallest gap ${gap}`)
      // Tight: the closest pair sits right at the gap, not loosely beyond it.
      assert.ok(gap <= BLOB_GAP + 1, `${seed} n=${n}: smallest gap ${gap} is loose`)
    }
  }
})

test('placeBlob: grouping stays tight (radius per unit does not creep back up)', () => {
  // radius / (r * sqrt(n)): a perfect hexagonal packing is about 1.1; the old spiral with a 16 gap sat at 1.5-1.6 for 5-8 units.
  for (const n of [3, 5, 8, 13, 21, 34]) {
    for (const r of [70, 222]) {
      const us = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, radius: r }))
      const blob = placeBlob(us, 'omh-coder')
      assert.ok(blob.radius <= 1.55 * r * Math.sqrt(n), `n=${n} r=${r}: radius ${blob.radius}`)
    }
  }
  assert.ok(BLOB_GAP <= 8, 'gap between units')
})

test('placeBlob: a new session joins the blob without moving the existing ones relative to each other', () => {
  const rel = (blob: ReturnType<typeof placeBlob>, a: string, b: string) => {
    const p = blob.positions.get(a)!
    const q = blob.positions.get(b)!
    return [q.x - p.x, q.y - p.y]
  }
  const before = placeBlob(units(5), 'taxis')
  const after = placeBlob(units(6), 'taxis')
  const [bx, by] = rel(before, 's0', 's3')
  const [ax, ay] = rel(after, 's0', 's3')
  assert.ok(Math.abs(bx - ax) < 1e-9 && Math.abs(by - ay) < 1e-9)
  assert.deepEqual(placeBlob([], 'x').positions.size, 0)
  const one = placeBlob(units(1), 'x').positions.get('s0')!
  assert.ok(Math.abs(one.x) < 1e-9 && Math.abs(one.y) < 1e-9)
})

test('hashString is stable', () => {
  assert.equal(hashString('taxis'), hashString('taxis'))
  assert.notEqual(hashString('taxis'), hashString('sophia'))
})

const CLOUDS: PlacementCloud[] = [
  { id: 'cloud:a', x: 0, y: 0, r: 150 },
  { id: 'cloud:b', x: 800, y: 0, r: 150 },
  { id: 'cloud:c', x: 400, y: 700, r: 150 },
]

test('placeResources: a resource sits near the weighted centroid of the clouds it links to', () => {
  const pos = placeResources(CLOUDS, [
    { id: 'kanban:both', links: [{ cloudId: 'cloud:a', weight: 1 }, { cloudId: 'cloud:b', weight: 1 }] },
    { id: 'kanban:heavy-b', links: [{ cloudId: 'cloud:a', weight: 1 }, { cloudId: 'cloud:b', weight: 9 }] },
  ])
  // Equal weights: halfway between a and b, x = 400.
  assert.ok(Math.abs(pos.get('kanban:both')!.x - 400) < 60, `x=${pos.get('kanban:both')!.x}`)
  // Weight 9 vs 1: pulled towards b (the weighted centroid is x=720, inside b's halo, so it stops at the halo's edge: x=568).
  const heavy = pos.get('kanban:heavy-b')!
  assert.ok(heavy.x > pos.get('kanban:both')!.x + 100)
  assert.ok(Math.hypot(heavy.x - 800, heavy.y) < Math.hypot(heavy.x, heavy.y), 'closer to b than to a')
  assert.ok(Math.hypot(heavy.x - 800, heavy.y) < 150 + 46 + 36 + 5, 'right at the edge of the halo of b')
})

test('placeResources: resources stay out of every halo and apart from each other', () => {
  const resources = Array.from({ length: 12 }, (_, i) => ({ id: `kanban:r${i}`, links: [{ cloudId: 'cloud:a', weight: 1 + i }] }))
  const pos = placeResources(CLOUDS, resources)
  assert.equal(pos.size, 12)
  for (const [id, p] of pos) {
    for (const c of CLOUDS) assert.ok(Math.hypot(p.x - c.x, p.y - c.y) >= c.r + 46, `${id} outside the halo of ${c.id}`)
  }
  const pts = [...pos.values()]
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) >= 80, 'resources do not stack')
  }
})

test('placeResources: unlinked resources go to a rim outside all clouds, wide maps spread sideways', () => {
  const pos = placeResources(CLOUDS, [
    { id: 'supermemory:u1', links: [] }, { id: 'supermemory:u2', links: [{ cloudId: 'cloud:gone', weight: 5 }] }, { id: 'supermemory:u3', links: [] },
  ])
  assert.equal(pos.size, 3)
  for (const p of pos.values()) {
    for (const c of CLOUDS) assert.ok(Math.hypot(p.x - c.x, p.y - c.y) >= c.r, 'outside every halo')
    const inside = p.x > -150 && p.x < 950 && p.y > -150 && p.y < 850
    assert.ok(!inside, 'outside the bounding box of the clouds')
  }
  // A wide row of clouds: the two unlinked resources end up left and right, not above and below.
  const row: PlacementCloud[] = [{ id: 'cloud:a', x: 0, y: 0, r: 100 }, { id: 'cloud:b', x: 600, y: 0, r: 100 }, { id: 'cloud:c', x: 1200, y: 0, r: 100 }]
  const two = placeResources(row, [{ id: 'k:1', links: [] }, { id: 'k:2', links: [] }])
  assert.ok(Math.abs(two.get('k:1')!.y) < 150 && Math.abs(two.get('k:2')!.y) < 150)
  assert.ok(two.get('k:1')!.x > 1200 && two.get('k:2')!.x < 0)
})

test('placeResources: deterministic, independent of the order of the input, no clouds is fine', () => {
  const res = [
    { id: 'k:1', links: [{ cloudId: 'cloud:a', weight: 3 }, { cloudId: 'cloud:c', weight: 2 }] },
    { id: 'k:2', links: [{ cloudId: 'cloud:b', weight: 1 }] },
    { id: 'k:3', links: [] },
  ]
  const one = placeResources(CLOUDS, res)
  const two = placeResources([...CLOUDS].reverse(), [...res].reverse())
  assert.deepEqual([...one].sort(), [...two].sort())
  assert.deepEqual([...placeResources(CLOUDS, res)], [...one])
  const none = placeResources([], res)
  assert.equal(none.size, 3)
  for (const p of none.values()) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y))
})

test('placeResources: resources keep clear of the caption box under every halo', () => {
  const resources = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `kanban:r${i}`, links: [{ cloudId: 'cloud:a', weight: 1 + i }, { cloudId: 'cloud:b', weight: 2 }] })),
    { id: 'supermemory:u1', links: [] }, { id: 'supermemory:u2', links: [] },
  ]
  const pos = placeResources(CLOUDS, resources)
  for (const [id, p] of pos) {
    for (const c of CLOUDS) {
      const inX = p.x > c.x - CAPTION_HALF_WIDTH && p.x < c.x + CAPTION_HALF_WIDTH
      const inY = p.y > c.y + c.r && p.y < c.y + c.r + CAPTION_HEIGHT
      assert.ok(!(inX && inY), `${id} is inside the caption box of ${c.id}`)
    }
  }
})

test('clearOfCaption: a point inside the box leaves it, a clear point stays', () => {
  const c: PlacementCloud = { id: 'c', x: 0, y: 0, r: 100 }
  const inside = clearOfCaption({ x: 20, y: 120 }, c)
  assert.ok(Math.abs(inside.x) > CAPTION_HALF_WIDTH || inside.y > 100 + CAPTION_HEIGHT || inside.y < 100, `${JSON.stringify(inside)}`)
  const far = { x: 400, y: 400 }
  assert.equal(clearOfCaption(far, c), far)
})

// ─── Weights by session node ─────────────────────────────────────────────────

const WITH_NODES: PlacementCloud[] = [
  { id: 'cloud:a', x: 0, y: 0, r: 150, nodes: [{ id: 'a::west', x: -90, y: 0 }, { id: 'a::east', x: 90, y: 0 }] },
  { id: 'cloud:b', x: 800, y: 0, r: 150, nodes: [{ id: 'b::only', x: 800, y: 0 }] },
]

test('linkPull: the weighted mean of the session nodes behind the link; the cloud centre when none is known', () => {
  const a = WITH_NODES[0]
  const pull = linkPull(a, { cloudId: 'cloud:a', weight: 10, sessions: [{ id: 'a::west', weight: 3 }, { id: 'a::east', weight: 1 }] })
  assert.deepEqual([pull.x, pull.y, pull.weight], [-45, 0, 10])
  assert.deepEqual(linkPull(a, { cloudId: 'cloud:a', weight: 4 }), { x: 0, y: 0, weight: 4 }, 'no session data: the centre')
  assert.deepEqual(linkPull(a, { cloudId: 'cloud:a', weight: 4, sessions: [{ id: 'elsewhere', weight: 5 }] }), { x: 0, y: 0, weight: 4 }, 'a session that is not in this cloud is ignored')
  assert.deepEqual(linkPull({ id: 'c', x: 5, y: 6, r: 1 }, { cloudId: 'c', weight: 0, sessions: [{ id: 'x', weight: 1 }] }), { x: 5, y: 6, weight: 1 }, 'a cloud without nodes, weight floored at 1')
})

test('placeResources: a resource used by one cloud moves with the weights of ITS SESSIONS (it used to ignore the weight)', () => {
  const at = (west: number, east: number) => placeResources(WITH_NODES, [
    { id: 'kanban:x', links: [{ cloudId: 'cloud:a', weight: west + east, sessions: [{ id: 'a::west', weight: west }, { id: 'a::east', weight: east }] }] },
  ]).get('kanban:x')!
  const w = at(9, 1)
  const e = at(1, 9)
  assert.ok(w.x < -150, `used mostly from the west node: west of the cloud (${w.x})`)
  assert.ok(e.x > 150, `used mostly from the east node: east of the cloud (${e.x})`)
  assert.ok(Math.abs(w.x + e.x) < 1e-6 && Math.abs(w.y - e.y) < 1e-6, 'mirror images')
  // Both are outside the halo, as before.
  for (const p of [w, e]) assert.ok(Math.hypot(p.x, p.y) >= 150 + 46)
})

test('placeResources: session weights add to the cloud weights (two clouds, one of them used from one node)', () => {
  const one = placeResources(WITH_NODES, [
    { id: 'kanban:x', links: [{ cloudId: 'cloud:a', weight: 5, sessions: [{ id: 'a::east', weight: 5 }] }, { cloudId: 'cloud:b', weight: 5 }] },
  ]).get('kanban:x')!
  const plain = placeResources(WITH_NODES, [
    { id: 'kanban:x', links: [{ cloudId: 'cloud:a', weight: 5 }, { cloudId: 'cloud:b', weight: 5 }] },
  ]).get('kanban:x')!
  assert.ok(one.x > plain.x - 1e-6, 'pulled to a\'s east node, so it sits at least as far east as with the plain centre')
})

test('placeResources: links without session data behave as before (the cloud centre)', () => {
  const withNodes = placeResources(WITH_NODES, [{ id: 'k', links: [{ cloudId: 'cloud:a', weight: 2 }, { cloudId: 'cloud:b', weight: 1 }] }])
  const without = placeResources(WITH_NODES.map(({ nodes: _nodes, ...c }) => c), [{ id: 'k', links: [{ cloudId: 'cloud:a', weight: 2 }, { cloudId: 'cloud:b', weight: 1 }] }])
  assert.deepEqual([...withNodes], [...without])
})
