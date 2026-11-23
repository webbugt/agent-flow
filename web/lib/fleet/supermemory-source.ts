/**
 * Read-only Supermemory namespace source for the fleet view.
 *
 * Why not the Supermemory API: its analytics logs are org-wide and carry no
 * `containerTag` (input is null on ~all entries), so per-namespace event counts
 * cannot be derived from it. Decision (Webbugt, t_54c3a67d): count the agent's
 * own tool calls instead, per `container_tag`, from Hermes session data.
 *
 * Source: every Hermes `state.db` (`<root>/state.db` and
 * `<root>/profiles/<name>/state.db`), table `messages`, assistant rows whose
 * `tool_calls` JSON contains a supermemory call. Each namespace becomes its own
 * node with store / search / forget counts for the last N days (default 7).
 *
 * Accepted gaps:
 *  - Provider auto-capture and auto-recall are not tool calls and are not counted.
 *  - An event is an attempted call (the assistant message), not a confirmed
 *    success; tool results are not read.
 *  - Calls without `container_tag` use the profile's configured default, which
 *    we do not guess: they are reported under `unattributed`.
 *
 * Privacy / safety: databases are opened `readOnly` + `PRAGMA query_only`. Only
 * the tool name, the `container_tag` argument and the timestamp are kept; call
 * content, queries, ids and tool results are never read into the output. No API
 * key or network access is involved.
 *
 * Server-side only (uses node:sqlite). Do not import from webview code.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Namespaces that always appear as nodes (with zero counts if unused). */
export const SUPERMEMORY_NAMESPACES = ['matrix_org', 'omh_family', 'webbugt_video_memory'] as const

export const DEFAULT_WINDOW_DAYS = 7
export const MAX_WINDOW_DAYS = 90
const BUSY_TIMEOUT_MS = 2000
const DAY_MS = 86_400_000

export type SupermemoryAction = 'store' | 'search' | 'forget'

/**
 * Tool name -> action. The hyphenated names are aliases of the same provider
 * tools (`supermemory-save` stores, etc.) and count as the same action.
 */
export const SUPERMEMORY_TOOL_ACTIONS: Readonly<Record<string, SupermemoryAction>> = {
  supermemory_store: 'store',
  'supermemory-save': 'store',
  supermemory_search: 'search',
  'supermemory-search': 'search',
  supermemory_forget: 'forget',
  'supermemory-forget': 'forget',
}

export interface ActionCounts {
  store: number
  search: number
  forget: number
}

export interface SupermemoryDailyCounts extends ActionCounts {
  /** UTC day, `YYYY-MM-DD`. */
  day: string
}

export interface SupermemoryNamespaceNode {
  /** Stable node id, `supermemory:<containerTag>`. */
  id: string
  type: 'supermemory-namespace'
  /** Normalised container tag (lowercase, `-` -> `_`). */
  containerTag: string
  /** Counts inside the window. */
  counts: ActionCounts
  total: number
  /** Same counts split by Hermes profile (`default` = the root state.db). Only profiles with events. */
  byProfile: Record<string, ActionCounts>
  /** Per UTC day, ascending, only days with events. */
  daily: SupermemoryDailyCounts[]
  /** Epoch ms of the newest event in the window, or null. */
  lastEventAt: number | null
}

export interface SupermemorySourceInfo {
  /** Profile name (`default` for the root state.db). */
  profile: string
  dbPath: string
  /** Set when this database could not be read; it contributes no events. */
  error?: string
}

export interface SupermemoryFleetSnapshot {
  readAt: number
  hermesRoot: string
  windowDays: number
  /** Window start, epoch ms. */
  sinceMs: number
  nodes: SupermemoryNamespaceNode[]
  /** Events in the window with no `container_tag` argument; never assigned to a node. */
  unattributed: ActionCounts
  sources: SupermemorySourceInfo[]
}

export interface SupermemorySourceOptions {
  /** Hermes root (contains `state.db` and `profiles/`). Default: derived from $HERMES_HOME, else ~/.hermes. */
  hermesRoot?: string
  /** Window length in days (1..MAX_WINDOW_DAYS). Default 7. */
  windowDays?: number
  /** Clock override, epoch ms (tests). */
  now?: number
  /** Extra namespaces to always emit as nodes (normalised). */
  extraNamespaces?: string[]
}

/**
 * The Hermes root, not a profile dir: a worker runs with HERMES_HOME set to
 * `<root>/profiles/<name>`, which is mapped back to `<root>`.
 */
export function resolveHermesRoot(
  opts: Pick<SupermemorySourceOptions, 'hermesRoot'> = {},
  env: Record<string, string | undefined> = process.env,
): string {
  if (opts.hermesRoot) return opts.hermesRoot
  let root = env.HERMES_HOME || join(homedir(), '.hermes')
  const parent = dirname(root)
  if (basename(parent) === 'profiles') root = dirname(parent)
  return root
}

/** `OMH-Family` / `omh-family` -> `omh_family`. */
export function normalizeContainerTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/-/g, '_')
}

/** Discovers Hermes session databases: root first (`default`), then profiles sorted by name. */
export function discoverStateDbs(hermesRoot: string): Array<{ profile: string; dbPath: string }> {
  const out: Array<{ profile: string; dbPath: string }> = []
  const rootDb = join(hermesRoot, 'state.db')
  if (existsSync(rootDb)) out.push({ profile: 'default', dbPath: rootDb })

  const profilesDir = join(hermesRoot, 'profiles')
  let names: string[] = []
  try {
    names = readdirSync(profilesDir)
  } catch {
    names = []
  }
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.startsWith('_')) continue
    const dir = join(profilesDir, name)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const dbPath = join(dir, 'state.db')
    if (existsSync(dbPath)) out.push({ profile: name, dbPath })
  }
  return out
}

/** Opens a session DB strictly read-only. Caller must close(). */
export function openStateDbReadOnly(dbPath: string): DatabaseSync {
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

function emptyCounts(): ActionCounts {
  return { store: 0, search: 0, forget: 0 }
}

function clampWindow(n: number | undefined): number {
  if (n === undefined || !Number.isFinite(n)) return DEFAULT_WINDOW_DAYS
  return Math.max(1, Math.min(MAX_WINDOW_DAYS, Math.floor(n)))
}

function parseJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** One supermemory call extracted from a tool_calls array. No payload fields are kept. */
interface ExtractedCall {
  /** Provider call id (may be absent). */
  callId: string
  action: SupermemoryAction
  /** Normalised container tag, or null when the call carried none. */
  tag: string | null
  /** Hash of the raw arguments, only used to de-duplicate copies of the same call. */
  argsHash: string
}

function containerTagOf(args: unknown): string | null {
  if (!isRecord(args)) return null
  const raw = args.container_tag ?? args.containerTag
  if (typeof raw !== 'string' || raw.trim() === '') return null
  return normalizeContainerTag(raw)
}

function hashArgs(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

/**
 * Extracts supermemory calls from one assistant message's `tool_calls` JSON.
 * Handles the OpenAI-style `{id|call_id, function:{name, arguments}}` shape and
 * calls routed through a generic `tool_call` wrapper (`{calls:[{name, arguments}]}`).
 */
export function extractSupermemoryCalls(toolCallsJson: string): ExtractedCall[] {
  const calls = parseJson(toolCallsJson)
  if (!Array.isArray(calls)) return []
  const out: ExtractedCall[] = []

  const add = (name: unknown, rawArgs: unknown, callId: string) => {
    if (typeof name !== 'string') return
    const action = SUPERMEMORY_TOOL_ACTIONS[name.replace(/^mcp__[^_]+__/, '')]
    if (!action) return
    out.push({ callId, action, tag: containerTagOf(parseJson(rawArgs)), argsHash: hashArgs(rawArgs) })
  }

  for (const c of calls) {
    if (!isRecord(c)) continue
    const fn = isRecord(c.function) ? c.function : c
    const callId = String(c.call_id ?? c.id ?? '')
    const name = fn.name
    const rawArgs = fn.arguments ?? fn.input
    if (typeof name === 'string' && name.replace(/^mcp__[^_]+__/, '') === 'tool_call') {
      const inner = parseJson(rawArgs)
      const wrapped = isRecord(inner) && Array.isArray(inner.calls) ? inner.calls : []
      wrapped.forEach((w, i) => {
        if (isRecord(w)) add(w.name, w.arguments, `${callId}#${i}`)
      })
      continue
    }
    add(name, rawArgs, callId)
  }
  return out
}

interface RawEvent {
  profile: string
  action: SupermemoryAction
  tag: string | null
  /** Epoch ms. */
  at: number
}

/**
 * Reads supermemory call events from one session DB. Hermes copies message
 * history on compaction/resume with fresh timestamps, so identical calls
 * (same call id + same arguments) are collapsed and the earliest timestamp wins.
 * The window filter is applied by the caller, after de-duplication.
 */
export function readSupermemoryEvents(dbPath: string, profile: string): RawEvent[] {
  const db = openStateDbReadOnly(dbPath)
  try {
    const rows = db
      .prepare(
        "SELECT tool_calls, timestamp FROM messages WHERE role = 'assistant' AND tool_calls LIKE '%supermemory%'",
      )
      .all() as Array<{ tool_calls: string | null; timestamp: number | bigint }>

    const seen = new Map<string, RawEvent>()
    let anon = 0
    for (const r of rows) {
      if (typeof r.tool_calls !== 'string') continue
      const at = Math.round(Number(r.timestamp) * 1000)
      if (!Number.isFinite(at)) continue
      for (const c of extractSupermemoryCalls(r.tool_calls)) {
        // Calls without any id cannot be matched to a copy; count each as unique.
        const key = c.callId ? `${c.callId}|${c.argsHash}` : `anon#${anon++}`
        const prev = seen.get(key)
        if (!prev || at < prev.at) seen.set(key, { profile, action: c.action, tag: c.tag, at })
      }
    }
    return [...seen.values()]
  } finally {
    try {
      db.close()
    } catch {
      // ignore close errors
    }
  }
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function emptyNode(tag: string): SupermemoryNamespaceNode {
  return {
    id: `supermemory:${tag}`,
    type: 'supermemory-namespace',
    containerTag: tag,
    counts: emptyCounts(),
    total: 0,
    byProfile: {},
    daily: [],
    lastEventAt: null,
  }
}

/** Reads every namespace as a separate node. Never throws for an unreadable DB: it lands in `sources[].error`. */
export function readSupermemoryFleet(opts: SupermemorySourceOptions = {}): SupermemoryFleetSnapshot {
  const hermesRoot = resolveHermesRoot(opts)
  const windowDays = clampWindow(opts.windowDays)
  const readAt = opts.now ?? Date.now()
  const sinceMs = readAt - windowDays * DAY_MS

  const nodes = new Map<string, SupermemoryNamespaceNode>()
  for (const tag of [...SUPERMEMORY_NAMESPACES, ...(opts.extraNamespaces ?? []).map(normalizeContainerTag)]) {
    if (!nodes.has(tag)) nodes.set(tag, emptyNode(tag))
  }
  const dailyMaps = new Map<string, Map<string, SupermemoryDailyCounts>>()
  const unattributed = emptyCounts()
  const sources: SupermemorySourceInfo[] = []

  for (const { profile, dbPath } of discoverStateDbs(hermesRoot)) {
    const info: SupermemorySourceInfo = { profile, dbPath }
    sources.push(info)
    let events: RawEvent[]
    try {
      events = readSupermemoryEvents(dbPath, profile)
    } catch (err) {
      info.error = err instanceof Error ? err.message : String(err)
      continue
    }
    for (const e of events) {
      if (e.at < sinceMs || e.at > readAt) continue
      if (e.tag === null) {
        unattributed[e.action]++
        continue
      }
      let node = nodes.get(e.tag)
      if (!node) {
        node = emptyNode(e.tag)
        nodes.set(e.tag, node)
      }
      node.counts[e.action]++
      node.total++
      ;(node.byProfile[e.profile] ??= emptyCounts())[e.action]++
      if (node.lastEventAt === null || e.at > node.lastEventAt) node.lastEventAt = e.at
      const day = utcDay(e.at)
      let dm = dailyMaps.get(e.tag)
      if (!dm) dailyMaps.set(e.tag, (dm = new Map()))
      let d = dm.get(day)
      if (!d) dm.set(day, (d = { day, ...emptyCounts() }))
      d[e.action]++
    }
  }

  for (const [tag, dm] of dailyMaps) {
    nodes.get(tag)!.daily = [...dm.values()].sort((a, b) => a.day.localeCompare(b.day))
  }

  // Known namespaces first (fixed order), then others alphabetically.
  const known: string[] = SUPERMEMORY_NAMESPACES.slice()
  const ordered = [...nodes.values()].sort((a, b) => {
    const ia = known.indexOf(a.containerTag)
    const ib = known.indexOf(b.containerTag)
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
    return a.containerTag.localeCompare(b.containerTag)
  })

  return { readAt, hermesRoot, windowDays, sinceMs, nodes: ordered, unattributed, sources }
}
