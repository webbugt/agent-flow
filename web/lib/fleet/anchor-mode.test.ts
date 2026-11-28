import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  ANCHOR_DIM_ALPHA, ANCHOR_SPACING, CURRENT_USE_MS, EXPLICIT_LINK_WEIGHT, buildRelations, coUseWeights, currentResource,
  dimToolCalls, edgeHoverAlpha, hoverDimmer,
  ANCHOR_VIEW_PAD, explicitLinkPairs, fitAnchorsToAspect, hoverAlpha, layoutWeights, pairKey, paletteIndex, placeAnchorSessions, placeAnchors, profileColor,
  proximityWeights, weightOf,
} from './anchor-mode'
import { DEFAULT_PROFILE_PALETTE } from './options-registry'
import { hashString } from './fleet-placement'

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

// ─── hash to palette ────────────────────────────────────────────────────────

test('paletteIndex: hash(name) mod palette length, stable and case/space-insensitive', () => {
  for (const len of [1, 3, 8, 11]) {
    const i = paletteIndex('taxis', len)
    assert.equal(i, hashString('taxis') % len)
    assert.equal(paletteIndex('taxis', len), i, 'stable')
    assert.equal(paletteIndex('  Taxis ', len), i, 'same profile however it is written')
    assert.ok(i >= 0 && i < len)
  }
  assert.equal(paletteIndex('anything', 0), 0, 'empty palette: index 0, no NaN')
})

test('profileColor: uses the palette array, so a changed palette changes the colour', () => {
  const pal = ['#111111', '#222222', '#333333']
  const c = profileColor('omh-coder', pal)
  assert.equal(c, pal[hashString('omh-coder') % 3])
  const other = ['#aaaaaa', '#bbbbbb', '#cccccc']
  assert.equal(profileColor('omh-coder', other), other[hashString('omh-coder') % 3])
  assert.ok(pal.includes(c))
})

test('profileColor: collisions are accepted (a one-colour palette gives every profile that colour)', () => {
  const pal = ['#123456']
  assert.equal(profileColor('a', pal), '#123456')
  assert.equal(profileColor('b', pal), '#123456')
  assert.equal(profileColor('sophia', pal), profileColor('taxis', pal))
})

test('profileColor: an override beats the palette; the others keep their palette colour; empty palette uses the default', () => {
  const pal = ['#111111', '#222222']
  assert.equal(profileColor('taxis', pal, { taxis: '#ff0000' }), '#ff0000')
  assert.equal(profileColor('Taxis', pal, { taxis: '#ff0000' }), '#ff0000', 'override keyed by lower-case name')
  assert.equal(profileColor('sophia', pal, { taxis: '#ff0000' }), profileColor('sophia', pal))
  assert.ok(DEFAULT_PROFILE_PALETTE.includes(profileColor('sophia', [])))
})

// ─── weights ────────────────────────────────────────────────────────────────

test('coUseWeights: runs that touched both count, by the smaller number of uses', () => {
  const w = coUseWeights([
    { unit: 's1', resource: 'A', weight: 4 }, { unit: 's1', resource: 'B', weight: 2 },
    { unit: 's2', resource: 'A', weight: 1 }, { unit: 's2', resource: 'B', weight: 5 }, { unit: 's2', resource: 'C', weight: 1 },
    { unit: 's3', resource: 'C', weight: 9 },
  ])
  assert.equal(weightOf(w, 'A', 'B'), 2 + 1)
  assert.equal(weightOf(w, 'B', 'A'), 3, 'symmetric')
  assert.equal(weightOf(w, 'A', 'C'), 1)
  assert.equal(weightOf(w, 'B', 'C'), 1)
  assert.equal(w.size, 3, 's3 touched only C: no pair')
})

test('explicitLinkPairs: a Kanban board is tied to the memory namespace of the same project', () => {
  const pairs = explicitLinkPairs([
    { id: 'kanban:agent-flow', kind: 'kanban', label: 'agent-flow' },
    { id: 'memory:project:agent-flow', kind: 'supermemory', label: 'project:agent-flow' },
    { id: 'memory:omh_family', kind: 'supermemory', label: 'omh_family' },
    { id: 'bash:git', kind: 'bash', label: 'git' },
  ])
  assert.deepEqual(pairs, [['kanban:agent-flow', 'memory:project:agent-flow']])
  const w = layoutWeights(new Map(), pairs)
  assert.equal(weightOf(w, 'kanban:agent-flow', 'memory:project:agent-flow'), EXPLICIT_LINK_WEIGHT)
})

test('proximityWeights: uses within the window pair up, the same resource never pairs with itself', () => {
  const w = proximityWeights([
    { resource: 'A', at: 0 }, { resource: 'B', at: 10_000 }, { resource: 'A', at: 12_000 }, { resource: 'C', at: 500_000 },
  ], 30_000)
  assert.equal(weightOf(w, 'A', 'B'), 2)
  assert.equal(weightOf(w, 'A', 'C'), 0)
  assert.equal(weightOf(w, 'A', 'A'), 0)
})

// ─── co-use placement ───────────────────────────────────────────────────────

test('placeAnchors: resources with a strong co-use sit closer than unrelated ones', () => {
  const ids = ['kanban:alpha', 'memory:alpha', 'bash:git', 'bash:pnpm', 'subsystem:cron']
  const weights = layoutWeights(coUseWeights([
    { unit: 's1', resource: 'kanban:alpha', weight: 6 }, { unit: 's1', resource: 'memory:alpha', weight: 6 },
    { unit: 's2', resource: 'kanban:alpha', weight: 5 }, { unit: 's2', resource: 'memory:alpha', weight: 4 },
    { unit: 's3', resource: 'bash:git', weight: 7 }, { unit: 's3', resource: 'bash:pnpm', weight: 7 },
    { unit: 's4', resource: 'subsystem:cron', weight: 3 },
  ]), [])
  const pos = placeAnchors(ids, weights)
  const d = (a: string, b: string) => dist(pos.get(a)!, pos.get(b)!)
  assert.ok(d('kanban:alpha', 'memory:alpha') < d('kanban:alpha', 'bash:git'), 'related pair closer than unrelated')
  assert.ok(d('kanban:alpha', 'memory:alpha') < d('memory:alpha', 'bash:pnpm'))
  assert.ok(d('bash:git', 'bash:pnpm') < d('bash:git', 'subsystem:cron'))
  assert.ok(d('bash:git', 'bash:pnpm') < d('kanban:alpha', 'bash:pnpm'))
  // a stronger tie is closer than a weaker one
  const strongWeak = placeAnchors(['A', 'B', 'C'], new Map([[pairKey('A', 'B'), 12], [pairKey('A', 'C'), 1]]))
  assert.ok(dist(strongWeak.get('A')!, strongWeak.get('B')!) < dist(strongWeak.get('A')!, strongWeak.get('C')!))
})

test('placeAnchors: related anchors are closer than the mean distance of all pairs; nothing overlaps; deterministic', () => {
  const ids = Array.from({ length: 9 }, (_, i) => `r${i}`)
  const w = new Map<string, number>([[pairKey('r0', 'r1'), 8], [pairKey('r1', 'r2'), 8], [pairKey('r5', 'r6'), 8]])
  const a = placeAnchors(ids, w)
  const b = placeAnchors([...ids].reverse(), w)
  for (const id of ids) assert.deepEqual(a.get(id), b.get(id), `same map whatever the input order (${id})`)
  let sum = 0
  let n = 0
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const d = dist(a.get(ids[i])!, a.get(ids[j])!)
      assert.ok(d >= ANCHOR_SPACING - 1, `${ids[i]} ${ids[j]} apart`)
      sum += d; n++
    }
  }
  const mean = sum / n
  for (const [x, y] of [['r0', 'r1'], ['r1', 'r2'], ['r5', 'r6']]) assert.ok(dist(a.get(x)!, a.get(y)!) < mean, `${x}-${y} below the mean ${mean.toFixed(0)}`)
})

test('placeAnchors: no resources, one resource', () => {
  assert.equal(placeAnchors([], new Map()).size, 0)
  assert.deepEqual(placeAnchors(['only'], new Map()).get('only'), { x: 0, y: 0 })
})

test('placeAnchors: a new resource does not move the others far (the scene tween keeps it smooth)', () => {
  const w = new Map<string, number>([[pairKey('A', 'B'), 5]])
  const before = placeAnchors(['A', 'B', 'C'], w)
  const after = placeAnchors(['A', 'B', 'C', 'D'], w)
  for (const id of ['A', 'B', 'C']) assert.ok(dist(before.get(id)!, after.get(id)!) < 4 * ANCHOR_SPACING, `${id} stays in the neighbourhood`)
})

// ─── sessions drift to the resource they use ────────────────────────────────

test('currentResource: newest use inside the window; older uses do not count', () => {
  const s = { id: 's', radius: 70, usage: [
    { resource: 'A', weight: 9, lastAt: 1_000 }, { resource: 'B', weight: 1, lastAt: 50_000 },
  ] }
  assert.equal(currentResource(s, 60_000), 'B')
  assert.equal(currentResource(s, 1_000 + CURRENT_USE_MS + 1 + 1_000_000), null)
  assert.equal(currentResource({ ...s, usage: [] }, 0), null)
})

test('placeAnchorSessions: a session sits next to the resource it uses now; it moves when the use changes', () => {
  const anchors = placeAnchors(['A', 'B'], new Map())
  const mk = (resource: string, at: number) => [{ id: 's1', radius: 70, usage: [{ resource, weight: 1, lastAt: at }] }]
  const onA = placeAnchorSessions(mk('A', 1000), anchors, { now: 2000 }).get('s1')!
  const onB = placeAnchorSessions(mk('B', 3000), anchors, { now: 4000 }).get('s1')!
  assert.equal(onA.at, 'A')
  assert.equal(onB.at, 'B')
  assert.ok(dist(onA, anchors.get('A')!) < dist(onA, anchors.get('B')!), 'closest to A')
  assert.ok(dist(onB, anchors.get('B')!) < dist(onB, anchors.get('A')!), 'closest to B after the change')
  assert.ok(dist(onA, anchors.get('A')!) < 300, 'beside the anchor, not far away')
})

test('placeAnchorSessions: a resting session sits among the resources it used; none overlap; deterministic', () => {
  const anchors = placeAnchors(['A', 'B', 'C'], new Map())
  const sessions = [
    { id: 's1', radius: 70, usage: [{ resource: 'A', weight: 5, lastAt: 0 }] },
    { id: 's2', radius: 70, usage: [{ resource: 'A', weight: 5, lastAt: 0 }] },
    { id: 's3', radius: 70, usage: [] },
    { id: 's4', radius: 70, usage: [{ resource: 'B', weight: 1, lastAt: 1_000_000 }] },
  ]
  const a = placeAnchorSessions(sessions, anchors, { now: 1_000_100 })
  const b = placeAnchorSessions([...sessions].reverse(), anchors, { now: 1_000_100 })
  for (const s of sessions) assert.deepEqual(a.get(s.id), b.get(s.id))
  assert.equal(a.get('s1')!.at, null, 'its use is old: resting')
  assert.equal(a.get('s4')!.at, 'B')
  const ids = sessions.map(s => s.id)
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) assert.ok(dist(a.get(ids[i])!, a.get(ids[j])!) >= 140, `${ids[i]} and ${ids[j]} do not overlap`)
    for (const p of anchors.values()) assert.ok(dist(a.get(ids[i])!, p) >= 46 + 70, `${ids[i]} clear of the anchors`)
  }
})

// ─── hover opacity ──────────────────────────────────────────────────────────

test('hoverAlpha: hovered and related nodes at 100%, every other node at 80%, nothing hovered: all 100%', () => {
  const related = new Set(['kanban:x', 'sess:1'])
  assert.equal(ANCHOR_DIM_ALPHA, 0.8)
  assert.equal(hoverAlpha('memory:y', 'memory:y', related), 1, 'the hovered node itself')
  assert.equal(hoverAlpha('kanban:x', 'memory:y', related), 1, 'a related node')
  assert.equal(hoverAlpha('sess:1', 'memory:y', related), 1)
  assert.equal(hoverAlpha('bash:git', 'memory:y', related), 0.8, 'an unrelated node drops to 80%')
  assert.equal(hoverAlpha('sess:9', 'memory:y', new Set()), 0.8)
  assert.equal(hoverAlpha('sess:9', 'memory:y', undefined), 0.8, 'no relations known: still dimmed')
  assert.equal(hoverAlpha('bash:git', null, related), 1, 'no hover: nothing dimmed')
})

test('buildRelations: a resource relates to its sessions and to co-used / explicitly linked resources; symmetric', () => {
  const uses = [
    { unit: 's1', resource: 'kanban:a', weight: 2 }, { unit: 's1', resource: 'memory:a', weight: 1 },
    { unit: 's2', resource: 'bash:git', weight: 3 },
    { unit: 'cloud:taxis', resource: 'bash:git', weight: 1 },
  ]
  const rel = buildRelations({
    uses,
    nodesOf: new Map([['cloud:taxis', ['s7', 's8']]]),
    weights: layoutWeights(coUseWeights(uses), []),
  })
  assert.ok(rel.get('kanban:a')!.has('s1'))
  assert.ok(rel.get('s1')!.has('kanban:a'), 'symmetric')
  assert.ok(rel.get('kanban:a')!.has('memory:a'), 'co-use')
  assert.ok(rel.get('bash:git')!.has('s2'))
  assert.ok(rel.get('bash:git')!.has('s7') && rel.get('bash:git')!.has('s8'), 'a profile stands for its nodes')
  assert.ok(!rel.get('bash:git')!.has('kanban:a'), 'no co-use, no relation')
  assert.ok(!rel.get('kanban:a')!.has('s2'))
  // the hover rule on top of it: hovering kanban:a keeps s1 and memory:a at 100%, drops bash:git and s2 to 80%
  const related = rel.get('kanban:a')
  assert.deepEqual(['s1', 'memory:a', 'bash:git', 's2'].map(id => hoverAlpha(id, 'kanban:a', related)), [1, 1, 0.8, 0.8])
})

// ─── hover dim of tool-call cards and tree edges (R6: everything else at 80%) ──

test('hoverDimmer: null while nothing is hovered or there are no relations; else hoverAlpha of the hovered node', () => {
  const relations = new Map([['kanban:a', new Set(['s1'])], ['s1', new Set(['kanban:a'])]])
  assert.equal(hoverDimmer(undefined, 'kanban:a'), null, 'mode off: no relations')
  assert.equal(hoverDimmer(relations, null), null, 'nothing hovered')
  const dim = hoverDimmer(relations, 'kanban:a')!
  assert.deepEqual(['kanban:a', 's1', 's2'].map(dim), [1, 1, ANCHOR_DIM_ALPHA])
})

test('dimToolCalls: a card takes the factor of its agent; the input map is not changed; the same map when nothing is dimmed', () => {
  const tools = new Map([
    ['t1', { agentId: 's1', opacity: 1 }],
    ['t2', { agentId: 's2', opacity: 0.5 }],
  ])
  assert.equal(dimToolCalls(tools, null), tools)
  const dim = hoverDimmer(new Map([['kanban:a', new Set(['s1'])]]), 'kanban:a')!
  const out = dimToolCalls(tools, dim)
  assert.equal(out.get('t1')!.opacity, 1, 'card of a related session stays at 100%')
  assert.equal(out.get('t2')!.opacity, 0.5 * ANCHOR_DIM_ALPHA, 'card of an unrelated session: 80% of its own opacity')
  assert.equal(tools.get('t2')!.opacity, 0.5, 'input untouched')
})

test('edgeHoverAlpha: full while either end is hovered or related; 80% for an edge between unrelated nodes; tool edges use the tool\'s agent', () => {
  const dim = hoverDimmer(new Map([['s1', new Set(['s1b'])], ['s1b', new Set(['s1'])]]), 's1')!
  const agentOfTool = (id: string) => (id === 'tool-1' ? 's1b' : id === 'tool-9' ? 's9' : undefined)
  assert.equal(edgeHoverAlpha({ from: 's1', to: 's1b' }, agentOfTool, dim), 1, 'parent edge of the hovered node')
  assert.equal(edgeHoverAlpha({ from: 's1b', to: 'tool-1' }, agentOfTool, dim), 1, 'tool edge of a related node')
  assert.equal(edgeHoverAlpha({ from: 's9', to: 'tool-9' }, agentOfTool, dim), ANCHOR_DIM_ALPHA, 'tool edge of an unrelated node')
  assert.equal(edgeHoverAlpha({ from: 's8', to: 's9' }, agentOfTool, dim), ANCHOR_DIM_ALPHA, 'parent edge between unrelated nodes')
  assert.equal(edgeHoverAlpha({ from: 's8', to: 's9' }, agentOfTool, null), 1, 'nothing dimmed')
})

// ─── fitAnchorsToAspect: the anchors flow into the shape of the viewport ────

const VIEWPORTS: Array<[string, number]> = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1]]

/** Chain-ish co-use between neighbours, as a real project's boards and memories have. */
function chainWeights(ids: readonly string[]): Map<string, number> {
  const w = new Map<string, number>()
  for (let i = 0; i + 1 < ids.length; i++) w.set(pairKey(ids[i], ids[i + 1]), 3 + (i % 4))
  return w
}

/** Shape the viewport sees: the anchors' bounding box grown by the room of the nodes around an anchor. */
function seenAspect(pos: ReadonlyMap<string, { x: number; y: number }>): number {
  const pts = [...pos.values()]
  const w = Math.max(...pts.map(p => p.x)) - Math.min(...pts.map(p => p.x))
  const h = Math.max(...pts.map(p => p.y)) - Math.min(...pts.map(p => p.y))
  return (w + 2 * ANCHOR_VIEW_PAD) / (h + 2 * ANCHOR_VIEW_PAD)
}

const asFactor = (a: number, b: number) => Math.max(a / b, b / a)

test('fitAnchorsToAspect: 3..12 anchors, 16:9 / 9:16 / 1:1: the block is within a factor 1.6 of the viewport, the least separation holds', () => {
  for (const [name, aspect] of VIEWPORTS) {
    for (let n = 3; n <= 12; n++) {
      const ids = Array.from({ length: n }, (_, i) => `r${i}`)
      const base = placeAnchors(ids, chainWeights(ids))
      const fitted = fitAnchorsToAspect(base, aspect)
      assert.equal(fitted.size, n)
      const f = asFactor(seenAspect(fitted), aspect)
      assert.ok(f <= 1.6, `n=${n} ${name}: aspect ${seenAspect(fitted).toFixed(2)} vs ${aspect.toFixed(2)} (factor ${f.toFixed(2)})`)
      // Never worse than before the fit.
      assert.ok(f <= asFactor(seenAspect(base), aspect) + 1e-9, `n=${n} ${name}: not worse than the unfitted layout`)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          assert.ok(dist(fitted.get(ids[i])!, fitted.get(ids[j])!) >= ANCHOR_SPACING - 1, `n=${n} ${name}: ${ids[i]}/${ids[j]} keep the separation`)
        }
      }
    }
  }
})

test('fitAnchorsToAspect: deterministic, independent of input order, centred; small inputs pass through', () => {
  const ids = Array.from({ length: 8 }, (_, i) => `r${i}`)
  const base = placeAnchors(ids, chainWeights(ids))
  for (const [, aspect] of VIEWPORTS) {
    const a = fitAnchorsToAspect(base, aspect)
    const b = fitAnchorsToAspect(placeAnchors([...ids].reverse(), chainWeights(ids)), aspect)
    for (const id of ids) assert.deepEqual(a.get(id), b.get(id), `${id}: same place`)
    const xs = [...a.values()].map(p => p.x)
    const ys = [...a.values()].map(p => p.y)
    assert.ok(Math.abs(Math.max(...xs) + Math.min(...xs)) < 1e-6 && Math.abs(Math.max(...ys) + Math.min(...ys)) < 1e-6, 'centred on its box')
  }
  assert.equal(fitAnchorsToAspect(new Map(), 1.7).size, 0)
  assert.deepEqual(fitAnchorsToAspect(new Map([['only', { x: 5, y: 7 }]]), 1.7).get('only'), { x: 5, y: 7 })
  for (const bad of [0, -2, NaN, Infinity]) assert.deepEqual([...fitAnchorsToAspect(base, bad)], [...base], `aspect ${bad}: unchanged`)
})

test('fitAnchorsToAspect: a layout of the wrong orientation is turned, not stretched into a ribbon', () => {
  // Four anchors in a tall line: for a wide viewport turning is cheaper than stretching the thin axis.
  const tall = new Map([['a', { x: 0, y: -300 }], ['b', { x: 8, y: -100 }], ['c', { x: -6, y: 100 }], ['d', { x: 0, y: 300 }]])
  const out = fitAnchorsToAspect(tall, 16 / 9)
  const xs = [...out.values()].map(p => p.x)
  const ys = [...out.values()].map(p => p.y)
  assert.ok(Math.max(...xs) - Math.min(...xs) > Math.max(...ys) - Math.min(...ys), 'wider than tall for 16:9')
  for (const [i, a] of [...out.values()].entries()) for (const b of [...out.values()].slice(i + 1)) assert.ok(dist(a, b) >= 200 - 1e-6, 'turning and stretching never bring two anchors closer')
})
