/**
 * Live Hermes activity, read straight from Hermes' own logs.
 *
 * Each Hermes profile writes `logs/agent.log` under ~/.hermes/profiles/<name>/
 * (the default profile writes ~/.hermes/logs/agent.log). This watcher tails
 * those files without changing them and turns the lines it understands into
 * Agent Flow events:
 *
 *   agent.tool_executor:     tool <name> completed (<secs>s, ...)
 *       -> tool_call_start + tool_call_end
 *   agent.conversation_loop: API call #N: model=M ... in=I out=O ... cache=R/I write=W
 *       -> context_update (context size + billed usage) and model_detected
 *
 * Grouping: one Agent Flow session per Hermes session id, so a profile running
 * several sessions gets several sessions. Every session carries its profile in
 * `group` (on agent_spawn and in the session label), which the planned fleet
 * view uses to draw a profile as one group with its sessions as nodes.
 *
 * Nothing is written to Hermes, no synthetic transcripts are created, and no
 * gateway restart is needed. Only profile names, session ids, tool names,
 * timing and token counts are read from the log; message text is not.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentEvent, SessionInfo } from '../extension/src/protocol'

// ─── Line parsing (pure) ────────────────────────────────────────────────────

export type HermesLogEvent =
  | { kind: 'tool'; tool: string; status: 'completed' | 'failed'; seconds: number }
  | {
      kind: 'api'
      model: string
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
const API_RE = /^API call #\d+: model=(\S+) provider=\S+ in=(\d+) out=(\d+)\b/
const CACHE_RE = /\bcache=(\d+)\/\d+\b/
const WRITE_RE = /\bwrite=(\d+)\b/

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
    const cache = CACHE_RE.exec(body)
    const write = WRITE_RE.exec(body)
    return {
      sid,
      event: {
        kind: 'api',
        model: api[1],
        inputTokens: Number(api[2]),
        outputTokens: Number(api[3]),
        cacheReadTokens: cache ? Number(cache[1]) : 0,
        cacheWriteTokens: write ? Number(write[1]) : 0,
      },
    }
  }
  return null
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

// ─── Watcher ────────────────────────────────────────────────────────────────

export interface HermesLogWatcherOptions {
  /** Directory holding one folder per profile, e.g. ~/.hermes/profiles */
  profilesRoot: string
  /** Log directory of the default profile, e.g. ~/.hermes/logs (optional) */
  defaultLogDir?: string
  emit: (event: AgentEvent, sessionId?: string) => void
  lifecycle: (type: 'started' | 'ended' | 'updated', sessionId: string, label: string) => void
  now?: () => number
  pollMs?: number
  /** Quiet period after which a session's agent is shown idle */
  idleMs?: number
  /** Quiet period after which a session is shown ended */
  endMs?: number
}

interface SessionState {
  /** Agent Flow session id, unique per profile and Hermes session */
  sessionId: string
  /** Node name, unique within the profile group */
  agentName: string
  profile: string
  group: string
  sid: string
  startedAt: number
  lastActivity: number
  active: boolean
  completed: boolean
  /** True once the session has been announced at least once */
  hasStarted: boolean
  model?: string
  toolSeq: number
  spend: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWrite5mTokens: number
    cacheWrite1hTokens: number
  }
}

interface ProfileState {
  profile: string
  group: string
  logFile: string
  /** Byte offset of the next unread line */
  pos: number
  /** Unfinished trailing line carried to the next read */
  partial: string
  /** Hermes session id of the most recent tagged line, used for untagged lines */
  currentSid?: string
  sessions: Map<string, SessionState>
}

const READ_CHUNK = 262144
const DISCOVER_EVERY_MS = 5000
const UNTAGGED = 'untagged'

export class HermesLogWatcher {
  private readonly opts: HermesLogWatcherOptions
  private readonly now: () => number
  private readonly profiles = new Map<string, ProfileState>()
  private timer: NodeJS.Timeout | null = null
  private lastDiscovery = Number.NEGATIVE_INFINITY

  constructor(opts: HermesLogWatcherOptions) {
    this.opts = opts
    this.now = opts.now ?? Date.now
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

  /** Discover profiles, read new lines and update idle/ended state. */
  poll(): void {
    const t = this.now()
    if (t - this.lastDiscovery >= DISCOVER_EVERY_MS) {
      this.lastDiscovery = t
      this.discover()
    }
    for (const state of this.profiles.values()) {
      this.readNew(state)
      for (const session of state.sessions.values()) this.updateActivity(session)
    }
  }

  /** Profiles currently known to the watcher. */
  knownProfiles(): string[] {
    return [...this.profiles.keys()].sort()
  }

  /**
   * Hermes sessions for the relay's session list, so a page that loads after
   * a session started still knows about it (it ignores events for unknown ids).
   */
  getActiveSessions(): SessionInfo[] {
    const out: SessionInfo[] = []
    for (const state of this.profiles.values()) {
      for (const s of state.sessions.values()) {
        if (!s.hasStarted) continue
        out.push({
          id: s.sessionId,
          label: `${s.group} · ${s.sid === UNTAGGED ? 'profile' : shortSessionTag(s.sid)}`,
          status: s.completed ? 'completed' : 'active',
          startTime: s.startedAt,
          lastActivityTime: s.lastActivity,
        })
      }
    }
    return out
  }

  /** Sessions of one profile, for tests and status views. */
  sessionsOf(profile: string): string[] {
    return [...(this.profiles.get(profile)?.sessions.keys() ?? [])].sort()
  }

  private discover(): void {
    const candidates: Array<{ profile: string; group: string; logFile: string }> = []
    try {
      for (const entry of fs.readdirSync(this.opts.profilesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        candidates.push({
          profile: entry.name,
          group: displayProfileName(entry.name),
          logFile: path.join(this.opts.profilesRoot, entry.name, 'logs', 'agent.log'),
        })
      }
    } catch {
      // profiles root missing: nothing to watch yet
    }
    if (this.opts.defaultLogDir) {
      candidates.push({ profile: 'default', group: displayProfileName('default'), logFile: path.join(this.opts.defaultLogDir, 'agent.log') })
    }

    for (const { profile, group, logFile } of candidates) {
      if (this.profiles.has(profile)) continue
      let size: number
      try {
        size = fs.statSync(logFile).size
      } catch {
        continue
      }
      // Start at the end: history from before the watcher attached is not replayed.
      this.profiles.set(profile, { profile, group, logFile, pos: size, partial: '', sessions: new Map() })
    }
  }

  private readNew(state: ProfileState): void {
    let size: number
    try {
      size = fs.statSync(state.logFile).size
    } catch {
      return
    }
    if (size < state.pos) {
      // Rotated or truncated: start again from the top of the new file.
      state.pos = 0
      state.partial = ''
    }
    if (size === state.pos) return

    const len = Math.min(size - state.pos, READ_CHUNK)
    const buf = Buffer.alloc(len)
    let fd: number | null = null
    try {
      fd = fs.openSync(state.logFile, 'r')
      fs.readSync(fd, buf, 0, len, state.pos)
    } catch {
      return
    } finally {
      if (fd !== null) fs.closeSync(fd)
    }
    state.pos += len

    const text = state.partial + buf.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) {
      state.partial = text
      return
    }
    state.partial = text.slice(lastNewline + 1)
    for (const line of text.slice(0, lastNewline).split('\n')) {
      const parsed = parseHermesLogLine(line)
      if (parsed) this.handle(state, parsed)
    }
  }

  private handle(state: ProfileState, parsed: ParsedHermesLine): void {
    const t = this.now()
    let sid = parsed.sid
    if (sid) {
      state.currentSid = sid
    } else {
      sid = state.currentSid ?? UNTAGGED
    }
    const session = this.sessionFor(state, sid, t)
    this.activate(session, t)

    const ev = parsed.event
    if (ev.kind === 'tool') {
      const toolName = displayToolName(ev.tool)
      const toolUseId = `${session.sessionId}-${++session.toolSeq}`
      const time = this.elapsed(session, t)
      this.emit(session, { time, type: 'tool_call_start', payload: { agent: session.agentName, tool: toolName, toolUseId, args: '', inputData: {} } })
      this.emit(session, {
        time,
        type: 'tool_call_end',
        payload: {
          agent: session.agentName,
          tool: toolName,
          toolUseId,
          result: `${ev.status} in ${ev.seconds}s`,
          isError: ev.status === 'failed',
        },
      })
    } else {
      if (ev.model && ev.model !== session.model) {
        session.model = ev.model
        this.emit(session, { time: this.elapsed(session, t), type: 'model_detected', payload: { agent: session.agentName, model: ev.model } })
      }
      const newInput = Math.max(0, ev.inputTokens - ev.cacheReadTokens - ev.cacheWriteTokens)
      session.spend = {
        inputTokens: session.spend.inputTokens + newInput,
        outputTokens: session.spend.outputTokens + ev.outputTokens,
        cacheReadTokens: session.spend.cacheReadTokens + ev.cacheReadTokens,
        // Hermes does not say which cache TTL it used; the default 5-minute bucket is assumed.
        cacheWrite5mTokens: session.spend.cacheWrite5mTokens + ev.cacheWriteTokens,
        cacheWrite1hTokens: session.spend.cacheWrite1hTokens,
      }
      this.emit(session, {
        time: this.elapsed(session, t),
        type: 'context_update',
        payload: {
          agent: session.agentName,
          tokens: ev.inputTokens,
          breakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
          spend: { ...session.spend, model: ev.model },
        },
      })
    }
    session.lastActivity = t
  }

  /** Find or create the session for a Hermes session id within its profile. */
  private sessionFor(state: ProfileState, sid: string, t: number): SessionState {
    const existing = state.sessions.get(sid)
    if (existing) return existing
    const tag = sid === UNTAGGED ? UNTAGGED : shortSessionTag(sid)
    const session: SessionState = {
      sessionId: `hermes-${state.profile}-${tag}`,
      agentName: `${state.group} ${tag}`,
      profile: state.profile,
      group: state.group,
      sid,
      startedAt: t,
      lastActivity: t,
      active: false,
      completed: true,
      hasStarted: false,
      toolSeq: 0,
      spend: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 },
    }
    state.sessions.set(sid, session)
    return session
  }

  /** Mark a session active, emitting its start (or restart after an end) once. */
  private activate(session: SessionState, t: number): void {
    if (session.active && !session.completed) return
    // A session that already ended and then got activity again starts a new run.
    if (session.hasStarted) session.startedAt = t
    session.hasStarted = true
    session.active = true
    session.completed = false
    session.lastActivity = t
    this.opts.lifecycle('started', session.sessionId, `${session.group} · ${session.sid}`)
    this.emit(session, {
      time: 0,
      type: 'agent_spawn',
      payload: {
        name: session.agentName,
        isMain: true,
        group: session.group,
        profile: session.profile,
        task: session.sid === UNTAGGED ? `Hermes profile ${session.profile}` : `Hermes session ${session.sid}`,
        ...(session.model ? { model: session.model } : {}),
      },
    })
  }

  private updateActivity(session: SessionState): void {
    if (!session.active || session.completed) return
    const quiet = this.now() - session.lastActivity
    const idleMs = this.opts.idleMs ?? 60_000
    const endMs = this.opts.endMs ?? 600_000
    if (quiet > endMs) {
      session.completed = true
      session.active = false
      this.emit(session, { time: this.elapsed(session, this.now()), type: 'agent_complete', payload: { name: session.agentName } })
      this.opts.lifecycle('ended', session.sessionId, `${session.group} · ${session.sid}`)
    } else if (quiet > idleMs) {
      this.emit(session, { time: this.elapsed(session, this.now()), type: 'agent_idle', payload: { name: session.agentName } })
    }
  }

  private elapsed(session: SessionState, t: number): number {
    return Math.max(0, (t - session.startedAt) / 1000)
  }

  private emit(session: SessionState, event: Omit<AgentEvent, 'sessionId'>): void {
    this.opts.emit({ ...event } as AgentEvent, session.sessionId)
  }
}
