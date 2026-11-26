import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildKanbanBlocks, isKanbanBoardShown, kanbanBlockId, kanbanBlockInfo, kanbanCountsLine, kanbanLifeView,
} from './kanban-blocks'
import { buildFleetGraph } from './fleet-graph'
import { instancesFromSessionEvents, type SessionEventLike, type SessionLike } from './fleet-model'
import { handleFleetRequest } from './fleet-api'
import { readKanbanFleet, type PublicKanbanBoardNode } from './kanban-source'
import { defaultOptions, type AgentFlowOptions } from './options-registry'
import { blockAlpha, setPinned, type PinSet } from './resource-block'
import { blockViewAlpha } from './block-alpha'

const S = 1000
const T0 = Date.UTC(2026, 10, 26, 12, 0, 0)
const all = { isSelected: () => true }

const board = (slug: string, events: Array<[assignee: string | null, kind: string, agoSec: number]>, counts: Record<string, number> = { running: 1, done: 3 }): PublicKanbanBoardNode => ({
  id: `kanban:${slug}`, type: 'kanban-board', slug, name: `Name of ${slug}`, description: 'a description', archived: false,
  taskCounts: { triage: 0, todo: 0, ready: 0, running: 0, blocked: 0, review: 0, scheduled: 0, done: 0, archived: 0, ...counts },
  totalTasks: Object.values(counts).reduce((a, b) => a + b, 0),
  recentEvents: events.map(([assignee, kind, ago], i) => ({ id: i + 1, taskId: `t_${i}`, taskTitle: `title ${i}`, assignee, kind, runId: null, at: T0 - ago * S })),
  lastEventAt: events.length ? T0 - Math.min(...events.map(e => e[2])) * S : null,
} as PublicKanbanBoardNode)

const withKanbanLinger = (seconds: number, fade = 15): AgentFlowOptions => {
  const o = defaultOptions()
  return { ...o, fadeSeconds: fade, lingerSeconds: { ...o.lingerSeconds, kanban: seconds } }
}

// ─── block per board ────────────────────────────────────────────────────────

test('one block per board, keyed by slug; lastUsedAt is the newest event, agents are the distinct assignees', () => {
  const blocks = buildKanbanBlocks([
    board('alpha', [['taxis', 'claimed', 30], ['omh-coder', 'completed', 5], ['taxis', 'heartbeat', 60], [null, 'created', 90]]),
    board('beta', [['sophia', 'created', 10]]),
    board('idle', []),
  ])
  assert.deepEqual([...blocks.keys()].sort(), [kanbanBlockId('alpha'), kanbanBlockId('beta')], 'a board without events has no block')
  const a = blocks.get('kanban:alpha')!
  assert.equal(a.kind, 'kanban')
  assert.equal(a.key, 'alpha')
  assert.equal(a.label, 'alpha', 'labelled by the slug, not by the board name')
  assert.equal(a.lastUsedAt, T0 - 5 * S)
  assert.equal(a.useCount, 4)
  assert.deepEqual(a.agents, ['taxis', 'omh-coder'], 'distinct assignees, oldest use first; an unassigned event adds none')
})

test('building blocks is idempotent: the same poll twice gives the same blocks (no double counting)', () => {
  const boards = [board('alpha', [['taxis', 'claimed', 30], ['taxis', 'completed', 5]])]
  assert.deepEqual([...buildKanbanBlocks(boards)], [...buildKanbanBlocks(boards)])
  assert.equal(buildKanbanBlocks(boards).get('kanban:alpha')!.useCount, 2)
  assert.equal(buildKanbanBlocks(undefined).size, 0)
})

test('block info holds slug, status counts and event kinds only', () => {
  const b = board('alpha', [['taxis', 'claimed', 1], ['taxis', 'claimed', 2], ['taxis', 'completed', 3]], { done: 7, running: 1, todo: 2, odd: 1 })
  const info = kanbanBlockInfo(b)
  assert.deepEqual(info.counts, [['todo', 2], ['running', 1], ['done', 7], ['odd', 1]], 'known statuses in board order, unknown ones after; zero counts dropped')
  assert.deepEqual(info.kinds, [['claimed', 2], ['completed', 1]])
  assert.deepEqual(Object.keys(info).sort(), ['counts', 'kinds', 'slug'])
  assert.equal(kanbanCountsLine(info), '2 todo · 1 running · 7 done · 1 odd')
  assert.equal(kanbanCountsLine(kanbanBlockInfo(board('empty', [], {}))), 'no tasks')
})

// ─── linger, fade, pin, show ────────────────────────────────────────────────

const NOW = T0
const showCase = (events: Array<[string, string, number]>, options: AgentFlowOptions, pins?: PinSet) => {
  const b = board('alpha', events)
  return isKanbanBoardShown(b, buildKanbanBlocks([b]), NOW, options, pins ?? new Set())
}

test('appears on an event; fully drawn through the kanban linger, fading after it, gone after linger + fade (defaults 90 s + 15 s)', () => {
  const o = defaultOptions()
  assert.equal(showCase([['taxis', 'claimed', 0]], o), true)
  assert.equal(showCase([['taxis', 'claimed', 90]], o), true, 'end of the linger window')
  assert.equal(showCase([['taxis', 'claimed', 104]], o), true, 'fading')
  assert.equal(showCase([['taxis', 'claimed', 105]], o), false, 'linger + fade over')
  assert.equal(showCase([['taxis', 'claimed', 3600]], o), false, 'an old board is not on the map')
  assert.equal(showCase([], o), false, 'no event, no block')
})

test('the opacity of the block follows the kanban linger and fade of the options', () => {
  const b = board('alpha', [['taxis', 'claimed', 100]])
  const block = buildKanbanBlocks([b]).get('kanban:alpha')!
  const o = defaultOptions()
  assert.equal(blockAlpha(block, NOW, o), 1 - 10 / 15, '100 s old: 10 s into a 15 s fade')
  const view = kanbanLifeView(block, o, new Set())
  assert.deepEqual(view, { lastUsedAt: T0 - 100 * S, lingerMs: 90_000, fadeMs: 15_000, pinned: false })
  assert.equal(blockViewAlpha(view, NOW), blockAlpha(block, NOW, o), 'the draw loop and the model agree')
  const longer = withKanbanLinger(300, 30)
  assert.equal(blockAlpha(block, NOW, longer), 1)
  assert.equal(blockViewAlpha(kanbanLifeView(block, longer, new Set()), NOW), 1)
  // Other kinds' linger does not touch it.
  const memoryOnly = { ...o, lingerSeconds: { ...o.lingerSeconds, memory: 3600 } }
  assert.equal(blockAlpha(block, NOW, memoryOnly), 1 - 10 / 15)
})

test('linger 0 hides at once, even a block that was just used', () => {
  assert.equal(showCase([['taxis', 'claimed', 0]], withKanbanLinger(0)), false)
  assert.equal(showCase([['taxis', 'claimed', 0]], withKanbanLinger(0, 0)), false)
})

test('fade 0 is a hard cut at the end of the linger window', () => {
  assert.equal(showCase([['taxis', 'claimed', 90]], withKanbanLinger(90, 0)), true)
  assert.equal(showCase([['taxis', 'claimed', 91]], withKanbanLinger(90, 0)), false)
})

test('a pin keeps the block (beats linger 0 and an expired window); unpinning lets it go; the show toggle still wins', () => {
  const id = kanbanBlockId('alpha')
  const pinned = setPinned(new Set(), id, true)
  assert.equal(showCase([['taxis', 'claimed', 3600]], defaultOptions(), pinned), true, 'pinned past linger + fade')
  assert.equal(showCase([['taxis', 'claimed', 0]], withKanbanLinger(0), pinned), true, 'pinned beats linger 0')
  assert.equal(showCase([['taxis', 'claimed', 3600]], defaultOptions(), setPinned(pinned, id, false)), false, 'unpinned')
  assert.equal(showCase([['taxis', 'claimed', 3600]], defaultOptions(), setPinned(new Set(), 'kanban:other', true)), false, 'another block pinned')
  const hidden = defaultOptions()
  hidden.show.fleet.kanban = false
  assert.equal(showCase([['taxis', 'claimed', 0]], hidden, pinned), false, 'kind switched off for the fleet view hides even a pinned block')
  const singleOff = defaultOptions()
  singleOff.show.single.kanban = false
  assert.equal(showCase([['taxis', 'claimed', 0]], singleOff), true, 'the single-view toggle does not affect the fleet map')
})

// ─── graph ──────────────────────────────────────────────────────────────────

const live = (profile: string, label: string): SessionLike => ({ id: `hermes-${profile}`, label, status: 'active', startTime: T0 - 3600 * S, lastActivityTime: T0 })
const spawn = (name: string): SessionEventLike => ({ time: 0, type: 'agent_spawn', payload: { name, parent: 'x', startedAt: T0 - 3600 * S } })
const instances = () => instancesFromSessionEvents([live('taxis', 'Taxis')], () => [spawn('Taxis · Plan')])

const graphOf = (kanban: PublicKanbanBoardNode[], options: AgentFlowOptions, pins?: PinSet, now = NOW) =>
  buildFleetGraph({ instances: instances(), kanban, selection: all, now, options, pins })

test('graph: a board node appears only for a board with a task event in the window; label is the slug', () => {
  const g = graphOf([board('fresh', [['taxis', 'claimed', 10]]), board('stale', [['taxis', 'claimed', 600]]), board('quiet', [])], defaultOptions())
  assert.deepEqual(g.nodes.filter(n => n.kind === 'kanban').map(n => n.id), ['kanban:fresh'])
  const node = g.nodes.find(n => n.id === 'kanban:fresh')!
  assert.equal(node.label, 'fresh', 'the slug, not "Name of fresh"')
  assert.equal(node.sublabel, '1 running · 3 done')
  assert.deepEqual(node.block, { slug: 'fresh', counts: [['running', 1], ['done', 3]], kinds: [['claimed', 1]] })
  assert.deepEqual(node.life, { lastUsedAt: T0 - 10 * S, lingerMs: 90_000, fadeMs: 15_000, pinned: false })
  assert.ok(g.edges.every(e => g.nodes.some(n => n.id === e.to)), 'no edge to a hidden board')
})

test('graph: a pinned board stays; the pin shows in the node life', () => {
  const stale = board('stale', [['taxis', 'claimed', 600]])
  const g = graphOf([stale], defaultOptions(), new Set(['kanban:stale']))
  assert.deepEqual(g.nodes.filter(n => n.kind === 'kanban').map(n => n.id), ['kanban:stale'])
  assert.equal(g.nodes.find(n => n.id === 'kanban:stale')!.life!.pinned, true)
  assert.equal(g.edges.find(e => e.to === 'kanban:stale')!.life!.lingerMs, 90_000)
})

test('graph: linger comes from the options, per kind; the kanban link follows the same linger and fade', () => {
  const b = board('alpha', [['taxis', 'claimed', 200]])
  assert.equal(graphOf([b], defaultOptions()).nodes.filter(n => n.kind === 'kanban').length, 0, 'default 90 s + 15 s: over')
  const g = graphOf([b], withKanbanLinger(300, 20))
  assert.equal(g.nodes.filter(n => n.kind === 'kanban').length, 1)
  const edge = g.edges.find(e => e.to === 'kanban:alpha')!
  assert.deepEqual(edge.life, { lingerMs: 300_000, fadeMs: 20_000 })
  const off = defaultOptions()
  off.show.fleet.kanban = false
  const gOff = graphOf([board('alpha', [['taxis', 'claimed', 1]])], off)
  assert.equal(gOff.nodes.filter(n => n.kind === 'kanban').length, 0)
  assert.equal(gOff.edges.length, 0, 'no link, and so no pulse, for a switched-off kind')
})

test('graph: a deselected board stays off even when in use; an archived board never shows', () => {
  const g = buildFleetGraph({
    instances: instances(), now: NOW, options: defaultOptions(),
    kanban: [board('a', [['taxis', 'claimed', 1]]), { ...board('b', [['taxis', 'claimed', 1]]), archived: true } as PublicKanbanBoardNode],
    selection: { isSelected: id => id !== 'kanban:a' },
  })
  assert.equal(g.nodes.filter(n => n.kind === 'kanban').length, 0)
})

// ─── privacy: nothing but slug, counts and kinds reaches the client ─────────

const SECRETS = ['SECRET BODY', 'SECRET RESULT', 'SECRET PAYLOAD', 'SECRET COMMENT'] as const
let root: string
let home: string

before(() => {
  root = mkdtempSync(join(tmpdir(), 'kanban-blocks-'))
  home = join(root, 'kanban')
  const dir = join(home, 'boards', 'alpha')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'board.json'), JSON.stringify({ slug: 'alpha', name: 'Alpha Board', description: 'a board', archived: false }))
  const db = new DatabaseSync(join(dir, 'kanban.db'))
  // The real Hermes schema has bodies, results, comments and event payloads; fill every one with a marker.
  db.exec(`
    CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT);
    CREATE TABLE task_events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER, kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE task_comments (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, body TEXT, created_at INTEGER NOT NULL);`)
  const nowSec = Math.floor(T0 / 1000)
  db.prepare('INSERT INTO tasks (id,title,body,assignee,status,created_at,result) VALUES (?,?,?,?,?,?,?)').run('t_1', 'Build it', SECRETS[0], 'taxis', 'running', nowSec - 100, SECRETS[1])
  db.prepare('INSERT INTO tasks (id,title,body,assignee,status,created_at,result) VALUES (?,?,?,?,?,?,?)').run('t_2', 'Ship it', SECRETS[0], 'taxis', 'done', nowSec - 100, SECRETS[1])
  db.prepare('INSERT INTO task_events (task_id,run_id,kind,payload,created_at) VALUES (?,?,?,?,?)').run('t_1', 1, 'claimed', `{"secret":"${SECRETS[2]}"}`, nowSec - 20)
  db.prepare('INSERT INTO task_events (task_id,run_id,kind,payload,created_at) VALUES (?,?,?,?,?)').run('t_2', null, 'completed', `{"secret":"${SECRETS[2]}"}`, nowSec - 5)
  db.prepare('INSERT INTO task_comments (task_id,body,created_at) VALUES (?,?,?)').run('t_1', SECRETS[3], nowSec - 10)
  db.close()
})
after(() => rmSync(root, { recursive: true, force: true }))

test('no task body, comment, result or event payload reaches the client: /api/fleet payload and the block data are checked for the markers', async () => {
  const res = handleFleetRequest(
    new Request('http://localhost/api/fleet', { headers: { host: '127.0.0.1:3000' } }),
    { readKanban: () => readKanbanFleet({ kanbanHome: home, defaultDbPath: join(root, 'none.db'), sinceMs: 0 }), readSupermemory: () => ({ nodes: [] }), env: {}, now: () => T0 },
  )
  assert.equal(res.status, 200)
  const payload = await res.json() as { kanban: PublicKanbanBoardNode[] }
  const wire = JSON.stringify(payload)
  assert.equal(payload.kanban.length, 1, 'the fixture board was read')
  assert.equal(payload.kanban[0].recentEvents.length, 2)
  for (const secret of SECRETS) assert.ok(!wire.includes(secret), `payload must not contain ${secret}`)

  // What the block code derives from that payload (blocks, graph node, inspector) carries no secret either,
  // and nothing about single tasks: no title, no task id.
  const g = buildFleetGraph({ instances: instances(), kanban: payload.kanban, selection: all, now: T0, options: defaultOptions() })
  const node = g.nodes.find(n => n.kind === 'kanban')!
  assert.equal(node.label, 'alpha')
  assert.deepEqual(node.block, { slug: 'alpha', counts: [['running', 1], ['done', 1]], kinds: [['claimed', 1], ['completed', 1]] })
  const derived = JSON.stringify({ node, blocks: [...buildKanbanBlocks(payload.kanban)], info: kanbanBlockInfo(payload.kanban[0]) })
  for (const secret of SECRETS) assert.ok(!derived.includes(secret), `block data must not contain ${secret}`)
  for (const task of ['Build it', 'Ship it', 't_1', 't_2']) assert.ok(!derived.includes(task), `block data must not name a task (${task})`)
})
