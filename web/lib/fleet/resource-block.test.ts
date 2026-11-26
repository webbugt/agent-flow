import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { defaultOptions, applyOptionsPatch, type AgentFlowOptions } from './options-registry'
import {
  MAX_BLOCK_AGENTS, blockAlpha, blockId, isBlockShown, pruneBlocks, recordUse, resolveLife, setPinned, togglePin,
  visibleBlocks, visibleMs, type BlockStore, type ResourceBlock,
} from './resource-block'

const T = Date.UTC(2026, 10, 26, 12, 0, 0)
const empty: BlockStore = new Map()
const opts = defaultOptions()
const mk = (kind: ResourceBlock['kind'], at = T): ResourceBlock => ({ kind, key: 'k', label: 'k', lastUsedAt: at, useCount: 1, agents: [] })

function withOptions(patch: Parameters<typeof applyOptionsPatch>[1]): AgentFlowOptions {
  const r = applyOptionsPatch(defaultOptions(), patch)
  assert.ok(r.ok)
  return r.ok ? r.options : defaultOptions()
}

test('recordUse creates a block, counts uses, keeps the newest time and distinct agents', () => {
  let s = recordUse(empty, { kind: 'kanban', key: 'agent-flow', at: T, agentId: 'a1' })
  s = recordUse(s, { kind: 'kanban', key: 'agent-flow', at: T + 5_000, agentId: 'a2' })
  s = recordUse(s, { kind: 'kanban', key: 'agent-flow', at: T + 1_000, agentId: 'a1' }) // late, older event
  const b = s.get(blockId('kanban', 'agent-flow'))!
  assert.equal(b.useCount, 3)
  assert.equal(b.lastUsedAt, T + 5_000)
  assert.deepEqual(b.agents, ['a1', 'a2'])
  assert.equal(b.label, 'agent-flow')
  assert.equal(s.size, 1)
})

test('recordUse is immutable and ignores bad uses', () => {
  const s1 = recordUse(empty, { kind: 'bash', key: 'git', at: T })
  assert.equal(empty.size, 0)
  assert.equal(recordUse(s1, { kind: 'files' as never, key: 'x', at: T }), s1)
  assert.equal(recordUse(s1, { kind: 'bash', key: '   ', at: T }), s1)
  assert.equal(recordUse(s1, { kind: 'bash', key: 'git', at: NaN }), s1)
  assert.equal(recordUse(s1, { kind: 'bash', key: 'git', at: Infinity }), s1)
  assert.equal(s1.get('bash:git')!.useCount, 1)
})

test('the same key under two kinds is two blocks; label can be set and is kept', () => {
  let s = recordUse(empty, { kind: 'memory', key: 'cron', label: 'cron mem', at: T })
  s = recordUse(s, { kind: 'subsystem', key: 'cron', at: T })
  s = recordUse(s, { kind: 'memory', key: 'cron', at: T + 1 })
  assert.equal(s.size, 2)
  assert.equal(s.get('memory:cron')!.label, 'cron mem')
  assert.equal(s.get('subsystem:cron')!.label, 'cron')
})

test('agents list is capped', () => {
  let s: BlockStore = empty
  for (let i = 0; i < MAX_BLOCK_AGENTS + 20; i++) s = recordUse(s, { kind: 'subsystem', key: 'gateway', at: T, agentId: `a${i}` })
  const b = s.get('subsystem:gateway')!
  assert.equal(b.agents.length, MAX_BLOCK_AGENTS)
  assert.equal(b.useCount, MAX_BLOCK_AGENTS + 20)
})

test('resolveLife reads seconds per kind from the options as ms', () => {
  assert.deepEqual(resolveLife('kanban', opts), { lingerMs: 90_000, fadeMs: 15_000 })
  assert.deepEqual(resolveLife('memory', opts), { lingerMs: 60_000, fadeMs: 15_000 })
  assert.deepEqual(resolveLife('bash', opts), { lingerMs: 20_000, fadeMs: 15_000 })
  assert.deepEqual(resolveLife('subsystem', opts), { lingerMs: 45_000, fadeMs: 15_000 })
  assert.equal(visibleMs(resolveLife('bash', opts)), 35_000)
  assert.equal(visibleMs({ lingerMs: 0, fadeMs: 15_000 }), 0)
})

test('fade math per kind with the default windows', () => {
  const cases: Array<[ResourceBlock['kind'], number]> = [['kanban', 90], ['memory', 60], ['bash', 20], ['subsystem', 45]]
  for (const [kind, linger] of cases) {
    const b = mk(kind)
    const L = linger * 1000
    assert.equal(blockAlpha(b, T, opts), 1, `${kind} at use`)
    assert.equal(blockAlpha(b, T + L - 1, opts), 1, `${kind} just inside linger`)
    assert.equal(blockAlpha(b, T + L, opts), 1, `${kind} at the end of linger`)
    assert.ok(Math.abs(blockAlpha(b, T + L + 7_500, opts) - 0.5) < 1e-9, `${kind} half way through the fade`)
    assert.ok(Math.abs(blockAlpha(b, T + L + 3_750, opts) - 0.75) < 1e-9, `${kind} a quarter into the fade`)
    assert.equal(blockAlpha(b, T + L + 15_000, opts), 0, `${kind} fade over`)
    assert.equal(blockAlpha(b, T + L + 60_000, opts), 0, `${kind} long after`)
  }
})

test('kanban matches the old edge rule exactly', async () => {
  const { edgeAlpha } = await import('./fleet-edge-life')
  for (const dt of [0, 45_000, 90_000, 91_500, 97_500, 104_999, 105_000, 500_000]) {
    assert.equal(blockAlpha(mk('kanban'), T + dt, opts), edgeAlpha(T, T + dt), `age ${dt}`)
  }
})

test('custom linger and fade apply per kind', () => {
  const o = withOptions({ lingerSeconds: { bash: 10, memory: 120 }, fadeSeconds: 4 })
  assert.equal(blockAlpha(mk('bash'), T + 10_000, o), 1)
  assert.ok(Math.abs(blockAlpha(mk('bash'), T + 12_000, o) - 0.5) < 1e-9)
  assert.equal(blockAlpha(mk('bash'), T + 14_000, o), 0)
  assert.equal(blockAlpha(mk('memory'), T + 120_000, o), 1)
  assert.equal(blockAlpha(mk('kanban'), T + 90_000, o), 1, 'untouched kind keeps its default')
  assert.equal(blockAlpha(mk('kanban'), T + 94_000, o), 0, 'fade is the new 4 s')
})

test('linger 0 hides immediately: at the moment of use, and with a fade configured', () => {
  const o = withOptions({ lingerSeconds: { bash: 0 } })
  assert.equal(o.fadeSeconds, 15)
  assert.equal(blockAlpha(mk('bash'), T, o), 0)
  assert.equal(blockAlpha(mk('bash'), T + 1, o), 0)
  assert.equal(blockAlpha(mk('bash'), T + 5_000, o), 0)
  assert.equal(isBlockShown(mk('bash'), T, 'fleet', o), false)
  assert.equal(blockAlpha(mk('kanban'), T, o), 1, 'other kinds are unaffected')
  assert.deepEqual(visibleBlocks(recordUse(empty, { kind: 'bash', key: 'git', at: T }), T, 'fleet', o), [])
})

test('fade 0 is a hard cut after linger', () => {
  const o = withOptions({ fadeSeconds: 0 })
  assert.equal(blockAlpha(mk('bash'), T + 20_000, o), 1)
  assert.equal(blockAlpha(mk('bash'), T + 20_001, o), 0)
})

test('pin keeps a block fully visible, and beats linger 0; unpin returns to the rule', () => {
  const o = withOptions({ lingerSeconds: { bash: 0 } })
  const b = mk('bash')
  const id = blockId('bash', 'k')
  const pins = togglePin(new Set(), id)
  assert.equal(blockAlpha(b, T + 3_600_000, o, true), 1)
  assert.equal(isBlockShown(b, T + 3_600_000, 'fleet', o, pins), true)
  assert.equal(isBlockShown(b, T + 3_600_000, 'fleet', o, togglePin(pins, id)), false)
  assert.equal(blockAlpha(mk('memory'), T + 3_600_000, opts, true), 1)
  assert.equal(blockAlpha(mk('memory'), T + 3_600_000, opts, false), 0)
})

test('pin helpers do not mutate their input', () => {
  const p0 = new Set<string>()
  const p1 = togglePin(p0, 'a')
  assert.equal(p0.size, 0)
  assert.equal(p1.has('a'), true)
  assert.equal(setPinned(p1, 'a', true), p1)
  assert.equal(setPinned(p1, 'a', false).has('a'), false)
  assert.equal(p1.has('a'), true)
})

test('a kind switched off hides its blocks (even pinned) in that view only', () => {
  const o = withOptions({ show: { fleet: { memory: false } } })
  const b = mk('memory')
  const pins = new Set([blockId('memory', 'k')])
  assert.equal(isBlockShown(b, T, 'fleet', o), false)
  assert.equal(isBlockShown(b, T, 'fleet', o, pins), false)
  assert.equal(isBlockShown(b, T, 'single', o), true)
})

test('visibleBlocks returns alpha and pin state, oldest use first', () => {
  let s: BlockStore = empty
  s = recordUse(s, { kind: 'kanban', key: 'b', at: T })
  s = recordUse(s, { kind: 'bash', key: 'git', at: T - 30_000 }) // 30 s old: bash linger 20 + fade 15 -> alpha 1 - 10/15
  s = recordUse(s, { kind: 'bash', key: 'pnpm', at: T - 60_000 }) // over
  s = recordUse(s, { kind: 'memory', key: 'omh_family', at: T - 10_000 })
  const v = visibleBlocks(s, T, 'fleet', opts, new Set(['bash:pnpm']))
  assert.deepEqual(v.map(x => x.id), ['bash:pnpm', 'bash:git', 'memory:omh_family', 'kanban:b'])
  assert.equal(v[0].pinned, true)
  assert.equal(v[0].alpha, 1)
  assert.ok(Math.abs(v[1].alpha - (1 - 10 / 15)) < 1e-9)
  assert.equal(v[2].alpha, 1)
})

test('pruneBlocks drops finished unpinned blocks, keeps live and pinned, and returns the same store when nothing goes', () => {
  let s: BlockStore = empty
  s = recordUse(s, { kind: 'bash', key: 'old', at: T - 60_000 })
  s = recordUse(s, { kind: 'bash', key: 'pinned-old', at: T - 60_000 })
  s = recordUse(s, { kind: 'bash', key: 'live', at: T - 1_000 })
  const out = pruneBlocks(s, T, opts, new Set(['bash:pinned-old']))
  assert.deepEqual([...out.keys()].sort(), ['bash:live', 'bash:pinned-old'])
  assert.equal(s.size, 3, 'input untouched')
  assert.equal(pruneBlocks(out, T, opts, new Set(['bash:pinned-old'])), out)
})

test('the model carries no content fields', () => {
  const s = recordUse(empty, { kind: 'bash', key: 'git', at: T, agentId: 'a' })
  assert.deepEqual(Object.keys(s.get('bash:git')!).sort(), ['agents', 'key', 'kind', 'label', 'lastUsedAt', 'useCount'])
})
