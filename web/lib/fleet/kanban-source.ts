/**
 * Read-only Hermes Kanban source for the fleet view.
 *
 * Hermes keeps one SQLite database per board:
 *   <kanbanHome>/boards/<slug>/kanban.db   (+ board.json metadata)
 * plus the legacy "default" board at <hermesHome>/kanban.db.
 *
 * Every board becomes its own node. We never write: databases are opened with
 * `readOnly: true` and `PRAGMA query_only = ON`, and we deliberately return no
 * task bodies, results, comments or event payloads (they may hold secrets).
 *
 * Server-side only (uses node:sqlite). Do not import from webview code.
 *
 * We read the boards directory directly instead of shelling out to
 * `hermes kanban boards list --json`: inside a kanban worker the CLI is pinned
 * to the worker's own DB via env and reports the wrong db_path for every board.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Statuses Hermes uses today; always present (as 0) in `taskCounts`. Unknown ones are added dynamically. */
export const KNOWN_TASK_STATUSES = [
  'triage',
  'todo',
  'ready',
  'running',
  'blocked',
  'review',
  'scheduled',
  'done',
  'archived',
] as const

export const DEFAULT_EVENT_LIMIT = 50
export const MAX_EVENT_LIMIT = 1000
const DEFAULT_BOARD_SLUG = 'default'
const BUSY_TIMEOUT_MS = 2000

export interface KanbanBoardRef {
  slug: string
  name: string
  description: string
  archived: boolean
  dbPath: string
}

export interface KanbanRecentEvent {
  /** task_events.id; monotonically increasing per board, usable as a poll cursor. */
  id: number
  taskId: string
  /** Task title, or null if the task row no longer exists. */
  taskTitle: string | null
  assignee: string | null
  /** Raw Hermes event kind: created, claimed, spawned, heartbeat, blocked, completed, ... */
  kind: string
  runId: number | null
  /** Event time in epoch milliseconds (Hermes stores seconds). */
  at: number
}

export interface KanbanBoardNode {
  /** Stable node id, `kanban:<slug>`. */
  id: string
  type: 'kanban-board'
  slug: string
  name: string
  description: string
  archived: boolean
  dbPath: string
  /** Task count per status (known statuses always present). */
  taskCounts: Record<string, number>
  totalTasks: number
  /** Newest first. */
  recentEvents: KanbanRecentEvent[]
  /** Epoch ms of the newest event on this board, or null when there are none. */
  lastEventAt: number | null
  /** Set when this board could not be read; counts/events are then empty. */
  error?: string
}

export interface KanbanSourceOptions {
  /** Hermes kanban directory (contains `boards/`). Default: $HERMES_HOME/kanban or ~/.hermes/kanban. */
  kanbanHome?: string
  /** Legacy default-board DB. Default: <parent of kanbanHome>/kanban.db. */
  defaultDbPath?: string
  /** Include boards flagged archived in board.json. Default false. */
  includeArchived?: boolean
  /** Max events per board (1..MAX_EVENT_LIMIT). Default 50. */
  eventLimit?: number
  /** Only events at or after this epoch-ms timestamp. */
  sinceMs?: number
  /** Only events with id greater than this (incremental polling). Applied per board. */
  afterEventId?: number
}

export interface KanbanFleetSnapshot {
  readAt: number
  kanbanHome: string
  nodes: KanbanBoardNode[]
}

/**
 * Boards are shared across profiles, so the kanban dir lives under the Hermes
 * root, not under a profile. Order: explicit option, $HERMES_KANBAN_HOME, then
 * the Hermes root from $HERMES_HOME (a `<root>/profiles/<name>` value is mapped
 * back to `<root>`, because workers run with HERMES_HOME set to their profile),
 * then ~/.hermes.
 */
export function resolveKanbanHome(
  opts: Pick<KanbanSourceOptions, 'kanbanHome'> = {},
  env: Record<string, string | undefined> = process.env,
): string {
  if (opts.kanbanHome) return opts.kanbanHome
  if (env.HERMES_KANBAN_HOME) return env.HERMES_KANBAN_HOME
  let root = env.HERMES_HOME || join(homedir(), '.hermes')
  const parent = dirname(root)
  if (basename(parent) === 'profiles') root = dirname(parent)
  return join(root, 'kanban')
}

function metaString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Lists boards that have a database on disk. Directory names starting with `_`
 * (e.g. `_archived`) are skipped. Sorted by slug.
 */
export function discoverKanbanBoards(opts: KanbanSourceOptions = {}): KanbanBoardRef[] {
  const kanbanHome = resolveKanbanHome(opts)
  const boards: KanbanBoardRef[] = []
  const boardsDir = join(kanbanHome, 'boards')

  let entries: string[] = []
  try {
    entries = readdirSync(boardsDir)
  } catch {
    entries = []
  }

  for (const slug of entries) {
    if (slug.startsWith('_') || slug.startsWith('.')) continue
    const dir = join(boardsDir, slug)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const dbPath = join(dir, 'kanban.db')
    if (!existsSync(dbPath)) continue

    let meta: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(readFileSync(join(dir, 'board.json'), 'utf8'))
      if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
    } catch {
      // board.json is optional; fall back to the directory name.
    }
    boards.push({
      slug,
      name: metaString(meta.name) || slug,
      description: metaString(meta.description),
      archived: meta.archived === true,
      dbPath,
    })
  }

  // Legacy default board lives next to the kanban dir, unless a boards/default dir already exists.
  if (!boards.some((b) => b.slug === DEFAULT_BOARD_SLUG)) {
    const defaultDb = opts.defaultDbPath ?? join(kanbanHome, '..', 'kanban.db')
    if (existsSync(defaultDb)) {
      boards.push({ slug: DEFAULT_BOARD_SLUG, name: 'Default', description: '', archived: false, dbPath: defaultDb })
    }
  }

  return boards
    .filter((b) => opts.includeArchived || !b.archived)
    .sort((a, b) => a.slug.localeCompare(b.slug))
}

/** Opens a board DB strictly read-only. Caller must close(). */
export function openKanbanDbReadOnly(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    db.exec('PRAGMA query_only = ON')
  } catch (err) {
    db.close()
    throw err
  }
  return db
}

function emptyCounts(): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const s of KNOWN_TASK_STATUSES) counts[s] = 0
  return counts
}

function clampLimit(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_EVENT_LIMIT
  return Math.max(1, Math.min(MAX_EVENT_LIMIT, Math.floor(n)))
}

function toNumber(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : (v as number)
}

/** Reads one board into a node. Never throws: failures land in `node.error`. */
export function readKanbanBoardNode(board: KanbanBoardRef, opts: KanbanSourceOptions = {}): KanbanBoardNode {
  const node: KanbanBoardNode = {
    id: `kanban:${board.slug}`,
    type: 'kanban-board',
    slug: board.slug,
    name: board.name,
    description: board.description,
    archived: board.archived,
    dbPath: board.dbPath,
    taskCounts: emptyCounts(),
    totalTasks: 0,
    recentEvents: [],
    lastEventAt: null,
  }

  let db: DatabaseSync | undefined
  try {
    db = openKanbanDbReadOnly(board.dbPath)

    const rows = db.prepare('SELECT status, COUNT(*) AS c FROM tasks GROUP BY status').all() as Array<{
      status: string
      c: number | bigint
    }>
    for (const r of rows) {
      const c = toNumber(r.c)
      node.taskCounts[r.status] = (node.taskCounts[r.status] ?? 0) + c
      node.totalTasks += c
    }

    const where: string[] = []
    const params: number[] = []
    if (opts.sinceMs !== undefined && Number.isFinite(opts.sinceMs)) {
      where.push('e.created_at >= ?')
      params.push(Math.floor(opts.sinceMs / 1000))
    }
    if (opts.afterEventId !== undefined && Number.isFinite(opts.afterEventId)) {
      where.push('e.id > ?')
      params.push(Math.floor(opts.afterEventId))
    }
    const sql =
      'SELECT e.id, e.task_id, e.run_id, e.kind, e.created_at, t.title, t.assignee ' +
      'FROM task_events e LEFT JOIN tasks t ON t.id = e.task_id ' +
      (where.length ? `WHERE ${where.join(' AND ')} ` : '') +
      'ORDER BY e.id DESC LIMIT ?'
    const events = db.prepare(sql).all(...params, clampLimit(opts.eventLimit)) as Array<{
      id: number | bigint
      task_id: string
      run_id: number | bigint | null
      kind: string
      created_at: number | bigint
      title: string | null
      assignee: string | null
    }>
    node.recentEvents = events.map((e) => ({
      id: toNumber(e.id),
      taskId: e.task_id,
      taskTitle: e.title ?? null,
      assignee: e.assignee ?? null,
      kind: e.kind,
      runId: e.run_id === null || e.run_id === undefined ? null : toNumber(e.run_id),
      at: toNumber(e.created_at) * 1000,
    }))

    const last = db.prepare('SELECT MAX(created_at) AS m FROM task_events').get() as { m: number | bigint | null }
    node.lastEventAt = last.m === null || last.m === undefined ? null : toNumber(last.m) * 1000
  } catch (err) {
    node.taskCounts = emptyCounts()
    node.totalTasks = 0
    node.recentEvents = []
    node.lastEventAt = null
    node.error = err instanceof Error ? err.message : String(err)
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors
    }
  }
  return node
}

/** Reads every board as a separate node. */
export function readKanbanFleet(opts: KanbanSourceOptions = {}): KanbanFleetSnapshot {
  const kanbanHome = resolveKanbanHome(opts)
  const nodes = discoverKanbanBoards(opts).map((b) => readKanbanBoardNode(b, opts))
  return { readAt: Date.now(), kanbanHome, nodes }
}
