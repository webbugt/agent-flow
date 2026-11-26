/**
 * Live Hermes activity, read straight from Hermes' own logs.
 *
 * Each Hermes profile writes `logs/agent.log` and `logs/gateway.log` under
 * ~/.hermes/profiles/<name>/ (the default profile uses ~/.hermes/logs/). This
 * watcher tails those files without changing them and turns the lines it
 * understands into Agent Flow events:
 *
 *   agent.tool_executor:     tool <name> completed (<secs>s, ...)
 *       -> tool_call_start + tool_call_end
 *   agent.conversation_loop: API call #N: model=M ... in=I out=O ... cache=R/I write=W
 *       -> context_update (context size + billed usage) and model_detected
 *   gateway.run:             inbound message: platform=P user=U chat=...
 *       -> message (role user, "Message from U via P"), direction into the agent
 *
 * Layout: one Agent Flow session per profile. The profile is a main node
 * (for example "Taxis"), and each Hermes session of that profile is a child
 * node named "<Profile> · <short title>" (for example "Taxis · Visualisation").
 * The short title comes from the session's title in Hermes' state database,
 * read-only.
 *
 * Full text (see hermes-transcript.ts): agent.log only says which tool ran and
 * for how long, so the watcher also reads each session's messages from the
 * profile's state.db, READ-ONLY (opened with readOnly + PRAGMA query_only, SELECT
 * only). That gives the real user and assistant text, the full tool command or
 * edit (messages.tool_calls) and the full tool result (role=tool rows, linked by
 * tool_call_id). For a session found in state.db those replace the log-derived
 * tool events and the "Message from <user>" placeholder; the log still supplies
 * model and token usage. If state.db or the session is not readable, the
 * log-only behaviour above is used. Secrets in that text are redacted before
 * it leaves hermes-transcript.ts.
 *
 * Nothing is written to Hermes, no synthetic transcripts are created, and no
 * gateway restart is needed. gateway.log is still read for sender and platform
 * only, never for message text.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent, EnergyUsage, SessionInfo, SpendTotals } from '../extension/src/protocol'
import { addUsage } from '../extension/src/usage-ledger'
import { EnergyLedger } from '../web/lib/costs/energy'
import { BUILTIN_PROVIDERS } from '../web/lib/costs/resolve'
import { readSessionTranscript, rowsToItems } from './hermes-transcript'
import type { TranscriptReader } from './hermes-transcript'
import { isAnonymized, warnUnknownProfiles } from '../web/lib/content-privacy'
import type { AnonymizePolicy } from '../web/lib/content-privacy'

/** Minimal shape of node:sqlite's DatabaseSync (loaded at runtime; typed here for older @types/node). */
export interface SqliteDb {
  exec(sql: string): void
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown }
  close(): void
}
export type SqliteCtor = new (file: string, options?: { readOnly?: boolean }) => SqliteDb

// ─── Line parsing (pure) ────────────────────────────────────────────────────

export type HermesLogEvent =
  | { kind: 'tool'; tool: string; status: 'completed' | 'failed'; seconds: number }
  | {
      kind: 'api'
      model: string
      /** Hermes `provider=` value (`copilot`, `claude-subscription-directsdk-experimental`, `ollama`, ...) */
      provider: string
      /** Latency of this call in seconds; absent when the line has no `latency=` */
      latencySeconds?: number
      inputTokens: number
      outputTokens: number
      /** Tokens read from the prompt cache (part of `in`) */
      cacheReadTokens: number
      /** Tokens written to the prompt cache (part of `in`) */
      cacheWriteTokens: number
    }

export interface ParsedHermesLine {
  /** Hermes session id from the `[...]` tag, when the line has one */
  sid?: string
  event: HermesLogEvent
}

const LINE_RE = /^\S+ \S+ \w+ (?:\[([^\]]+)\] )?agent\.(?:tool_executor|conversation_loop): (.*)$/
const TOOL_RE = /^tool (\S+) (completed|failed) \(([\d.]+)s/
const API_RE = /^API call #\d+: model=(\S+) provider=(\S+) in=(\d+) out=(\d+)\b/
const LATENCY_RE = /\blatency=(\d+(?:\.\d+)?)(ms|s)\b/
const CACHE_RE = /\bcache=(\d+)\/\d+\b/
const WRITE_RE = /\bwrite=(\d+)\b/
/** The trailing ` id=<opaque>` field (a response id; may be long and arbitrary) is cut off before the counters are read. */
const ID_TAIL_RE = / id=\S*$/

/** Parse one agent.log line. Returns null for lines the watcher does not use. */
export function parseHermesLogLine(line: string): ParsedHermesLine | null {
  const m = LINE_RE.exec(line)
  if (!m) return null
  const sid = m[1]
  const body = m[2]

  const tool = TOOL_RE.exec(body)
  if (tool) {
    return {
      sid,
      event: { kind: 'tool', tool: tool[1], status: tool[2] as 'completed' | 'failed', seconds: Number(tool[3]) },
    }
  }

  const api = API_RE.exec(body)
  if (api) {
    const fields = body.replace(ID_TAIL_RE, '')
    const cache = CACHE_RE.exec(fields)
    const write = WRITE_RE.exec(fields)
    const latency = LATENCY_RE.exec(fields)
    return {
      sid,
      event: {
        kind: 'api',
        model: api[1],
        provider: api[2],
        ...(latency ? { latencySeconds: latency[2] === 'ms' ? Number(latency[1]) / 1000 : Number(latency[1]) } : {}),
        inputTokens: Number(api[3]),
        outputTokens: Number(api[4]),
        cacheReadTokens: cache ? Number(cache[1]) : 0,
        cacheWriteTokens: write ? Number(write[1]) : 0,
      },
    }
  }
  return null
}

const LOG_TIME_RE = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:[,.](\d{1,3}))?\b/

/**
 * Wall-clock time of a log line (epoch ms). Hermes writes the host's local time, so the fields are read as local time
 * (the same zone the energy tariff uses by default). Null when the line has no timestamp prefix.
 */
export function parseHermesLogTimestamp(line: string): number | null {
  const m = LOG_TIME_RE.exec(line)
  if (!m) return null
  const ms = m[7] ? Number(m[7].padEnd(3, '0')) : 0
  const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms).getTime()
  return Number.isFinite(t) ? t : null
}

/**
 * Calls whose busy time is recorded for the energy estimate: every provider except the built-in non-local ones
 * (Claude, Copilot). Whether an unknown provider really is a local model is decided on the page from the config in
 * force, so a user rule can mark `my-gpu-box` as local without the host knowing.
 */
export function mayBeLocalProvider(provider: string): boolean {
  const builtin = Object.hasOwn(BUILTIN_PROVIDERS, provider) ? BUILTIN_PROVIDERS[provider] : undefined
  return builtin === undefined || builtin.billing === 'local'
}

export interface InboundMessage {
  platform: string
  user: string
}

const INBOUND_RE = /^\S+ \S+ \w+ [^:]+: inbound message: platform=(\S+) user=(.*?) chat=/

/** Parse one gateway.log line. Only the platform and sender are kept; message text is ignored. */
export function parseGatewayInbound(line: string): InboundMessage | null {
  const m = INBOUND_RE.exec(line)
  if (!m) return null
  return { platform: m[1], user: m[2] }
}

// ─── Naming ─────────────────────────────────────────────────────────────────

/** Hermes tool names mapped to the names Agent Flow's tool renderers know. */
const TOOL_NAME_MAP: Record<string, string> = {
  terminal: 'Bash',
  execute_code: 'Bash',
  read_file: 'Read',
  write_file: 'Write',
  patch: 'Edit',
  search_files: 'Grep',
  web_search: 'WebSearch',
  web_extract: 'WebFetch',
  browser_exec: 'WebFetch',
  delegate_task: 'Task',
}

export function displayToolName(tool: string): string {
  return TOOL_NAME_MAP[tool] ?? tool
}

/** `default` -> "Hermes", `omh-coder` -> "OMH Coder", `sophia` -> "Sophia". */
export function displayProfileName(profile: string): string {
  if (profile === 'default') return 'Hermes'
  const parts = profile.split(/[-_]/).filter(Boolean)
  return parts
    .map((p, i) => (i === 0 && p.toLowerCase() === 'omh' ? 'OMH' : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

/**
 * Map a Hermes home-like path to the Hermes root that holds `profiles/` and `logs/`.
 * `~/.hermes` -> `~/.hermes`; `~/.hermes/profiles` -> `~/.hermes`;
 * `~/.hermes/profiles/taxis` -> `~/.hermes` (what a profile shell exports as HERMES_HOME).
 */
export function resolveHermesRoot(p: string): string {
  const normalized = path.resolve(p)
  if (path.basename(normalized) === 'profiles') return path.dirname(normalized)
  if (path.basename(path.dirname(normalized)) === 'profiles') return path.dirname(path.dirname(normalized))
  return normalized
}

/** Short, readable tag for a Hermes session id (`20261123_103037_d0ddaef5` -> `d0ddaef5`). */
export function shortSessionTag(sid: string): string {
  const last = sid.split('_').pop() ?? sid
  return last.length > 0 ? last.slice(-8) : sid.slice(-8)
}

const TITLE_STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'with', 'my', 'our', 'your',
  'from', 'by', 'at', 'as', 'is', 'are', 'be', 'this', 'that', 'about', 'vs', 'how',
  'session', 'report', 'chat', 'new', 'update',
])
const MAX_SHORT_NAME = 18

/**
 * A 1-2 word node name from a session title: drops filler words, keeps the
 * first two meaningful words. Deterministic, no model call.
 * "Agentic system visualisation options PDF report" -> "Agentic System".
 */
export function shortSessionName(title: string): string {
  const words = title.replace(/[^\p{L}\p{N}\s-]+/gu, ' ').split(/\s+/).filter(Boolean)
  const meaningful = words.filter(w => !TITLE_STOP_WORDS.has(w.toLowerCase()))
  const pick = (meaningful.length > 0 ? meaningful : words).slice(0, 2)
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
  const name = pick.map(cap).join(' ')
  return name.length <= MAX_SHORT_NAME ? name : cap(pick[0] ?? '').slice(0, MAX_SHORT_NAME)
}

/**
 * Title of a Hermes session from the profile's state database. Opened
 * read-only; any failure (missing db, no row, locked) returns undefined.
 */
export function readSessionTitle(dbFile: string, sid: string): string | undefined {
  try {
    const DatabaseSync = (require('node:sqlite') as { DatabaseSync: SqliteCtor }).DatabaseSync
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const row = db.prepare('select title from sessions where id = ?').get(sid) as { title?: string | null } | undefined
      const title = row?.title?.trim()
      return title ? title : undefined
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

/** A Hermes session with recent activity, as listed in a profile's state.db. */
export interface RecentSession {
  id: string
  title?: string
  /** Epoch ms of the session's first row */
  startedAt: number
  /** Epoch ms of its newest message (its start if it has none) */
  lastActivityAt: number
}

/** How far back idle profiles are looked up: 24 hours. */
export const DEFAULT_IDLE_WINDOW_MS = 24 * 3_600_000
/**
 * Idle window from AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS (hours, may be fractional; 0 turns
 * idle profiles off). Unset or invalid: the 24 h default.
 */
export function idleWindowFromEnv(env: Record<string, string | undefined> = process.env): number {
  const raw = env.AGENT_FLOW_FLEET_IDLE_WINDOW_HOURS
  if (raw === undefined || raw.trim() === '') return DEFAULT_IDLE_WINDOW_MS
  const hours = Number(raw)
  return Number.isFinite(hours) && hours >= 0 ? Math.round(hours * 3_600_000) : DEFAULT_IDLE_WINDOW_MS
}
/** At most this many sessions per profile are restored, newest first. */
export const MAX_RESTORED_SESSIONS = 20

/**
 * Hermes sessions of one profile with activity at or after `sinceMs`, newest
 * first. Read-only SELECT on `sessions` and `messages`; any failure (missing
 * db, locked, unknown schema) returns an empty list.
 */
export function readRecentSessions(dbFile: string, sinceMs: number, limit = MAX_RESTORED_SESSIONS): RecentSession[] {
  try {
    const DatabaseSync = (require('node:sqlite') as { DatabaseSync: SqliteCtor }).DatabaseSync
    const db = new DatabaseSync(dbFile, { readOnly: true })
    try {
      const rows = db.prepare(
        `select id, title, started_at, last_at from (
           select s.id as id, s.title as title, s.started_at as started_at,
                  coalesce((select max(m.timestamp) from messages m where m.session_id = s.id), s.started_at) as last_at
           from sessions s
         ) where last_at >= ? order by last_at desc limit ?`,
      ).all(sinceMs / 1000, limit) as Array<{ id: string; title: string | null; started_at: number | null; last_at: number | null }>
      const out: RecentSession[] = []
      for (const r of rows) {
        if (typeof r.id !== 'string' || typeof r.last_at !== 'number') continue
        const lastActivityAt = Math.round(r.last_at * 1000)
        const startedAt = typeof r.started_at === 'number' ? Math.min(Math.round(r.started_at * 1000), lastActivityAt) : lastActivityAt
        const title = r.title?.trim()
        out.push({ id: r.id, ...(title ? { title } : {}), startedAt, lastActivityAt })
      }
      return out
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

// ─── Watcher ────────────────────────────────────────────────────────────────

export interface HermesLogWatcherOptions {
  /** Directory holding one folder per profile, e.g. ~/.hermes/profiles */
  profilesRoot: string
  /** Log directory of the default profile, e.g. ~/.hermes/logs (optional) */
  defaultLogDir?: string
  /** Session title lookup. Defaults to reading the profile's state.db read-only. */
  titleFor?: (profile: string, dbFile: string, sid: string) => string | undefined
  /**
   * Message and tool text lookup. Defaults to reading the profile's state.db
   * read-only (see hermes-transcript.ts). Pass `false` to keep to agent.log
   * and gateway.log only.
   */
  transcriptFor?: TranscriptReader | false
  /**
   * Which profiles show structure only (see web/lib/content-privacy.ts). Without
   * a policy every profile shows full content. The policy is read per profile,
   * so one relay can anonymize some profiles and not others.
   */
  anonymize?: AnonymizePolicy
  /** Warning sink for the anonymize setting (unknown profile names). Defaults to console.warn. */
  warn?: (message: string) => void
  emit: (event: AgentEvent, sessionId?: string) => void
  lifecycle: (type: 'started' | 'ended' | 'updated', sessionId: string, label: string) => void
  now?: () => number
  pollMs?: number
  /** Quiet period after which a session's node is shown idle */
  idleMs?: number
  /** Quiet period after which a session's node is shown complete */
  endMs?: number
  /**
   * Profiles with sessions active within this window are listed as idle even when
   * the watcher saw no log line since it started (default 24 h, 0 = live activity only).
   */
  idleWindowMs?: number
  /** Recent sessions of a profile (default: read-only state.db lookup, see readRecentSessions). */
  recentSessionsFor?: (profile: string, dbFile: string, sinceMs: number) => RecentSession[]
}

/** Builds an event for a node. The node name is only known after the node is spawned. */
type Builder = (agent: string) => Omit<AgentEvent, 'sessionId'>

interface Tail {
  file: string
  /** Byte offset of the next unread byte */
  pos: number
  /** Bytes of an unfinished trailing line, carried to the next read */
  partial: Buffer
}

interface SessionState {
  sid: string
  tag: string
  /** Title once known; empty until then */
  title?: string
  /** When the watcher first saw this session */
  firstSeen: number
  lastTitleCheck: number
  startedAt: number
  lastActivity: number
  /** True once the session has logged anything */
  hasStarted: boolean
  active: boolean
  completed: boolean
  /** Node created in the visualizer */
  spawned: boolean
  /** Restored from state.db at discovery and not active since: shown idle, not live */
  restored: boolean
  agentName: string
  pending: Builder[]
  model?: string
  toolSeq: number
  /** Message and tool text read from state.db; set once the session was found there */
  transcript?: {
    /** Id of the last message row read */
    cursor: number
    /** Hermes tool-call id to Hermes tool name, to name a result that arrives later */
    calls: Map<string, string>
    /** Platform and sender of the session (its `sessions` row) */
    origin?: { platform?: string; sender?: string }
  }
  /** Cumulative usage of the session: flat totals, per-prompt-size buckets, provider, latency (see SpendTotals) */
  spend: SpendTotals
  /** Hour-bucketed local-model busy time (P5); set once a call that may be local was seen */
  energy?: EnergyUsage
  /** Prompt size of the last call, re-sent with a corrected-energy update */
  lastTokens?: number
}

interface ProfileState {
  profile: string
  /** Display name, also the main node's name */
  group: string
  /** Agent Flow session id for the whole profile */
  sessionId: string
  dbFile: string
  agentTail: Tail
  gatewayTail: Tail
  /** Hermes session id of the most recent tagged line, used for untagged lines */
  currentSid?: string
  sessions: Map<string, SessionState>
  mainActive: boolean
  /** Inbound messages received before any session node existed */
  pendingInbound: string[]
  /** Sender and platform of the latest inbound message, shown on anonymized user messages */
  lastInbound?: { user: string; platform: string }
}

const READ_CHUNK = 262144
const DISCOVER_EVERY_MS = 5000
const TITLE_RETRY_MS = 15_000
/** How long a new session waits for its title before it gets a tag name */
const TITLE_WAIT_MS = 45_000
/** How far back the time base of a session moves to fit its replayed backlog rows. */
const BACKLOG_SPAN_MS = 60 * 60_000
const UNTAGGED = 'untagged'

/** Read new complete lines from a tail. Keeps bytes, so multi-byte characters split across reads survive. */
function readTail(tail: Tail, onLine: (line: string) => void): void {
  let size: number
  try {
    size = fs.statSync(tail.file).size
  } catch {
    return
  }
  if (size < tail.pos) {
    // Rotated or truncated: start again from the top of the new file.
    tail.pos = 0
    tail.partial = Buffer.alloc(0)
  }
  if (size === tail.pos) return

  const len = Math.min(size - tail.pos, READ_CHUNK)
  const buf = Buffer.alloc(len)
  let fd: number | null = null
  try {
    fd = fs.openSync(tail.file, 'r')
    fs.readSync(fd, buf, 0, len, tail.pos)
  } catch {
    return
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
  tail.pos += len

  const data = Buffer.concat([tail.partial, buf])
  const lastNewline = data.lastIndexOf(0x0a)
  if (lastNewline === -1) {
    tail.partial = data
    return
  }
  tail.partial = data.subarray(lastNewline + 1)
  for (const line of data.subarray(0, lastNewline).toString('utf8').split('\n')) onLine(line)
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

export class HermesLogWatcher {
  private readonly opts: HermesLogWatcherOptions
  private readonly now: () => number
  private readonly titleFor: (profile: string, dbFile: string, sid: string) => string | undefined
  private readonly transcriptFor: TranscriptReader | undefined
  private readonly profiles = new Map<string, ProfileState>()
  /** Busy time of local-model calls across all profiles (they share the machine's hardware per provider) */
  private readonly energy = new EnergyLedger()
  private readonly energyOwners = new Map<string, { p: ProfileState; s: SessionState }>()
  private timer: NodeJS.Timeout | null = null
  private lastDiscovery = Number.NEGATIVE_INFINITY

  constructor(opts: HermesLogWatcherOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.titleFor = opts.titleFor ?? ((_profile, dbFile, sid) => readSessionTitle(dbFile, sid))
    this.transcriptFor = opts.transcriptFor === false ? undefined : (opts.transcriptFor ?? readSessionTranscript)
  }

  start(): void {
    if (this.timer) return
    this.poll()
    this.timer = setInterval(() => this.poll(), this.opts.pollMs ?? 1000)
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Discover profiles, read new lines, update node state. */
  poll(): void {
    const t = this.now()
    if (t - this.lastDiscovery >= DISCOVER_EVERY_MS) {
      this.lastDiscovery = t
      this.discover()
    }
    for (const p of this.profiles.values()) {
      readTail(p.agentTail, line => {
        const parsed = parseHermesLogLine(line)
        if (parsed) this.handle(p, parsed, parseHermesLogTimestamp(line))
      })
      readTail(p.gatewayTail, line => {
        const inbound = parseGatewayInbound(line)
        if (inbound) this.deliverInbound(p, inbound)
      })
      for (const s of p.sessions.values()) {
        if (s.active && !s.completed) this.pumpTranscript(p, s)
        this.trySpawn(p, s, t)
        this.updateActivity(p, s)
      }
      this.checkProfileEnd(p)
    }
  }

  /** Profiles currently known to the watcher. */
  knownProfiles(): string[] {
    return [...this.profiles.keys()].sort()
  }

  /**
   * Profiles for the relay's session list. Each profile is one Agent Flow
   * session, so a page that loads late still sees it. Profiles with sessions
   * inside the idle window are listed too, marked `idle`, so the fleet view
   * shows every profile and not only the ones that logged since the relay started.
   */
  getActiveSessions(): SessionInfo[] {
    const out: SessionInfo[] = []
    for (const p of this.profiles.values()) {
      const started = [...p.sessions.values()].filter(s => s.hasStarted)
      if (started.length === 0) continue
      out.push({
        id: p.sessionId,
        label: p.group,
        status: p.mainActive ? 'active' : 'completed',
        startTime: Math.min(...started.map(s => s.startedAt)),
        lastActivityTime: Math.max(...started.map(s => s.lastActivity)),
        // Only restored from history, nothing live since the watcher started
        ...(!p.mainActive && started.every(s => s.restored) ? { idle: true } : {}),
      })
    }
    return out
  }

  /** Hermes session ids seen for one profile, for tests and status views. */
  sessionsOf(profile: string): string[] {
    return [...(this.profiles.get(profile)?.sessions.keys() ?? [])].sort()
  }

  /** True if this profile shows structure only. Without a policy: full content. */
  private isAnonymized(p: ProfileState): boolean {
    return this.opts.anonymize ? isAnonymized(this.opts.anonymize, p.profile) : false
  }

  /** Node names of the spawned sessions of one profile, for tests and status views. */
  nodesOf(profile: string): string[] {
    return [...(this.profiles.get(profile)?.sessions.values() ?? [])]
      .filter(s => s.spawned)
      .map(s => s.agentName)
      .sort()
  }

  private warnedUnknown = false

  private discover(): void {
    const candidates: Array<{ profile: string; group: string; logDir: string; dbFile: string }> = []
    try {
      for (const entry of fs.readdirSync(this.opts.profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dir = path.join(this.opts.profilesRoot, entry.name)
        candidates.push({
          profile: entry.name,
          group: displayProfileName(entry.name),
          logDir: path.join(dir, 'logs'),
          dbFile: path.join(dir, 'state.db'),
        })
      }
    } catch {
      // profiles root missing: nothing to watch yet
    }
    if (this.opts.defaultLogDir) {
      candidates.push({
        profile: 'default',
        group: displayProfileName('default'),
        logDir: this.opts.defaultLogDir,
        dbFile: path.join(path.dirname(this.opts.defaultLogDir), 'state.db'),
      })
    }

    if (this.opts.anonymize && !this.warnedUnknown) {
      // Once: names in the anonymize setting that are not Hermes profiles here follow the default.
      this.warnedUnknown = true
      warnUnknownProfiles(this.opts.anonymize, candidates.map(c => c.profile), this.opts.warn ?? console.warn)
    }

    for (const { profile, group, logDir, dbFile } of candidates) {
      if (this.profiles.has(profile)) continue
      const agentLog = path.join(logDir, 'agent.log')
      if (!fs.existsSync(agentLog)) continue
      const gatewayLog = path.join(logDir, 'gateway.log')
      // Start at the end: history from before the watcher attached is not replayed.
      const state: ProfileState = {
        profile,
        group,
        sessionId: `hermes-${profile}`,
        dbFile,
        agentTail: { file: agentLog, pos: fileSize(agentLog), partial: Buffer.alloc(0) },
        gatewayTail: { file: gatewayLog, pos: fileSize(gatewayLog), partial: Buffer.alloc(0) },
        sessions: new Map(),
        mainActive: false,
        pendingInbound: [],
      }
      this.profiles.set(profile, state)
      this.restoreRecent(state)
    }
  }

  /**
   * Seed a profile from state.db: every Hermes session with activity inside the
   * idle window becomes a finished child node (spawn, then complete marked `idle`),
   * placed on the wall clock by its real start and last-activity times. Nothing
   * here is live: no lifecycle call is made, so the profile is listed idle until a
   * log line shows real activity. Only structure is read (id, title, times),
   * never message text.
   */
  private restoreRecent(p: ProfileState): void {
    const windowMs = this.opts.idleWindowMs ?? DEFAULT_IDLE_WINDOW_MS
    if (!(windowMs > 0)) return
    const lookup = this.opts.recentSessionsFor ?? ((_profile, dbFile, sinceMs) => readRecentSessions(dbFile, sinceMs))
    const recent = lookup(p.profile, p.dbFile, this.now() - windowMs)
    if (recent.length === 0) return
    // Oldest first, so node names and the event order follow the history.
    const ordered = [...recent].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
    this.opts.emit({
      time: 0,
      type: 'agent_spawn',
      payload: { name: p.group, isMain: true, profile: p.profile, group: p.group, task: `Hermes profile ${p.profile}` },
    } as AgentEvent, p.sessionId)
    for (const r of ordered) {
      if (p.sessions.has(r.id)) continue
      const s = this.sessionFor(p, r.id, r.lastActivityAt)
      s.title = r.title
      s.startedAt = r.startedAt
      s.lastActivity = r.lastActivityAt
      s.hasStarted = true
      s.restored = true
      s.spawned = true
      s.agentName = this.uniqueName(p, s)
      this.opts.emit({ time: 0, type: 'agent_spawn', payload: this.spawnPayload(p, s) } as AgentEvent, p.sessionId)
      this.opts.emit({
        time: Math.max(0, (r.lastActivityAt - r.startedAt) / 1000),
        type: 'agent_complete',
        payload: { name: s.agentName, idle: true },
      } as AgentEvent, p.sessionId)
    }
    this.opts.emit({ time: 0, type: 'agent_complete', payload: { name: p.group, idle: true } } as AgentEvent, p.sessionId)
  }

  private handle(p: ProfileState, parsed: ParsedHermesLine, lineMs: number | null = null): void {
    const t = this.now()
    let sid = parsed.sid
    if (sid) {
      p.currentSid = sid
    } else {
      sid = p.currentSid ?? UNTAGGED
    }
    const s = this.sessionFor(p, sid, t)
    this.activate(p, s, t)
    this.refreshTitle(p, s, t)
    // First sight of a session: find out whether state.db has it before the log event
    // is turned into a (text-less) tool event.
    if (!s.transcript) this.pumpTranscript(p, s)
    this.trySpawn(p, s, t)

    const ev = parsed.event
    if (ev.kind === 'tool' && s.transcript) {
      // state.db supplies this call with its full command and result; the log line only
      // carries the name and duration.
    } else if (ev.kind === 'tool') {
      const toolName = displayToolName(ev.tool)
      const toolUseId = `${p.sessionId}-${s.tag}-${++s.toolSeq}`
      const time = this.elapsed(s, t)
      this.emitFor(p, s, agent => ({ time, type: 'tool_call_start', payload: { agent, tool: toolName, toolUseId, args: '', inputData: {} } }))
      this.emitFor(p, s, agent => ({
        time,
        type: 'tool_call_end',
        payload: { agent, tool: toolName, toolUseId, result: `${ev.status} in ${ev.seconds}s`, isError: ev.status === 'failed' },
      }))
    } else {
      if (ev.model && ev.model !== s.model) {
        s.model = ev.model
        const time = this.elapsed(s, t)
        this.emitFor(p, s, agent => ({ time, type: 'model_detected', payload: { agent, model: ev.model } }))
      }
      const newInput = Math.max(0, ev.inputTokens - ev.cacheReadTokens - ev.cacheWriteTokens)
      s.spend = addUsage(
        s.spend,
        {
          inputTokens: newInput,
          outputTokens: ev.outputTokens,
          cacheReadTokens: ev.cacheReadTokens,
          // Hermes does not say which cache TTL it used; the default 5-minute bucket is assumed.
          cacheWrite5mTokens: ev.cacheWriteTokens,
          cacheWrite1hTokens: 0,
        },
        {
          model: ev.model,
          provider: ev.provider,
          latencySeconds: ev.latencySeconds,
          // `in=` is the whole prompt (cache read and write included); newInput is clamped at 0, so keep the larger.
          promptTokens: Math.max(ev.inputTokens, ev.cacheReadTokens + ev.cacheWriteTokens),
          // When the call ended (the log line's own time, else now): the plan-limit estimate needs it
          atMs: lineMs ?? t,
        },
      )
      // Energy (P5): busy time of calls that may be local models, hour-bucketed and overlap-split per device.
      const touched: Array<{ owner: string; p: ProfileState; s: SessionState }> = []
      if (mayBeLocalProvider(ev.provider)) {
        const owner = `${p.profile}/${s.sid}`
        this.energyOwners.set(owner, { p, s })
        const endMs = lineMs ?? t
        if (ev.latencySeconds !== undefined && ev.latencySeconds > 0) {
          // The log line is written when the call returns; its latency says when the call started. Calls to one provider share its device.
          for (const o of this.energy.recordTimed(ev.provider, owner, endMs - ev.latencySeconds * 1000, endMs)) {
            const other = this.energyOwners.get(o)
            if (other && other.s !== s) touched.push({ owner: o, ...other })
          }
        } else {
          this.energy.recordUntimed(owner, endMs, newInput, ev.outputTokens)
        }
        s.energy = this.energy.usage(owner)
      }
      s.lastTokens = ev.inputTokens
      this.publishSpend(p, s, this.elapsed(s, t))
      // Sessions whose share of a shared stretch just shrank get the corrected totals too (their next call may be far away).
      for (const other of touched) {
        other.s.energy = this.energy.usage(other.owner)
        this.publishSpend(other.p, other.s, this.elapsed(other.s, t))
      }
    }
    s.lastActivity = t
  }

  /** Emit the session's cumulative spend (and energy busy time) as a context update. */
  private publishSpend(p: ProfileState, s: SessionState, time: number): void {
    const spend = {
      ...s.spend,
      ...(s.spend.byBucket ? { byBucket: { ...s.spend.byBucket } } : {}),
      ...(s.energy ? { energy: s.energy } : {}),
    }
    const tokens = s.lastTokens ?? 0
    this.emitFor(p, s, agent => ({
      time,
      type: 'context_update',
      payload: {
        agent,
        tokens,
        breakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
        spend,
      },
    }))
  }

  /**
   * Read new messages of a session from state.db (read-only) and emit them as
   * the real user and assistant text and the tool calls with their full command
   * and result. Does nothing when state.db or the session cannot be read.
   */
  private pumpTranscript(p: ProfileState, s: SessionState): void {
    if (!this.transcriptFor || s.sid === UNTAGGED) return
    const batch = this.transcriptFor(p.dbFile, s.sid, s.transcript?.cursor)
    if (!batch) return
    const firstRead = !s.transcript
    const tr: NonNullable<SessionState['transcript']> = s.transcript ?? (s.transcript = { cursor: batch.lastId, calls: new Map() })
    tr.cursor = Math.max(tr.cursor, batch.lastId)
    // Sender and platform: the session's own row first, the profile's latest inbound message as a fallback.
    if (batch.origin) tr.origin = batch.origin
    const origin = tr.origin ?? (p.lastInbound ? { sender: p.lastInbound.user, platform: p.lastInbound.platform } : undefined)
    const items = rowsToItems(batch.rows, tr.calls, {
      displayTool: displayToolName,
      anonymize: this.isAnonymized(p),
      from: p.lastInbound,
      origin,
    })
    if (items.length === 0) return
    // First sight replays the backlog. Stamping it all with the instant it was read piled every
    // card on top of each other when a page loaded; the rows know when they happened, so the
    // node's time base moves back to the first of them (at most BACKLOG_SPAN_MS) and each item
    // keeps its own time. Later polls are live: they stay stamped at now.
    if (firstRead) this.rebaseToBacklog(p, s, items)
    const now = this.elapsed(s, this.now())
    let last = 0
    for (const item of items) {
      // `at` (epoch ms of the Hermes message row) is passed through for the detail views.
      const at = item.at !== undefined ? { at: item.at } : {}
      // The backlog already happened: the page applies it as a snapshot, not as live activity.
      const past = firstRead ? { history: true as const } : {}
      // Monotonic and never later than now (a row stamped after the clock, or none at all).
      const time = firstRead && item.at !== undefined
        ? (last = Math.max(last, Math.min(now, Math.max(0, (item.at - s.startedAt) / 1000))))
        : now
      if (item.kind === 'message') {
        this.emitFor(p, s, agent => ({
          time,
          type: 'message',
          ...past,
          payload: {
            agent, role: item.role, content: item.content, ...at,
            ...(item.sender ? { sender: item.sender } : {}),
            ...(item.platform ? { platform: item.platform } : {}),
          },
        }))
      } else if (item.kind === 'tool_start') {
        const toolUseId = `${p.sessionId}-${s.tag}-${item.callId}`
        this.emitFor(p, s, agent => ({
          time,
          type: 'tool_call_start',
          ...past,
          payload: { agent, tool: item.tool, toolUseId, args: item.args, inputData: item.inputData, ...at },
        }))
      } else {
        const toolUseId = `${p.sessionId}-${s.tag}-${item.callId}`
        const tool = displayToolName(item.hermesTool)
        this.emitFor(p, s, agent => ({
          time,
          type: 'tool_call_end',
          ...past,
          payload: { agent, tool, toolUseId, result: item.result, isError: item.isError, ...at },
        }))
      }
    }
    s.lastActivity = this.now()
  }

  /**
   * Move a session's time base back to its first backlog row, so replayed rows keep their
   * real spacing. Capped at BACKLOG_SPAN_MS (older rows land on the start). A node that was
   * already announced is announced again with the new base (its spawn carries `startedAt`).
   */
  private rebaseToBacklog(p: ProfileState, s: SessionState, items: ReadonlyArray<{ at?: number }>): void {
    let earliest = Infinity
    for (const item of items) if (item.at !== undefined && item.at < earliest) earliest = item.at
    if (!(earliest < s.startedAt)) return
    s.startedAt = Math.max(earliest, s.startedAt - BACKLOG_SPAN_MS)
    if (s.spawned) this.emitFor(p, s, () => ({ time: 0, type: 'agent_spawn', payload: this.spawnPayload(p, s) }))
  }

  /** Find or create the state for a Hermes session id within its profile. */
  private sessionFor(p: ProfileState, sid: string, t: number): SessionState {
    const existing = p.sessions.get(sid)
    if (existing) return existing
    const tag = sid === UNTAGGED ? UNTAGGED : shortSessionTag(sid)
    const s: SessionState = {
      sid,
      tag,
      firstSeen: t,
      lastTitleCheck: Number.NEGATIVE_INFINITY,
      startedAt: t,
      lastActivity: t,
      hasStarted: false,
      active: false,
      completed: true,
      spawned: false,
      restored: false,
      agentName: '',
      pending: [],
      toolSeq: 0,
      spend: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, calls: 0, timedCalls: 0, latencySeconds: 0 },
    }
    p.sessions.set(sid, s)
    return s
  }

  /** Mark a session active. A session that ended and got activity again starts a new run. */
  private activate(p: ProfileState, s: SessionState, t: number): void {
    if (s.active && !s.completed) return
    if (s.hasStarted) s.startedAt = t
    s.hasStarted = true
    s.restored = false
    s.active = true
    s.completed = false
    s.lastActivity = t
    this.ensureMain(p)
    if (s.spawned) {
      // Known node that was idle or complete: reactivate it.
      this.emitFor(p, s, () => ({ time: 0, type: 'agent_spawn', payload: this.spawnPayload(p, s) }))
    }
  }

  /** Title lookup for a session that has no node yet. Retried every TITLE_RETRY_MS. */
  private refreshTitle(p: ProfileState, s: SessionState, t: number): void {
    if (s.spawned || s.title || s.sid === UNTAGGED) return
    if (t - s.lastTitleCheck < TITLE_RETRY_MS) return
    s.lastTitleCheck = t
    const found = this.titleFor(p.profile, p.dbFile, s.sid)
    if (found) s.title = found
  }

  /**
   * Create the session's node once its name is known: the title, or a tag
   * after TITLE_WAIT_MS. Events for the node are buffered until then.
   */
  private trySpawn(p: ProfileState, s: SessionState, t: number): void {
    if (s.spawned || !s.hasStarted) return
    if (!s.title && s.sid !== UNTAGGED && t - s.firstSeen < TITLE_WAIT_MS) return
    s.agentName = this.uniqueName(p, s)
    s.spawned = true
    this.ensureMain(p)
    this.opts.emit({ time: 0, type: 'agent_spawn', payload: this.spawnPayload(p, s) } as AgentEvent, p.sessionId)
    const buffered = s.pending.splice(0)
    for (const build of buffered) this.opts.emit({ ...build(s.agentName) } as AgentEvent, p.sessionId)
    const heldInbound = p.pendingInbound.splice(0)
    // With the real message text from state.db the "Message from <user>" placeholder is redundant.
    for (const content of s.transcript ? [] : heldInbound) {
      this.emitFor(p, s, agent => ({ time: this.elapsed(s, t), type: 'message', payload: { agent, role: 'user', content } }))
    }
  }

  private uniqueName(p: ProfileState, s: SessionState): string {
    const short = s.sid === UNTAGGED ? 'Activity' : (s.title ? shortSessionName(s.title) : '') || s.tag
    const base = `${p.group} · ${short}`
    const taken = new Set(
      [...p.sessions.values()].filter(o => o !== s && o.spawned).map(o => o.agentName),
    )
    return taken.has(base) ? `${base} ${s.tag}` : base
  }

  private spawnPayload(p: ProfileState, s: SessionState): Record<string, unknown> {
    return {
      name: s.agentName,
      parent: p.group,
      group: p.group,
      profile: p.profile,
      // Epoch ms of this node's time base: its event times are seconds since it. The fleet
      // view needs it to place each node on the shared wall-clock axis.
      startedAt: s.startedAt,
      task: s.title ?? (s.sid === UNTAGGED ? `Hermes profile ${p.profile}` : `Hermes session ${s.sid}`),
      ...(s.model ? { model: s.model } : {}),
    }
  }

  /** The profile's main node: created once, reactivated after it completed. */
  private ensureMain(p: ProfileState): void {
    if (p.mainActive) return
    p.mainActive = true
    this.opts.lifecycle('started', p.sessionId, p.group)
    this.opts.emit({
      time: 0,
      type: 'agent_spawn',
      payload: { name: p.group, isMain: true, profile: p.profile, group: p.group, task: `Hermes profile ${p.profile}` },
    } as AgentEvent, p.sessionId)
  }

  /** Emit for a session's node, or buffer until the node exists. */
  private emitFor(p: ProfileState, s: SessionState, build: Builder): void {
    if (s.spawned) this.opts.emit({ ...build(s.agentName) } as AgentEvent, p.sessionId)
    else s.pending.push(build)
  }

  /** A message from outside, shown on the most recently active node of the profile. */
  private deliverInbound(p: ProfileState, inbound: InboundMessage): void {
    const content = `Message from ${inbound.user} via ${inbound.platform}`
    p.lastInbound = { user: inbound.user, platform: inbound.platform }
    const spawned = [...p.sessions.values()].filter(s => s.spawned)
    const target = spawned.sort((a, b) => Number(b.active && !b.completed) - Number(a.active && !a.completed) || b.lastActivity - a.lastActivity)[0]
    if (!target) {
      p.pendingInbound.push(content)
      return
    }
    if (target.transcript) return // the real text arrives from state.db
    const time = this.elapsed(target, this.now())
    this.emitFor(p, target, agent => ({ time, type: 'message', payload: { agent, role: 'user', content } }))
  }

  private updateActivity(p: ProfileState, s: SessionState): void {
    if (!s.active || s.completed) return
    const t = this.now()
    const quiet = t - s.lastActivity
    const idleMs = this.opts.idleMs ?? 60_000
    const endMs = this.opts.endMs ?? 600_000
    if (quiet > endMs) {
      s.completed = true
      s.active = false
      if (s.spawned) {
        // `reason: 'quiet'` marks this completion as the absence of activity (like agent_idle): the fleet
        // activity filter must not count it as an event of the session.
        this.opts.emit({ time: this.elapsed(s, t), type: 'agent_complete', payload: { name: s.agentName, reason: 'quiet' } } as AgentEvent, p.sessionId)
      }
    } else if (quiet > idleMs && s.spawned) {
      this.opts.emit({ time: this.elapsed(s, t), type: 'agent_idle', payload: { name: s.agentName } } as AgentEvent, p.sessionId)
    }
  }

  /** When every session of a profile has completed, the main node completes too. */
  private checkProfileEnd(p: ProfileState): void {
    if (!p.mainActive) return
    const anyActive = [...p.sessions.values()].some(s => s.active && !s.completed)
    if (anyActive) return
    p.mainActive = false
    this.opts.emit({ time: 0, type: 'agent_complete', payload: { name: p.group } } as AgentEvent, p.sessionId)
    this.opts.lifecycle('ended', p.sessionId, p.group)
  }

  private elapsed(s: SessionState, t: number): number {
    return Math.max(0, (t - s.startedAt) / 1000)
  }
}
