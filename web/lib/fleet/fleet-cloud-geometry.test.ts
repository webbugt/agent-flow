import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { cloudGeometry, HALO_PAD, type CloudView } from './fleet-cloud-geometry'

const cloud = (members: CloudView['members']): CloudView => ({ id: 'cloud:x', label: 'x', color: '#fff', status: 'active', members })

test('cloudGeometry: one node: the halo is its pad plus HALO_PAD around it', () => {
  const g = cloudGeometry(cloud([{ id: 'a', pad: 70 }]), new Map([['a', { x: 10, y: 20 }]]))!
  assert.deepEqual({ x: g.x, y: g.y }, { x: 10, y: 20 })
  assert.equal(g.r, 70 + HALO_PAD)
})

test('cloudGeometry: centre is the mean of the members, radius reaches the farthest member plus its pad plus HALO_PAD', () => {
  const pos = new Map([['a', { x: 0, y: 0 }], ['b', { x: 200, y: 0 }]])
  const g = cloudGeometry(cloud([{ id: 'a', pad: 50 }, { id: 'b', pad: 80 }]), pos)!
  assert.equal(g.x, 100)
  assert.equal(g.r, 100 + 80 + HALO_PAD)
  assert.equal(cloudGeometry(cloud([{ id: 'gone', pad: 50 }]), pos), null)
})

test('HALO_PAD is a snug margin (the halo hugs the outermost node), not a wide aura', () => {
  assert.ok(HALO_PAD > 0 && HALO_PAD <= 16, `HALO_PAD=${HALO_PAD}`)
})
