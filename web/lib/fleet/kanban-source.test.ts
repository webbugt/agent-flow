import { test, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  discoverKanbanBoards,
  openKanbanDbReadOnly,
  readKanbanBoardNode,
  readKanbanFleet,
  resolveKanbanHome,
} from './kanban-source'

// Subset of the real Hermes kanban schema (only the columns we touch, plus
// payload/body columns that must never leak into the output).
const SCHEMA = `
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, assignee TEXT,
  status TEXT NOT NULL, created_at INTEGER NOT NULL, result TEXT
);
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id INTEGER,
  kind TEXT NOT NULL, payload TEXT, created_at INTEGER NOT NULL
);`

type Task = [id: string, title: string, assignee: string | null, status: string]
type Ev = [taskId: string, kind: string, createdAt: number, runId?: number]

function makeBoardDb(dbPath: string, tasks: Task[], events: Ev[], wal = false): DatabaseSync {
  const db = new DatabaseSync(dbPath)
  if (wal) db.exec('PRAGMA journal_mode = WAL')
  db.exec(SCHEMA)
  const t = db.prepare('INSERT INTO tasks (id,title,body,assignee,status,created_at,result) VALUES (?,?,?,?,?,?,?)')
  for (const [id, title, assignee, status] of tasks) t.run(id, title, 'SECRET BODY', assignee, status, 1000, 'SECRET RESULT')
  const e = db.prepare('INSERT INTO task_events (task_id,run_id,kind,payload,created_at) VALUES (?,?,?,?,?)')
  for (const [taskId, kind, at, runId] of events) e.run(taskId, runId ?? null, kind, '{"secret":"SECRET PAYLOAD"}', at)
  return db
}

function makeBoard(home: string, slug: string, meta: object | null, tasks: Task[], events: Ev[], wal = false) {
  const dir = join(home, 'boards', slug)
  mkdirSync(dir, { recursive: true })
  if (meta) writeFileSync(join(dir, 'board.json'), JSON.stringify(meta))
  const db = makeBoardDb(join(dir, 'kanban.db'), tasks, events, wal)
  return { db, dbPath: join(dir, 'kanban.db') }
}

let root: string
let home: string
let alphaWriter: DatabaseSync

before(() => {
  root = mkdtempSync(join(tmpdir(), 'kanban-source-'))
  home = join(root, 'kanban')

  // alpha: WAL mode with the writer connection left open, like a live Hermes dispatcher.
  const alpha = makeBoard(
    home,
    'alpha',
    { slug: 'alpha', name: 'Alpha Board', description: 'first', archived: false },
    [
      ['t_1', 'Build reader', 'omh-coder', 'running'],
      ['t_2', 'Review reader', 'omh-reviewer', 'todo'],
      ['t_3', 'Plan', 'omh-orchestrator', 'done'],
      ['t_4', 'Ship', null, 'done'],
      ['t_5', 'Odd', null, 'weird-status'],
    ],
    [
      ['t_3', 'created', 100],
      ['t_3', 'completed', 200, 1],
      ['t_1', 'created', 300],
      ['t_1', 'claimed', 400, 2],
      ['t_gone', 'created', 500], // task row missing
    ],
    true,
  )
  alphaWriter = alpha.db

  // beta: separate board = separate node. No board.json -> name falls back to slug.
  makeBoard(home, 'beta', null, [['t_9', 'Only task', 'x', 'blocked']], [['t_9', 'blocked', 900]]).db.close()

  // gamma: archived in board.json.
  makeBoard(home, 'gamma', { name: 'Gamma', archived: true }, [['t_g', 'g', null, 'ready']], []).db.close()

  // _archived dir and a board dir with no db must be ignored.
  mkdirSync(join(home, 'boards', '_archived', 'old'), { recursive: true })
  mkdirSync(join(home, 'boards', 'nodb'), { recursive: true })

  // Legacy default board at <home>/../kanban.db (root/kanban.db).
  makeBoardDb(join(root, 'kanban.db'), [['t_d', 'Default task', null, 'ready']], [['t_d', 'created', 50]]).close()

  // corrupt: not a sqlite file.
  const bad = join(home, 'boards', 'corrupt')
  mkdirSync(bad, { recursive: true })
  writeFileSync(join(bad, 'kanban.db'), 'this is not a database'.repeat(50))
})

after(() => {
  try {
    alphaWriter.close()
  } catch {
    // already closed
  }
  rmSync(root, { recursive: true, force: true })
})

test('discovers each board separately, skipping _archived, db-less dirs and archived boards', () => {
  const slugs = discoverKanbanBoards({ kanbanHome: home }).map((b) => b.slug)
  assert.deepEqual(slugs, ['alpha', 'beta', 'corrupt', 'default'])
})

test('includeArchived surfaces archived boards; names come from board.json with slug fallback', () => {
  const boards = discoverKanbanBoards({ kanbanHome: home, includeArchived: true })
  assert.deepEqual(boards.map((b) => b.slug), ['alpha', 'beta', 'corrupt', 'default', 'gamma'])
  const by = Object.fromEntries(boards.map((b) => [b.slug, b]))
  assert.equal(by.alpha.name, 'Alpha Board')
  assert.equal(by.beta.name, 'beta')
  assert.equal(by.default.name, 'Default')
  assert.equal(by.gamma.archived, true)
})

test('kanban home resolution: option > HERMES_KANBAN_HOME > HERMES_HOME root (profile dirs map to root)', () => {
  assert.equal(resolveKanbanHome({ kanbanHome: '/x' }, { HERMES_HOME: '/h' }), '/x')
  assert.equal(resolveKanbanHome({}, { HERMES_KANBAN_HOME: '/k', HERMES_HOME: '/h' }), '/k')
  assert.equal(resolveKanbanHome({}, { HERMES_HOME: '/h/.hermes' }), '/h/.hermes/kanban')
  assert.equal(resolveKanbanHome({}, { HERMES_HOME: '/h/.hermes/profiles/omh-coder' }), '/h/.hermes/kanban')
  assert.match(resolveKanbanHome({}, {}), /\.hermes[\\/]kanban$/)
})

test('missing kanban home yields no boards instead of throwing', () => {
  assert.deepEqual(discoverKanbanBoards({ kanbanHome: join(root, 'nope', 'kanban') }), [])
})

test('per-board task counts by status, with unknown statuses kept and known ones zero-filled', () => {
  const alpha = discoverKanbanBoards({ kanbanHome: home }).find((b) => b.slug === 'alpha')!
  const node = readKanbanBoardNode(alpha)
  assert.equal(node.id, 'kanban:alpha')
  assert.equal(node.type, 'kanban-board')
  assert.equal(node.error, undefined)
  assert.equal(node.taskCounts.running, 1)
  assert.equal(node.taskCounts.todo, 1)
  assert.equal(node.taskCounts.done, 2)
  assert.equal(node.taskCounts.blocked, 0)
  assert.equal(node.taskCounts['weird-status'], 1)
  assert.equal(node.totalTasks, 5)
})

test('recent events are newest first, in ms, joined to task title/assignee, with no payload leakage', () => {
  const alpha = discoverKanbanBoards({ kanbanHome: home }).find((b) => b.slug === 'alpha')!
  const node = readKanbanBoardNode(alpha)
  assert.deepEqual(
    node.recentEvents.map((e) => [e.kind, e.taskId, e.at]),
    [
      ['created', 't_gone', 500_000],
      ['claimed', 't_1', 400_000],
      ['created', 't_1', 300_000],
      ['completed', 't_3', 200_000],
      ['created', 't_3', 100_000],
    ],
  )
  assert.equal(node.lastEventAt, 500_000)
  const gone = node.recentEvents[0]
  assert.equal(gone.taskTitle, null)
  assert.equal(gone.assignee, null)
  const claimed = node.recentEvents[1]
  assert.equal(claimed.taskTitle, 'Build reader')
  assert.equal(claimed.assignee, 'omh-coder')
  assert.equal(claimed.runId, 2)
  assert.equal(node.recentEvents[2].runId, null)
  assert.ok(!JSON.stringify(node).includes('SECRET'))
})

test('eventLimit, sinceMs and afterEventId filter events', () => {
  const alpha = discoverKanbanBoards({ kanbanHome: home }).find((b) => b.slug === 'alpha')!
  assert.equal(readKanbanBoardNode(alpha, { eventLimit: 2 }).recentEvents.length, 2)
  assert.equal(readKanbanBoardNode(alpha, { eventLimit: 0 }).recentEvents.length, 1) // clamped to >= 1
  assert.deepEqual(
    readKanbanBoardNode(alpha, { sinceMs: 300_000 }).recentEvents.map((e) => e.at),
    [500_000, 400_000, 300_000],
  )
  assert.deepEqual(readKanbanBoardNode(alpha, { afterEventId: 4 }).recentEvents.map((e) => e.id), [5])
  // totals are unaffected by event filters
  assert.equal(readKanbanBoardNode(alpha, { eventLimit: 1 }).totalTasks, 5)
})

test('reads a live WAL board while a writer connection is open, and sees new writes', () => {
  const alpha = discoverKanbanBoards({ kanbanHome: home }).find((b) => b.slug === 'alpha')!
  alphaWriter.prepare('INSERT INTO task_events (task_id,kind,created_at) VALUES (?,?,?)').run('t_1', 'heartbeat', 600)
  const node = readKanbanBoardNode(alpha)
  assert.equal(node.error, undefined)
  assert.equal(node.recentEvents[0].kind, 'heartbeat')
})

test('boards are separate nodes with independent counts', () => {
  const snap = readKanbanFleet({ kanbanHome: home })
  assert.deepEqual(snap.nodes.map((n) => n.id), ['kanban:alpha', 'kanban:beta', 'kanban:corrupt', 'kanban:default'])
  const by = Object.fromEntries(snap.nodes.map((n) => [n.slug, n]))
  assert.equal(by.alpha.totalTasks, 5)
  assert.equal(by.beta.totalTasks, 1)
  assert.equal(by.beta.taskCounts.blocked, 1)
  assert.equal(by.default.taskCounts.ready, 1)
  assert.equal(by.default.recentEvents[0].taskTitle, 'Default task')
  assert.ok(snap.readAt > 0)
})

test('one unreadable board reports an error without breaking the others', () => {
  const snap = readKanbanFleet({ kanbanHome: home })
  const corrupt = snap.nodes.find((n) => n.slug === 'corrupt')!
  assert.ok(corrupt.error && corrupt.error.length > 0)
  assert.equal(corrupt.totalTasks, 0)
  assert.deepEqual(corrupt.recentEvents, [])
  assert.equal(snap.nodes.filter((n) => !n.error).length, 3)
})

test('connections are strictly read-only and reading does not modify the database file', () => {
  const alpha = discoverKanbanBoards({ kanbanHome: home }).find((b) => b.slug === 'alpha')!
  const db = openKanbanDbReadOnly(alpha.dbPath)
  try {
    assert.throws(() => db.exec("INSERT INTO tasks (id,title,status,created_at) VALUES ('x','x','todo',1)"))
    assert.throws(() => db.exec("UPDATE tasks SET status='done'"))
    assert.throws(() => db.exec('DROP TABLE tasks'))
  } finally {
    db.close()
  }

  // Checkpoint so the main file is quiescent, then compare bytes before/after reading.
  alphaWriter.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  const before = readFileSync(alpha.dbPath)
  const mtime = statSync(alpha.dbPath).mtimeMs
  readKanbanBoardNode(alpha)
  assert.ok(before.equals(readFileSync(alpha.dbPath)))
  assert.equal(statSync(alpha.dbPath).mtimeMs, mtime)
})

test('opening a nonexistent database does not create it', () => {
  const missing = join(root, 'missing.db')
  const node = readKanbanBoardNode({ slug: 'missing', name: 'missing', description: '', archived: false, dbPath: missing })
  assert.ok(node.error)
  assert.throws(() => statSync(missing))
})
