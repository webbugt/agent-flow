import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { GLIDE_EPSILON, GLIDE_TAU_MS, glideAll, glideStep, startPositions } from './fleet-glide'

test('glideStep: moves towards the target without overshooting, and arrives', () => {
  let p = { x: 0, y: 0 }
  const target = { x: 300, y: -120 }
  let last = Math.hypot(target.x - p.x, target.y - p.y)
  for (let i = 0; i < 400; i++) {
    p = glideStep(p, target, 16)
    const d = Math.hypot(target.x - p.x, target.y - p.y)
    assert.ok(d <= last + 1e-9, 'never moves away')
    assert.ok(p.x <= target.x + 1e-9 && p.y >= target.y - 1e-9, 'never passes the target')
    last = d
    if (d === 0) break
  }
  assert.deepEqual(p, target, 'lands exactly on the target (no endless tail)')
})

test('glideStep: frame-rate independent (one 100 ms step = ten 10 ms steps)', () => {
  const target = { x: 500, y: 200 }
  const whole = glideStep({ x: 0, y: 0 }, target, 100)
  let ten = { x: 0, y: 0 }
  for (let i = 0; i < 10; i++) ten = glideStep(ten, target, 10)
  assert.ok(Math.abs(whole.x - ten.x) < 1e-6 && Math.abs(whole.y - ten.y) < 1e-6)
})

test('glideStep: after one time constant about 63% of the way; no time, no move; already there stays', () => {
  const p = glideStep({ x: 0, y: 0 }, { x: 1000, y: 0 }, GLIDE_TAU_MS)
  assert.ok(Math.abs(p.x - 632.12) < 0.5, `x=${p.x}`)
  assert.deepEqual(glideStep({ x: 3, y: 4 }, { x: 100, y: 100 }, 0), { x: 3, y: 4 })
  assert.deepEqual(glideStep({ x: 3, y: 4 }, { x: 3 + GLIDE_EPSILON / 2, y: 4 }, 16), { x: 3 + GLIDE_EPSILON / 2, y: 4 })
})

test('startPositions: a resource already on the map starts where it is drawn, a new one at its target, a gone one is dropped', () => {
  const current = new Map([['kanban:old', { x: 10, y: 20 }], ['kanban:gone', { x: 1, y: 1 }]])
  const targets = new Map([['kanban:old', { x: 500, y: 600 }], ['kanban:new', { x: 7, y: 8 }]])
  const start = startPositions(current, targets)
  assert.deepEqual([...start].sort(), [['kanban:new', { x: 7, y: 8 }], ['kanban:old', { x: 10, y: 20 }]])
  assert.notEqual(start.get('kanban:new'), targets.get('kanban:new'), 'copies, not the same object')
})

test('glideAll: moves only the nodes that have a target, keeps the rest of each node, and reports when everything is there', () => {
  const nodes = new Map([
    ['kanban:a', { x: 0, y: 0, name: 'A' }], ['kanban:b', { x: 100, y: 100, name: 'B' }], ['s::1', { x: 5, y: 5, name: 'session' }],
  ])
  const targets = new Map([['kanban:a', { x: 200, y: 0 }], ['kanban:b', { x: 100, y: 100 }]])
  const r = glideAll(nodes, targets, 100)
  assert.equal(r.settled, false)
  assert.ok(r.nodes.get('kanban:a')!.x > 0 && r.nodes.get('kanban:a')!.x < 200)
  assert.equal(r.nodes.get('kanban:a')!.name, 'A')
  assert.equal(r.nodes.get('kanban:b'), nodes.get('kanban:b'), 'a node that is there is not copied')
  assert.equal(r.nodes.get('s::1'), nodes.get('s::1'), 'a node without a target is left alone')
  assert.equal(nodes.get('kanban:a')!.x, 0, 'the input is not changed')
  let cur: ReadonlyMap<string, { x: number; y: number; name: string }> = nodes
  let settled = false
  for (let i = 0; i < 600 && !settled; i++) { const s = glideAll(cur, targets, 16); cur = s.nodes; settled = s.settled }
  assert.ok(settled)
  assert.deepEqual([cur.get('kanban:a')!.x, cur.get('kanban:a')!.y], [200, 0])
  const again = glideAll(cur, targets, 16)
  assert.equal(again.nodes, cur, 'nothing to do: the same map back')
  assert.equal(again.settled, true)
})

test('glideAll: a held node (dragged by the user) is not moved and does not keep the loop alive; a missing node is skipped', () => {
  const nodes = new Map([['kanban:a', { x: 0, y: 0 }]])
  const targets = new Map([['kanban:a', { x: 200, y: 0 }], ['kanban:ghost', { x: 1, y: 1 }]])
  const r = glideAll(nodes, targets, 100, new Map([['kanban:a', { x: 0, y: 0 }]]))
  assert.equal(r.nodes, nodes)
  assert.equal(r.settled, true)
})
