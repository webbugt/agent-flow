/**
 * Resource uses read from the buffered session events the page already holds: memory containers, Hermes subsystems
 * (cron, gateway) and Kanban boards named in a tool call. This is the source of
 *   - the SUBSYSTEM blocks of the Fleet map (all sessions), and
 *   - the single-session blocks (memory, subsystem, Kanban; ONE session's events only, so another session's use can
 *     never show up there).
 * Bash heads have their own tracker (bash-blocks.ts); the Fleet map's memory and Kanban blocks keep coming from /api/fleet.
 *
 * CONTENT RULES (binding decisions 4 and 5, and the T0 spike, section 5):
 *   - Memory: the container tag only. The call's arguments (query, content, ids) and its result are never kept: this
 *     module reads `container_tag` out of them and drops the rest. A tag that does not look like a tag is ignored (it
 *     could be free text). tags starting with `personal` are never shown here: the browser does not know who the owner is (the
 *     owner is a server setting, memory-blocks.ts), so this client-side path fails closed for everybody.
 *   - Subsystems: the subsystem name and a verb (`manage`, `run`, or the gateway platform). Never a job name, id, prompt,
 *     room, sender or message text: only `payload.platform` and `payload.role` of a message are read, never `content`.
 *   - Kanban: the board slug named in the call's `board` argument and the tool's verb (`show`, `complete`). Never a task
 *     id, title, body, comment or result. Hermes' kanban tools mostly leave `board` out (they use the board of the
 *     session), and then the call cannot be attributed to a board: it is skipped, not guessed.
 *
 * The Hermes sources (T0 spike sections 3 and 5): a tool call is a `tool_call_start` with the Hermes tool name (`supermemory_search`,
 * `cronjob_manage`, `kanban_show`; also `mcp__<server>__name` and, for deferred tools, an `mcp__hermes__tool_call` wrapper with
 * `arguments.calls[]`); a gateway or cron turn is a `message` event whose `payload.platform` is the session's source.
 *
 * The tracker is incremental (it keeps how many events of each buffer it has read), like BashUseTracker.
 */
import { MAX_FADE_SECONDS, MAX_LINGER_SECONDS, type ResourceKind } from './options-registry'
import { blockId, type BlockStore, type ResourceBlock } from './resource-block'
import { isPersonalTag } from './memory-blocks'
import { identityFromLabel } from './fleet-model'
import { ASSIGN_RE, SCAN_CHARS, SHELLS, WRAPPERS, bashCommandCut, bashCommandOf, commandHead, words, type Word } from './command-head'
import { maskSecrets } from './secret-mask'

export type UseKind = Extract<ResourceKind, 'memory' | 'subsystem' | 'kanban'>

/** The subsystems that have a verified event source (T0 spike). `costs` and the Kanban dispatcher are NOT FOUND there. */
export const SUBSYSTEM_KEYS = ['cron', 'gateway'] as const
export type SubsystemKey = (typeof SUBSYSTEM_KEYS)[number]

/**
 * Message sources (`sessions.source`, carried as `payload.platform`) that come through the Hermes gateway. A closed list on
 * purpose: an unknown source is not counted as a gateway touch. `cron` is its own subsystem.
 */
export const GATEWAY_PLATFORMS: ReadonlySet<string> = new Set([
  'matrix', 'telegram', 'discord', 'slack', 'whatsapp', 'signal', 'sms', 'email', 'mattermost', 'homeassistant',
  'dingtalk', 'feishu', 'wecom', 'weixin', 'bluebubbles', 'webhook', 'api_server',
])

export const MAX_RECENT_USES = 30
export const MAX_USE_NODES = 200
const MAX_USES = 3000
const MAX_AGE_MS = (MAX_LINGER_SECONDS + MAX_FADE_SECONDS) * 1000
const TAG_RE = /^[a-z0-9_.:]{1,80}$/
export const BOARD_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i
export const VERB_RE = /^[a-z_]{1,24}$/

/** One use of a block by one session, as the tracker keeps it. No content. */
export interface EventUse {
  sid: string
  /** Profile identity of the session (`taxis`, `omh coder`). */
  profile: string
  kind: UseKind
  key: string
  /** `search` / `store` / `forget` (memory), `manage` / `run` / a platform (subsystem), a tool verb (kanban). */
  action: string
  /** Epoch ms. */
  at: number
}

/** One block key, as the graph and the inspector see it (the counterpart of a namespace or board node). */
export interface UseNode {
  /** Stable node, block and pin id: `<kind>:<key>`. */
  id: string
  type: 'use-node'
  kind: UseKind
  key: string
  total: number
  byProfile: Record<string, { count: number; lastUsedAt: number }>
  /** Calls per action. */
  actions: Record<string, number>
  lastUsedAt: number
  /** Newest first, at most MAX_RECENT_USES. */
  recent: Array<{ at: number; profile: string; action: string }>
}

export interface UseSessionLike {
  id: string
  label: string
}
export interface UseEventLike {
  time: number
  type: string
  payload: Record<string, unknown>
  history?: boolean
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** `mcp__hermes__supermemory_search` -> `supermemory_search`; `supermemory-search` -> `supermemory_search`. */
export function baseToolName(name: string): string {
  return name.replace(/^mcp__.+?__/, '').replace(/-/g, '_').toLowerCase()
}

/** The arguments of a call as an object: `inputData` when the relay delivered it, else the (possibly cut) JSON `args`. */
function inputOf(payload: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(payload.inputData)) return payload.inputData
  const args = str(payload.args)
  if (args !== null && args.trim().startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(args)
      if (isRecord(parsed)) return parsed
    } catch {
      // cut at the display limit: not readable, so no use
    }
  }
  return {}
}

/** The calls behind one tool_call_start: itself, or each inner call of a `tool_call` wrapper (deferred Hermes tools). */
export function innerCalls(payload: Record<string, unknown>): Array<{ name: string; input: Record<string, unknown> }> {
  const tool = str(payload.tool)
  if (tool === null) return []
  const name = baseToolName(tool)
  const input = inputOf(payload)
  if (name === 'tool_call' && Array.isArray(input.calls)) {
    const out: Array<{ name: string; input: Record<string, unknown> }> = []
    for (const c of input.calls) {
      if (!isRecord(c) || typeof c.name !== 'string') continue
      let args: unknown = c.arguments
      if (typeof args === 'string') {
        try { args = JSON.parse(args) } catch { args = {} }
      }
      out.push({ name: baseToolName(c.name), input: isRecord(args) ? args : {} })
    }
    return out
  }
  return [{ name, input }]
}

/** Container tags compare lowercase with `-` as `_` (the normalisation of supermemory-source.ts). */
export function normaliseContainerTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/-/g, '_')
}

const MEMORY_ACTIONS: Readonly<Record<string, string>> = {
  supermemory_store: 'store', supermemory_save: 'store',
  supermemory_search: 'search',
  supermemory_forget: 'forget',
}

/** Uses behind one tool call (no time, no session): what it touched and how. Pure; secrets and content never leave here. */
export function usesOfCall(call: { name: string; input: Record<string, unknown> }): Array<{ kind: UseKind; key: string; action: string }> {
  const memoryAction = MEMORY_ACTIONS[call.name]
  if (memoryAction !== undefined) {
    const raw = str(call.input.container_tag) ?? str(call.input.containerTag)
    if (raw === null) return []
    const tag = normaliseContainerTag(raw)
    // Free text is not a tag; personal-* containers are never shown here (no viewer identity in the browser).
    if (!TAG_RE.test(tag) || isPersonalTag(tag)) return []
    return [{ kind: 'memory', key: tag, action: memoryAction }]
  }
  if (call.name === 'cronjob_manage') return [{ kind: 'subsystem', key: 'cron', action: 'manage' }]
  if (call.name.startsWith('kanban_')) {
    const board = str(call.input.board)
    const verb = call.name.slice('kanban_'.length)
    if (board === null || !BOARD_RE.test(board.trim()) || !VERB_RE.test(verb)) return []
    return [{ kind: 'kanban', key: board.trim(), action: verb }]
  }
  return []
}

/**
 * `hermes [global options] kanban [--board <slug>] <verb> ...` in a shell command, as a Kanban use: board slug and verb,
 * nothing else (a task id, title, body or comment is never read out of the command).
 *
 * Rules (kept simple on purpose, this is not a shell parser; it shares the word splitter of command-head.ts):
 *   - The command is split at `|`, `||`, `&&`, `;`, `&` and newlines. The FIRST segment that is `hermes ... kanban ...` wins;
 *     later `hermes kanban` segments are not counted. `sudo`/`env`/`time`/... and `VAR=x` before `hermes`, and one level of
 *     `bash -c '...'`, are looked through. Lines after a here-doc start (`<<`) are not read.
 *   - Global options before `kanban` are skipped; a known value option (`-p taxis`, `--profile taxis`, `-m x`, ...) takes the next word.
 *   - `--board <slug>` / `--board=<slug>` counts before or after the verb (hermes wants it before). The verb is the first word
 *     after `kanban` that is not an option; `request-review` is recorded as `request_review` (the tool-name spelling).
 *   - No `--board`: NOT a use. The CLI takes the board from HERMES_KANBAN_BOARD, then the `current` symlink, then `default`, and
 *     none of that is visible in the command, so the call is attributed to no board (it stays a bash command, with its task
 *     text cut by `redactKanbanCommand`). The same for a `--board` whose value is no plain slug (`$B`, a quote, a secret) and for a
 *     verb that is not a verb.
 *   - `cut`: the text may be the hook text cut at HOOK_ARGS_MAX (`bashCommandCut`). Its last word may be incomplete, so it is
 *     dropped before anything is read (`request-review` as `request_re` is not a verb, a `--board` value cut short is no board).
 *   - `leading`: the kanban call is the command's own head (the first `hermes` segment, and `commandHead` says `hermes`). Only a
 *     leading call replaces the bash block; `git pull && hermes kanban list` keeps its `git` block and adds the Kanban use.
 * Non-kanban `hermes` commands (`hermes status`, `hermes chat`) return null.
 */
export function kanbanCliUse(command: string, opts: { cut?: boolean } = {}): { key: string; action: string; leading: boolean } | null {
  const text = textToScan(command, opts.cut === true)
  if (text === null) return null
  const found = scanForKanban(text, 0)
  const call = found.call
  if (call === null || call.board === null || call.verb === null) return null
  return { key: call.board, action: call.verb.replace(/-/g, '_'), leading: found.firstHermes === 'kanban' && commandHead(text) === 'hermes' }
}

/**
 * A command that contains a `hermes kanban` call, with that call cut down to `hermes kanban [--board <slug>] <verb>` and
 * everything after it dropped (` …`); the text before the call stays. Null when the command has no such call. This is what the
 * bash inspection may show of a kanban call that is not (or not only) a Kanban use: a task title, body, comment or id given to
 * the CLI never reaches the page. Works on calls that kanbanCliUse does not classify (no `--board`, `--board "$B"`).
 */
export function redactKanbanCommand(command: string, opts: { cut?: boolean } = {}): string | null {
  const text = textToScan(command, opts.cut === true)
  if (text === null) return null
  const found = scanForKanban(text, 0)
  const call = found.call
  if (call === null || found.segmentStart === null) return null
  const shown = `hermes kanban${call.board !== null ? ` --board ${call.board}` : ''}${call.verb !== null ? ` ${call.verb}` : ''}`
  const rest = text.slice(found.segmentStart).trim()
  return `${text.slice(0, found.segmentStart)}${shown}${rest === shown ? '' : ' …'}`
}

/** The text to scan: null when it cannot hold a kanban call; the cut hook text loses its last (possibly incomplete) word. */
function textToScan(command: string, cut: boolean): string | null {
  if (typeof command !== 'string' || !/kanban/.test(command)) return null
  return cut ? command.replace(/\S+$/, '') : command
}

interface KanbanCall {
  /** The `--board` value when it is a plain slug, else null (not given, `$B`, a secret). */
  board: string | null
  /** The verb as typed (`request-review`) when it is a plain verb, else null. */
  verb: string | null
}

interface KanbanScan {
  /** The first `hermes` segment seen: a kanban call, another command, or none. */
  firstHermes: 'kanban' | 'other' | null
  /** The first kanban call. */
  call: KanbanCall | null
  /** Offset in the scanned text where the (top-level) segment of that call starts. */
  segmentStart: number | null
}

/** Hermes global options that take a value as the next word. */
const HERMES_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-p', '--profile', '-m', '--model', '--provider', '--reasoning', '-t', '--toolsets', '--resume', '--in', '--skills',
  '-z', '--usage-file', '--cpu-profile',
])

function scanForKanban(text: string, depth: number): KanbanScan {
  const out: KanbanScan = { firstHermes: null, call: null, segmentStart: null }
  let lineStart = 0
  for (const raw of text.slice(0, SCAN_CHARS).split('\n')) {
    const offset = lineStart + (raw.length - raw.trimStart().length)
    lineStart += raw.length + 1
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    let segment: Word[] = []
    const flush = () => {
      if (segment.length > 0) {
        const found = scanSegment(segment.map(w => w.text), depth)
        // The call is cut out from the start of the segment it sits in (a nested `bash -c '...'` counts as that segment).
        if (out.call === null && found.call !== null) out.segmentStart = offset + segment[0].start
        mergeScan(out, found)
      }
      segment = []
    }
    for (const w of words(line)) {
      if (w.op) flush()
      else segment.push(w)
    }
    flush()
    if (line.includes('<<')) break
  }
  return out
}

function mergeScan(into: KanbanScan, from: KanbanScan): void {
  if (into.firstHermes === null) into.firstHermes = from.firstHermes
  if (into.call === null) into.call = from.call
}

function scanSegment(tokens: readonly string[], depth: number): KanbanScan {
  const none: KanbanScan = { firstHermes: null, call: null, segmentStart: null }
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i]
    if (ASSIGN_RE.test(t)) { i++; continue }
    const wrapper = WRAPPERS.get(t)
    if (wrapper) {
      i++
      while (i < tokens.length && tokens[i].startsWith('-')) i += wrapper.includes(tokens[i]) ? 2 : 1
      continue
    }
    break
  }
  if (i >= tokens.length) return none
  const program = tokens[i].replace(/^.*\//, '')
  if (SHELLS.has(program)) {
    const flag = tokens[i + 1]
    const inner = tokens[i + 2]
    if (depth < 1 && flag !== undefined && inner !== undefined && /^-[a-z]*c[a-z]*$/.test(flag)) return scanForKanban(inner, depth + 1)
    return none
  }
  if (program !== 'hermes') return none
  let j = i + 1
  while (j < tokens.length && tokens[j].startsWith('-')) j += !tokens[j].includes('=') && HERMES_VALUE_OPTIONS.has(tokens[j]) ? 2 : 1
  if (tokens[j] !== 'kanban') return { firstHermes: 'other', call: null, segmentStart: null }
  let board: string | null = null
  let verb: string | null = null
  for (let k = j + 1; k < tokens.length; k++) {
    const t = tokens[k]
    if (t === '--board') { board = tokens[k + 1] ?? null; k++ }
    else if (t.startsWith('--board=')) board = t.slice('--board='.length)
    else if (t.startsWith('-')) continue
    else if (verb === null) verb = t
  }
  // Only plain values are kept; a call without `--board` has no board (the CLI resolves it from the environment).
  const plainBoard = board !== null && BOARD_RE.test(board) && maskSecrets(board) === board ? board : null
  const plainVerb = verb !== null && VERB_RE.test(verb.replace(/-/g, '_')) ? verb : null
  return { firstHermes: 'kanban', call: { board: plainBoard, verb: plainVerb }, segmentStart: null }
}

/** The subsystem use of a message event (`platform` is the session's source), or null. Reads `role` and `platform` only. */
export function usesOfMessage(payload: Record<string, unknown>): { kind: 'subsystem'; key: SubsystemKey; action: string } | null {
  if (payload.role !== 'user') return null
  const platform = str(payload.platform)?.trim().toLowerCase()
  if (!platform) return null
  if (platform === 'cron') return { kind: 'subsystem', key: 'cron', action: 'run' }
  if (GATEWAY_PLATFORMS.has(platform)) return { kind: 'subsystem', key: 'gateway', action: platform }
  return null
}

interface SessionState {
  read: number
  bases: Map<string, number>
}

export interface EventUseTrackerOptions {
  /** Which kinds to collect. Default: all three. */
  kinds?: readonly UseKind[]
}

export class EventUseTracker {
  private readonly kinds: ReadonlySet<UseKind>
  private readonly sessions = new Map<string, SessionState>()
  private readonly uses = new Map<string, EventUse>()
  /** Bash calls (`<sid>|<toolUseId>`) delivered in full: a cut hook delivery of the same call is ignored. */
  private readonly fullCalls = new Set<string>()
  /** Use keys recorded from a cut hook delivery of a Bash call: the full delivery removes them and decides again. */
  private readonly cutUses = new Map<string, string[]>()
  private cache: EventUse[] = []
  private dirty = true
  private builtFor = 0

  constructor(opts: EventUseTrackerOptions = {}) {
    this.kinds = new Set(opts.kinds ?? ['memory', 'subsystem', 'kanban'])
  }

  /**
   * Read the events that arrived since the last call and return the uses, newest first. Only the sessions passed in are
   * read (a session that is not passed any more is forgotten), so a tracker given ONE session never holds another's use.
   * The same array is returned until something changed.
   */
  update(sessions: readonly UseSessionLike[], eventsOf: (sessionId: string) => readonly UseEventLike[], nowMs: number): EventUse[] {
    const ids = new Set(sessions.map(s => s.id))
    for (const sid of [...this.sessions.keys()]) if (!ids.has(sid)) this.forget(sid)
    for (const s of sessions) this.read(s, eventsOf(s.id), nowMs)
    if (!this.dirty && this.builtFor !== 0 && nowMs - this.builtFor > 60_000) this.dirty = true
    if (this.dirty) {
      this.cache = this.build(nowMs)
      this.dirty = false
      this.builtFor = nowMs
    }
    return this.cache
  }

  private forget(sid: string): void {
    this.sessions.delete(sid)
    for (const [key, u] of this.uses) if (u.sid === sid) this.uses.delete(key)
    for (const key of this.fullCalls) if (key.startsWith(`${sid}|`)) this.fullCalls.delete(key)
    for (const key of this.cutUses.keys()) if (key.startsWith(`${sid}|`)) this.cutUses.delete(key)
    this.dirty = true
  }

  private read(session: UseSessionLike, events: readonly UseEventLike[], nowMs: number): void {
    let st = this.sessions.get(session.id)
    if (st && events.length < st.read) {
      this.forget(session.id)
      st = undefined
    }
    if (!st) {
      st = { read: 0, bases: new Map() }
      this.sessions.set(session.id, st)
    }
    if (events.length === st.read) return
    const profile = identityFromLabel(session.label)
    for (let i = st.read; i < events.length; i++) {
      const e = events[i]
      const p = e.payload ?? {}
      if (e.type === 'agent_spawn') {
        const name = str(p.name)
        if (name !== null && typeof p.startedAt === 'number' && Number.isFinite(p.startedAt)) st.bases.set(name, p.startedAt)
        continue
      }
      if (e.type !== 'tool_call_start' && e.type !== 'message') continue
      const found: Array<{ kind: UseKind; key: string; action: string }> = []
      // One Claude/Hermes call can arrive twice (hook, then transcript) with the same toolUseId: it counts once.
      const callId = e.type === 'tool_call_start' ? str(p.toolUseId) : null
      let bashCall: string | null = null
      let cut = false
      if (e.type === 'tool_call_start') {
        found.push(...innerCalls(p).flatMap(usesOfCall))
        // A shell call `hermes kanban --board <slug> <verb> ...` is a Kanban action (board and verb only).
        if (p.tool === 'Bash') {
          const command = bashCommandOf(p)
          if (command !== null) {
            // The hook delivery is cut at 80 characters and may end in the middle of a word: it is a provisional
            // reading. The full delivery of the same call replaces it; a cut one that comes after a full one is ignored.
            cut = bashCommandCut(p)
            bashCall = callId !== null ? `${session.id}|${callId}` : null
            if (bashCall !== null) {
              if (cut && this.fullCalls.has(bashCall)) continue
              if (!cut) {
                this.fullCalls.add(bashCall)
                const provisional = this.cutUses.get(bashCall)
                if (provisional) {
                  for (const k of provisional) this.uses.delete(k)
                  this.cutUses.delete(bashCall)
                  this.dirty = true
                }
              }
            }
            const cli = kanbanCliUse(command, { cut })
            if (cli !== null) found.push({ kind: 'kanban', key: cli.key, action: cli.action })
          }
        }
      } else {
        const m = usesOfMessage(p)
        if (m) found.push(m)
      }
      const wanted = found.filter(f => this.kinds.has(f.kind))
      if (wanted.length === 0) continue
      const agent = str(p.agent)
      const base = agent !== null ? st.bases.get(agent) : undefined
      let at: number
      if (typeof p.at === 'number' && Number.isFinite(p.at)) at = p.at
      else if (base !== undefined && Number.isFinite(e.time)) at = base + e.time * 1000
      else if (e.history !== true) at = nowMs
      else continue
      if (nowMs - at > MAX_AGE_MS) continue
      wanted.forEach((f, n) => {
        const key = `${session.id}|${callId ?? `#${i}`}|${n}`
        if (this.uses.has(key)) return
        this.uses.set(key, { sid: session.id, profile, kind: f.kind, key: f.key, action: f.action, at })
        if (cut && bashCall !== null) this.cutUses.set(bashCall, [...(this.cutUses.get(bashCall) ?? []), key])
        this.dirty = true
      })
    }
    st.read = events.length
    while (this.uses.size > MAX_USES) {
      const oldest = this.uses.keys().next().value
      if (oldest === undefined) break
      this.uses.delete(oldest)
    }
    for (const bookkeeping of [this.fullCalls, this.cutUses] as Array<Set<string> | Map<string, string[]>>) {
      while (bookkeeping.size > MAX_USES) {
        const oldest = bookkeeping.keys().next().value
        if (oldest === undefined) break
        bookkeeping.delete(oldest)
      }
    }
  }

  private build(nowMs: number): EventUse[] {
    const out: EventUse[] = []
    for (const [key, u] of this.uses) {
      if (nowMs - u.at > MAX_AGE_MS) this.uses.delete(key)
      else out.push(u)
    }
    return out.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key))
  }
}

export function useNodeId(kind: UseKind, key: string): string {
  return blockId(kind, key)
}

/** Group the uses of one kind into nodes (one per key), newest use first. */
export function buildUseNodes(uses: readonly EventUse[], kind: UseKind): UseNode[] {
  const byKey = new Map<string, EventUse[]>()
  for (const u of uses) {
    if (u.kind !== kind) continue
    const list = byKey.get(u.key)
    if (list) list.push(u)
    else byKey.set(u.key, [u])
  }
  const nodes: UseNode[] = []
  for (const [key, list] of byKey) {
    const byProfile: UseNode['byProfile'] = {}
    const actions: Record<string, number> = {}
    for (const u of list) {
      const cur = byProfile[u.profile]
      byProfile[u.profile] = { count: (cur?.count ?? 0) + 1, lastUsedAt: Math.max(cur?.lastUsedAt ?? 0, u.at) }
      actions[u.action] = (actions[u.action] ?? 0) + 1
    }
    const recent = [...list]
      .sort((a, b) => b.at - a.at || a.profile.localeCompare(b.profile))
      .slice(0, MAX_RECENT_USES)
      .map(u => ({ at: u.at, profile: u.profile, action: u.action }))
    nodes.push({ id: useNodeId(kind, key), type: 'use-node', kind, key, total: list.length, byProfile, actions, lastUsedAt: recent[0].at, recent })
  }
  nodes.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.key.localeCompare(b.key))
  return nodes.slice(0, MAX_USE_NODES)
}

/**
 * The block of each node: `lastUsedAt` is the newest use by a profile for which `include` is true (the profiles whose
 * cloud is on the map), `useCount` their uses, `agents` those profiles. A node without such a use has no block.
 */
export function buildUseBlocks(nodes: readonly UseNode[] | undefined, include: (profile: string) => boolean = () => true): BlockStore {
  const store = new Map<string, ResourceBlock>()
  for (const node of nodes ?? []) {
    let last = -Infinity
    let count = 0
    const agents: string[] = []
    const agentLast: Record<string, number> = {}
    for (const [profile, u] of Object.entries(node.byProfile)) {
      if (!include(profile)) continue
      last = Math.max(last, u.lastUsedAt)
      count += u.count
      agents.push(profile)
      agentLast[profile] = u.lastUsedAt
    }
    if (agents.length === 0 || !Number.isFinite(last)) continue
    store.set(node.id, { kind: node.kind, key: node.key, label: node.key, lastUsedAt: last, useCount: count, agents, agentLast })
  }
  return store
}

/** Second line of a block: memory "2 search · 1 store"; others "matrix ×3 · cron ×1" or "3 events". No content. */
export function useCountsLine(node: UseNode): string {
  if (node.kind === 'memory') {
    const parts = (['store', 'search', 'forget'] as const).filter(a => (node.actions[a] ?? 0) > 0).map(a => `${node.actions[a]} ${a}`)
    return parts.length > 0 ? parts.join(' · ') : 'no calls'
  }
  const entries = Object.entries(node.actions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (node.kind === 'subsystem' && node.key === 'gateway') {
    return entries.slice(0, 3).map(([k, n]) => `${k} ×${n}`).join(' · ') || 'no events'
  }
  return `${node.total} ${node.total === 1 ? 'event' : 'events'}`
}
