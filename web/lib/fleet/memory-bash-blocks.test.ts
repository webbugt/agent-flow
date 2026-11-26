import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { BashUseTracker, bashBlockId, bashCommandOf, buildBashBlocks, type BashEventLike, type BashHeadNode } from './bash-blocks'
import {
  buildMemoryBlocks, filterPersonalNamespaces, isMemoryTagVisible, isPersonalTag, memoryBlockId, memoryBlockInfo, memoryCountsLine,
  MEMORY_OWNER_ENV,
} from './memory-blocks'
import { buildFleetGraph } from './fleet-graph'
import { inspectResource } from './fleet-inspect'
import { handleFleetRequest } from './fleet-api'
import { instancesFromSessionEvents, type SessionEventLike, type SessionLike } from './fleet-model'
import { defaultOptions, type AgentFlowOptions } from './options-registry'
import { setPinned } from './resource-block'
import type { SupermemoryNamespaceNode } from './supermemory-source'

const S = 1000
const T0 = Date.UTC(2026, 10, 26, 12, 0, 0)
const NOW = T0
const all = { isSelected: () => true }

const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const SECRET_CMD = `curl -H "Authorization: Bearer abc123def456ghi789" --password hunter2 https://alice:p4ssw0rd@x.test/api ${GH}`
const SECRETS = ['abc123def456ghi789', 'hunter2', 'p4ssw0rd', GH]

const live = (profile: string, label: string): SessionLike => ({ id: `hermes-${profile}`, label, status: 'active', startTime: T0 - 3600 * S, lastActivityTime: T0 })
const spawn = (name: string): SessionEventLike => ({ time: 0, type: 'agent_spawn', payload: { name, parent: 'x', startedAt: T0 - 3600 * S } })
const instances = () => instancesFromSessionEvents([live('taxis', 'Taxis')], () => [spawn('Taxis · Plan')])

const bashEvent = (command: string, agoSec: number, extra: Record<string, unknown> = {}): BashEventLike => ({
  time: 0, type: 'tool_call_start', payload: { agent: 'Taxis · Plan', tool: 'Bash', args: command.slice(0, 80), inputData: { command }, at: T0 - agoSec * S, ...extra },
})
const session = { id: 'hermes-taxis', label: 'Taxis' }

function trackerOf(events: BashEventLike[], now = NOW): BashHeadNode[] {
  return new BashUseTracker().update([session], () => events, now)
}

// ─── memory blocks ──────────────────────────────────────────────────────────

const space = (tag: string, lastAgoSec: number | null, byProfile: Record<string, number> = { taxis: 3 }): SupermemoryNamespaceNode => {
  const counts = { store: 1, search: 2, forget: 0 }
  return {
    id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag, counts, total: 3,
    byProfile: Object.fromEntries(Object.keys(byProfile).map(p => [p, counts])), daily: [],
    lastEventAt: lastAgoSec === null ? null : T0 - lastAgoSec * S,
    lastByProfile: Object.fromEntries(Object.keys(byProfile).map(p => [p, T0 - (lastAgoSec ?? 0) * S])),
    recent: lastAgoSec === null ? [] : [{ at: T0 - lastAgoSec * S, profile: 'taxis', action: 'search' }],
  } as SupermemoryNamespaceNode
}

test('memory: one block per namespace with an event, keyed by container tag; no events, no block', () => {
  const blocks = buildMemoryBlocks([space('omh_family', 20), space('quiet', null)])
  assert.deepEqual([...blocks.keys()], [memoryBlockId('omh_family')])
  const b = blocks.get('memory:omh_family')!
  assert.equal(b.kind, 'memory')
  assert.equal(b.label, 'omh_family')
  assert.equal(b.lastUsedAt, T0 - 20 * S)
  assert.equal(b.useCount, 3)
  assert.deepEqual(b.agents, ['taxis'])
  assert.equal(buildMemoryBlocks(undefined).size, 0)
})

test('memory: the block info and the counts line carry the tag and counts, nothing else', () => {
  const info = memoryBlockInfo(space('omh_family', 5))
  assert.deepEqual(info, { containerTag: 'omh_family', store: 1, search: 2, forget: 0 })
  assert.equal(memoryCountsLine(info), '1 store · 2 search')
  assert.equal(memoryCountsLine({ containerTag: 'x', store: 0, search: 0, forget: 0 }), 'no calls')
})

test('memory graph node: shown within the memory linger, fades, hides; pin keeps; switched off hides', () => {
  const o = defaultOptions()
  const g = (agoSec: number, options: AgentFlowOptions = o, pins?: ReadonlySet<string>) =>
    buildFleetGraph({ instances: instances(), supermemory: [space('omh_family', agoSec)], selection: all, now: NOW, options, pins })
  const memLinger = o.lingerSeconds.memory
  const memNodes = (graph: ReturnType<typeof g>) => graph.nodes.filter(n => n.kind === 'supermemory')
  assert.equal(memNodes(g(5)).length, 1)
  assert.deepEqual(memNodes(g(5))[0].life, { lastUsedAt: T0 - 5 * S, lingerMs: memLinger * S, fadeMs: o.fadeSeconds * S, pinned: false })
  assert.equal(memNodes(g(memLinger + o.fadeSeconds + 5)).length, 0, 'past linger + fade the block is gone')
  const pinned = setPinned(new Set<string>(), memoryBlockId('omh_family'), true)
  assert.equal(memNodes(g(memLinger + o.fadeSeconds + 5, o, pinned)).length, 1, 'a pin keeps it')
  const off = { ...o, show: { ...o.show, fleet: { ...o.show.fleet, memory: false } } }
  assert.equal(memNodes(g(5, off)).length, 0)
  assert.ok(g(5, off).edges.every(e => e.kind !== 'memory'), 'no link for a switched-off kind')
})

// ─── personal-* containers ──────────────────────────────────────────────────

test('personal tags: recognised whatever the case or separator; other tags are not personal', () => {
  for (const t of ['personal-webbugt', 'personal_webbugt', 'PERSONAL-X', ' personal-y ']) assert.equal(isPersonalTag(t), true, t)
  for (const t of ['omh_family', 'matrix_org', 'my-personal-notes', 'webbugt_video_memory']) assert.equal(isPersonalTag(t), false, t)
})

test('personal tags: every separator form is personal (hyphen, underscore, dot, colon), and so is any name starting with personal', () => {
  assert.equal(isPersonalTag('personal-idv'), true, 'hyphen')
  assert.equal(isPersonalTag('personal_idv'), true, 'underscore')
  assert.equal(isPersonalTag('personal.idv'), true, 'dot')
  assert.equal(isPersonalTag('personal:idv'), true, 'colon')
  assert.equal(isPersonalTag('Personal.IDV'), true, 'dot, upper case')
  assert.equal(isPersonalTag(' personal:idv '), true, 'colon, padded')
  assert.equal(isPersonalTag('personalities'), true, 'starts with personal: hidden (fail closed)')
})

test('personal tags: personal.idv and personal:idv are hidden from a non-owner, no owner and another owner (client and server filter)', () => {
  for (const t of ['personal.idv', 'personal:idv', 'personal-idv', 'personal_idv']) {
    assert.equal(isMemoryTagVisible(t, undefined), false, `${t}: no owner`)
    assert.equal(isMemoryTagVisible(t, 'sophia'), false, `${t}: another owner`)
  }
  assert.equal(isMemoryTagVisible('personal-idv', 'idv'), true, 'owner behaviour unchanged: personal-<owner>')
  assert.equal(isMemoryTagVisible('personal_idv', 'idv'), true, 'owner behaviour unchanged: personal_<owner>')
  const nodes = [space('omh_family', 1), space('personal.idv', 1), space('personal:idv', 1), space('personal-idv', 1)]
  assert.deepEqual(filterPersonalNamespaces(nodes, 'sophia').map(n => n.containerTag), ['omh_family'])
  assert.deepEqual(filterPersonalNamespaces(nodes).map(n => n.containerTag), ['omh_family'])
})

test('personal tags: /api/fleet drops personal.idv and personal:idv from the wire (and from the owner: only personal-<owner> / personal_<owner> are owner-visible)', async () => {
  const spaces = [space('omh_family', 1), space('personal.idv', 1, { taxis: 7 }), space('personal:idv', 1, { taxis: 8 })]
  const call = async (env: Record<string, string>) => handleFleetRequest(new Request('http://localhost/api/fleet', { headers: { host: '127.0.0.1:3000' } }), {
    readKanban: () => ({ nodes: [] }), readSupermemory: () => ({ nodes: spaces }), now: () => 1, env,
  }).text()
  for (const env of [{}, { [MEMORY_OWNER_ENV]: 'sophia' }, { [MEMORY_OWNER_ENV]: 'idv' }] as Array<Record<string, string>>) {
    const body = await call(env)
    assert.ok(!body.includes('personal'), `no personal tag on the wire (env ${JSON.stringify(env)})`)
    assert.ok(body.includes('omh_family'))
  }
})

test('personal tags: visible only to the configured owner; nobody without an owner', () => {
  assert.equal(isMemoryTagVisible('omh_family', undefined), true)
  assert.equal(isMemoryTagVisible('personal-webbugt', undefined), false)
  assert.equal(isMemoryTagVisible('personal-webbugt', ''), false)
  assert.equal(isMemoryTagVisible('personal-webbugt', '  '), false)
  assert.equal(isMemoryTagVisible('personal-webbugt', 'webbugt'), true)
  assert.equal(isMemoryTagVisible('personal_WebBugt', 'webbugt'), true, 'case and - / _ do not matter')
  assert.equal(isMemoryTagVisible('personal-sophia', 'webbugt'), false, 'another person is not the owner')
  assert.equal(isMemoryTagVisible('personal-webbugt-extra', 'webbugt'), false, 'prefix match is not enough')
  assert.equal(isMemoryTagVisible(undefined as unknown as string, 'webbugt'), false, 'a node without a tag fails closed')
})

test('personal tags: the filter drops the whole node and keeps the order of the rest', () => {
  const nodes = [space('omh_family', 1), space('personal-webbugt', 1), space('matrix_org', 1)]
  assert.deepEqual(filterPersonalNamespaces(nodes).map(n => n.containerTag), ['omh_family', 'matrix_org'])
  assert.deepEqual(filterPersonalNamespaces(nodes, 'webbugt').map(n => n.containerTag), ['omh_family', 'personal-webbugt', 'matrix_org'])
  assert.equal(nodes.length, 3, 'the input is not changed')
})

test('personal tags: /api/fleet drops them on the server, so the wire never carries the tag or its counts', async () => {
  const spaces = [space('omh_family', 1), space('personal-webbugt', 1, { taxis: 9 })]
  const call = async (env: Record<string, string>) => {
    const res = handleFleetRequest(new Request('http://localhost/api/fleet', { headers: { host: '127.0.0.1:3000' } }), {
      readKanban: () => ({ nodes: [] }), readSupermemory: () => ({ nodes: spaces }), now: () => 1, env,
    })
    return res.text()
  }
  const hidden = await call({})
  assert.ok(!hidden.includes('personal'), 'no owner: the tag is not on the wire')
  assert.ok(hidden.includes('omh_family'))
  const other = await call({ [MEMORY_OWNER_ENV]: 'sophia' })
  assert.ok(!other.includes('personal-webbugt'), 'another owner: not on the wire')
  const owner = await call({ [MEMORY_OWNER_ENV]: 'webbugt' })
  assert.ok(owner.includes('personal-webbugt'), 'the owner sees it')
})

test('memory content: a block, a graph node and an inspection hold no query, id or result (fields that do not exist)', () => {
  const sp = space('omh_family', 5)
  ;(sp as unknown as Record<string, unknown>).secretQuery = 'SECRET QUERY'
  const g = buildFleetGraph({ instances: instances(), supermemory: [sp], selection: all, now: NOW, options: defaultOptions() })
  const node = g.nodes.find(n => n.kind === 'supermemory')!
  const derived = JSON.stringify({ node, blocks: [...buildMemoryBlocks([sp])], info: memoryBlockInfo(sp), insp: inspectResource(node.id, undefined, [sp]) })
  assert.ok(!derived.includes('SECRET QUERY'))
})

// ─── bash: head only on the block, masked full command on inspect ───────────

test('bash command text: the full command when there is one, else the args; none for an empty call', () => {
  assert.equal(bashCommandOf({ args: 'ls', inputData: { command: 'ls -la /tmp' } }), 'ls -la /tmp')
  assert.equal(bashCommandOf({ args: 'ls -l' }), 'ls -l')
  assert.equal(bashCommandOf({ args: '  ', inputData: { command: '' } }), null)
  assert.equal(bashCommandOf({ inputData: ['x'] }), null)
})

test('bash tracker: one head node per program, counted per profile; newest first', () => {
  const nodes = trackerOf([bashEvent('git status', 50), bashEvent('git diff', 20), bashEvent('pnpm test', 10)])
  assert.deepEqual(nodes.map(n => n.head), ['pnpm', 'git'])
  const git = nodes.find(n => n.head === 'git')!
  assert.equal(git.id, bashBlockId('git'))
  assert.equal(git.id, 'bash:git')
  assert.equal(git.total, 2)
  assert.deepEqual(git.recent.map(r => r.command), ['git diff', 'git status'])
  assert.deepEqual(Object.keys(git.byProfile), ['taxis'])
  assert.equal(git.lastUsedAt, T0 - 20 * S)
})

test('bash tracker: the stored command is masked; the raw secret exists nowhere in the node', () => {
  const [node] = trackerOf([bashEvent(SECRET_CMD, 5)])
  assert.equal(node.head, 'curl')
  const wire = JSON.stringify(node)
  for (const s of SECRETS) assert.ok(!wire.includes(s), `node must not contain ${s}`)
  assert.match(node.recent[0].command, /Authorization: Bearer \[MASKED\]/)
  assert.match(node.recent[0].command, /--password \[MASKED\]/)
  assert.match(node.recent[0].command, /https:\/\/alice:\[MASKED\]@x\.test\/api/)
  assert.ok(node.recent[0].command.startsWith('curl -H'), 'the rest of the command stays readable')
})

test('bash tracker: a secret in the args-only (80 character) form is masked too', () => {
  const [node] = trackerOf([{ time: 0, type: 'tool_call_start', payload: { agent: 'Taxis · Plan', tool: 'Bash', args: `export TOKEN=${GH} && git push`, at: T0 - 5 * S } }])
  assert.ok(!JSON.stringify(node).includes(GH))
  assert.equal(node.head, 'git')
})

test('bash tracker: the same call reported twice (hook, then transcript) counts once; the longer text wins', () => {
  const long = 'git log --oneline --decorate --graph --all --since="2 weeks ago" --author=someone --format=%h'
  const nodes = trackerOf([bashEvent(long.slice(0, 40), 9, { toolUseId: 'tu1' }), bashEvent(long, 9, { toolUseId: 'tu1' })])
  assert.equal(nodes[0].total, 1)
  assert.equal(nodes[0].recent[0].command, long)
})

test('bash tracker: incremental, and a reset buffer starts over; no double counting on repeated polls', () => {
  const t = new BashUseTracker()
  const events = [bashEvent('git status', 30)]
  assert.equal(t.update([session], () => events, NOW)[0].total, 1)
  assert.equal(t.update([session], () => events, NOW)[0].total, 1, 'same buffer, same count')
  events.push(bashEvent('git diff', 10))
  assert.equal(t.update([session], () => events, NOW)[0].total, 2, 'only the new event is read')
  const same = t.update([session], () => events, NOW)
  assert.equal(t.update([session], () => events, NOW), same, 'the same array while nothing changed')
  assert.equal(t.update([session], () => [bashEvent('ls', 5)], NOW)[0].head, 'ls', 'a shorter buffer is a reset')
  assert.deepEqual(t.update([], () => [], NOW), [], 'a session that is gone takes its uses along')
})

test('bash tracker: time comes from payload.at, else the spawn time base plus event time, else now for live events; old history is skipped', () => {
  const based: BashEventLike[] = [spawn('Taxis · Plan'), { time: 3590, type: 'tool_call_start', payload: { agent: 'Taxis · Plan', tool: 'Bash', args: 'ls' } }]
  assert.equal(trackerOf(based)[0].lastUsedAt, T0 - 3600 * S + 3590 * S)
  const liveNoTime: BashEventLike[] = [{ time: 0, type: 'tool_call_start', payload: { agent: 'Nobody', tool: 'Bash', args: 'ls' } }]
  assert.equal(trackerOf(liveNoTime)[0].lastUsedAt, NOW)
  const history: BashEventLike[] = [{ time: 0, type: 'tool_call_start', history: true, payload: { agent: 'Nobody', tool: 'Bash', args: 'ls' } }]
  assert.deepEqual(trackerOf(history), [])
  assert.deepEqual(trackerOf([bashEvent('ls', 24 * 3600)]), [], 'older than any linger + fade')
})

test('bash tracker: only Bash calls count; other tools and empty commands do not', () => {
  const nodes = trackerOf([
    { time: 0, type: 'tool_call_start', payload: { agent: 'Taxis · Plan', tool: 'Read', args: 'x', at: T0 - S } },
    { time: 0, type: 'tool_call_end', payload: { agent: 'Taxis · Plan', tool: 'Bash', args: 'ls', at: T0 - S } },
    bashEvent('', 2),
    bashEvent('git status', 3),
  ])
  assert.deepEqual(nodes.map(n => n.head), ['git'])
})

test('bash tracker: a command with no plain program name is the head "command" and never the quoted text', () => {
  const [node] = trackerOf([bashEvent('"top secret program name" arg', 5)])
  assert.equal(node.head, 'command')
  assert.ok(!node.id.includes('secret'))
})

test('bash blocks: one per head; lastUsedAt and counts only from profiles whose cloud is shown', () => {
  const nodes: BashHeadNode[] = [{
    id: 'bash:git', type: 'bash-head', head: 'git', total: 5, lastUsedAt: T0 - S,
    byProfile: { taxis: { count: 3, lastUsedAt: T0 - 10 * S }, sophia: { count: 2, lastUsedAt: T0 - S } }, recent: [],
  }]
  const b = buildBashBlocks(nodes, p => p === 'taxis').get('bash:git')!
  assert.equal(b.kind, 'bash')
  assert.equal(b.useCount, 3)
  assert.equal(b.lastUsedAt, T0 - 10 * S)
  assert.deepEqual(b.agents, ['taxis'])
  assert.equal(buildBashBlocks(nodes, () => false).size, 0)
  assert.equal(buildBashBlocks(undefined).size, 0)
})

test('bash graph: the visual carries the head and a call count; a link to the cloud; life follows the bash linger', () => {
  const o = defaultOptions()
  const nodes = trackerOf([bashEvent(SECRET_CMD, 5), bashEvent('git status', 8)])
  const g = buildFleetGraph({ instances: instances(), bash: nodes, selection: all, now: NOW, options: o })
  const bn = g.nodes.filter(n => n.kind === 'bash')
  assert.deepEqual(bn.map(n => n.label).sort(), ['curl', 'git'])
  const curl = bn.find(n => n.label === 'curl')!
  assert.equal(curl.sublabel, '1 call')
  assert.equal(curl.life!.lingerMs, o.lingerSeconds.bash * S)
  assert.ok(g.edges.some(e => e.to === 'bash:curl' && e.kind === 'bash'))
  // Binding decision 3: nothing the map draws (node, label, sublabel, edge) holds the command text or a secret.
  const drawn = JSON.stringify({ nodes: bn, edges: g.edges.filter(e => e.kind === 'bash') })
  for (const s of SECRETS) assert.ok(!drawn.includes(s), `drawn data must not contain ${s}`)
  assert.ok(!drawn.includes('Authorization'), 'not even the masked command is part of the visual')
  assert.ok(!drawn.includes('git status'))
})

test('bash graph: fades and hides past linger + fade, a pin keeps it, switched off hides it and its link', () => {
  const o = defaultOptions()
  const linger = o.lingerSeconds.bash
  const g = (agoSec: number, options = o, pins?: ReadonlySet<string>) =>
    buildFleetGraph({ instances: instances(), bash: trackerOf([bashEvent('git status', agoSec)]), selection: all, now: NOW, options, pins })
  assert.equal(g(5).nodes.filter(n => n.kind === 'bash').length, 1)
  assert.equal(g(linger + o.fadeSeconds + 5).nodes.filter(n => n.kind === 'bash').length, 0)
  const pinned = setPinned(new Set<string>(), bashBlockId('git'), true)
  assert.equal(g(linger + o.fadeSeconds + 5, o, pinned).nodes.filter(n => n.kind === 'bash').length, 1)
  const off = { ...o, show: { ...o.show, fleet: { ...o.show.fleet, bash: false } } }
  const goff = g(5, off)
  assert.equal(goff.nodes.filter(n => n.kind === 'bash').length, 0)
  assert.ok(goff.edges.every(e => e.kind !== 'bash'))
})

test('bash graph: a profile whose cloud is not on the map gets no block', () => {
  const stranger = new BashUseTracker().update([{ id: 'hermes-other', label: 'Someone Else' }], () => [bashEvent('git status', 5)], NOW)
  const g = buildFleetGraph({ instances: instances(), bash: stranger, selection: all, now: NOW, options: defaultOptions() })
  assert.equal(g.nodes.filter(n => n.kind === 'bash').length, 0)
})

test('bash inspect: the full command is shown, already masked, newest first; counts line, pin id', () => {
  const nodes = trackerOf([bashEvent('git status', 30), bashEvent(SECRET_CMD, 5)])
  const insp = inspectResource('bash:curl', undefined, undefined, undefined, nodes)!
  assert.equal(insp.kind, 'bash')
  assert.equal(insp.title, 'curl')
  assert.equal(insp.pinId, 'bash:curl')
  assert.equal(insp.summary, '1 call · 1 profile')
  assert.equal(insp.items.length, 1)
  assert.equal(insp.items[0].action, 'run')
  assert.match(insp.items[0].detail!, /^curl -H "Authorization: Bearer \[MASKED\]"/, 'the full command, with the secrets masked')
  for (const s of SECRETS) assert.ok(!JSON.stringify(insp).includes(s), `inspection must not contain ${s}`)
  const git = inspectResource('bash:git', undefined, undefined, undefined, nodes)!
  assert.equal(git.items[0].detail, 'git status')
  assert.equal(inspectResource('bash:nothing', undefined, undefined, undefined, nodes), null)
})

test('bash inspect: more than the list limit reports how many are not shown', () => {
  const events = Array.from({ length: 12 }, (_, i) => bashEvent(`git log -${i + 1}`, 100 - i))
  const insp = inspectResource('bash:git', undefined, undefined, 5, trackerOf(events))!
  assert.equal(insp.total, 12)
  assert.equal(insp.items.length, 5)
  assert.equal(insp.more, 7)
})

test('bash tracker: the stored command is capped', () => {
  const [node] = trackerOf([bashEvent(`echo ${'x'.repeat(10_000)}`, 5)])
  assert.ok(node.recent[0].command.length <= 4001)
  assert.ok(node.recent[0].command.endsWith('…'))
})
