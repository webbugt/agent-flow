/**
 * Bash resource blocks of the Fleet map: one block per command HEAD (`git`, `pnpm`, `hermes`), lit while an
 * agent runs a command with that head, then fading (the `bash` linger of the options, default 20 s; a pin keeps it).
 *
 * CONTENT RULES (binding decision 3):
 *   - The VISUAL block carries the head only (command-head.ts). `BashHeadNode.head`, the label and the counts line
 *     are the only things the map draws.
 *   - The INSPECTOR shows the full command text. It is masked (secret-mask.ts) when the tracker takes it in, so the
 *     raw text is never held here: no unmasked command can reach a component, the inspector or a test snapshot.
 *   - An anonymized profile delivers `git · 42 chars` instead of the command (content-privacy.ts); that label is
 *     shown as it is. Nothing here undoes the relay's privacy policy.
 *
 * Where the commands come from (T0 spike section 2): the buffered session events the page already holds. A Bash
 * call is a `tool_call_start` with `payload.tool === 'Bash'`; Hermes' `terminal` and `execute_code` both arrive
 * under that name (hermes-logs.ts). The text is `payload.inputData.command` (Hermes state.db and the Claude transcript
 * parser: the full command), else `payload.args` (the Claude hook path: the first 80 characters). One Claude call
 * arrives twice (hook, then transcript) with the same `toolUseId`: it counts once, and the longer text wins.
 * Wall-clock time of a call: `payload.at` (Hermes), else the node's time base (`startedAt` of its spawn event)
 * plus `time`, else, for a live event, the moment the page first sees it. Replayed history without a time is skipped.
 *
 * The tracker is incremental (it keeps how many events of each buffer it has read), so a poll or a clock tick does
 * not rescan thousands of events.
 */
import { MAX_FADE_SECONDS, MAX_LINGER_SECONDS } from './options-registry'
import { blockId, type BlockStore, type ResourceBlock } from './resource-block'
import { bashCommandOf, commandHead } from './command-head'
import { kanbanCliUse } from './event-uses'
import { maskSecrets } from './secret-mask'
import { identityFromLabel } from './fleet-model'

/** Commands kept per head for the inspector, newest first. */
export const MAX_RECENT_COMMANDS = 30
/** Characters of one command kept (after masking). */
export const MAX_COMMAND_CHARS = 4000
/** Heads kept at all; the least recently used go first. */
export const MAX_HEADS = 200
/** Uses kept in total (all heads), oldest dropped first. */
const MAX_USES = 3000
/** Uses older than the longest possible linger + fade can never be drawn again. */
const MAX_AGE_MS = (MAX_LINGER_SECONDS + MAX_FADE_SECONDS) * 1000

export interface BashRecentUse {
  /** Epoch ms. */
  at: number
  /** Profile identity (`taxis`, `omh coder`). */
  profile: string
  /** The command as the page may show it: masked, capped. */
  command: string
}

/** One command head, as the graph and the inspector see it (the Bash counterpart of a Supermemory namespace node). */
export interface BashHeadNode {
  /** Stable node id and block id, `bash:<head>`. */
  id: string
  type: 'bash-head'
  head: string
  total: number
  /** Per profile identity: how many calls and when the newest was. */
  byProfile: Record<string, { count: number; lastUsedAt: number }>
  /** Epoch ms of the newest call. */
  lastUsedAt: number
  /** Newest first, at most MAX_RECENT_COMMANDS. */
  recent: BashRecentUse[]
}

export function bashBlockId(head: string): string {
  return blockId('bash', head)
}

/** Minimal shape of a bridge session and of its buffered events (see fleet-model SessionLike / SessionEventLike). */
export interface BashSessionLike {
  id: string
  label: string
}
export interface BashEventLike {
  time: number
  type: string
  payload: Record<string, unknown>
  history?: boolean
}

interface UseRec {
  sid: string
  profile: string
  head: string
  at: number
  /** Masked and capped. */
  command: string
}

interface SessionState {
  /** Events of the buffer already read. */
  read: number
  /** Epoch-ms time base per agent name, from the spawn events. */
  bases: Map<string, number>
  /** Calls without a toolUseId, to give them a stable key. */
  anonymous: number
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function maskAndCap(raw: string): string {
  const masked = maskSecrets(raw.slice(0, MAX_COMMAND_CHARS + 256))
  return masked.length > MAX_COMMAND_CHARS ? `${masked.slice(0, MAX_COMMAND_CHARS)}…` : masked
}

export { bashCommandOf }

export class BashUseTracker {
  private readonly sessions = new Map<string, SessionState>()
  private readonly uses = new Map<string, UseRec>()
  /** Keys of calls left out because they are `hermes kanban` calls (no command text kept). */
  private readonly kanbanCalls = new Set<string>()
  private cache: BashHeadNode[] = []
  private dirty = true
  private builtFor = 0

  /**
   * Read the events that arrived since the last call and return the head nodes, newest use first. `nowMs` is the
   * page clock (it dates live events that carry no time, and drops uses that can never show again). The same
   * array is returned until something changed.
   */
  update(sessions: readonly BashSessionLike[], eventsOf: (sessionId: string) => readonly BashEventLike[], nowMs: number): BashHeadNode[] {
    const ids = new Set(sessions.map(s => s.id))
    for (const sid of [...this.sessions.keys()]) {
      if (!ids.has(sid)) this.forget(sid)
    }
    for (const s of sessions) this.read(s, eventsOf(s.id), nowMs)
    // Age out once the visible window of the oldest kept use has passed.
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
    for (const key of this.kanbanCalls) if (key.startsWith(`${sid}|`)) this.kanbanCalls.delete(key)
    this.dirty = true
  }

  private read(session: BashSessionLike, events: readonly BashEventLike[], nowMs: number): void {
    let st = this.sessions.get(session.id)
    // A shorter buffer means it was reset (relay restart, panel reopened): start over.
    if (st && events.length < st.read) {
      this.forget(session.id)
      st = undefined
    }
    if (!st) {
      st = { read: 0, bases: new Map(), anonymous: 0 }
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
      if (e.type !== 'tool_call_start' || p.tool !== 'Bash') continue
      const command = bashCommandOf(p)
      if (command === null) continue
      const agent = str(p.agent)
      const base = agent !== null ? st.bases.get(agent) : undefined
      let at: number
      if (typeof p.at === 'number' && Number.isFinite(p.at)) at = p.at
      else if (base !== undefined && Number.isFinite(e.time)) at = base + e.time * 1000
      else if (e.history !== true) at = nowMs
      else continue
      if (nowMs - at > MAX_AGE_MS) continue
      const toolUseId = str(p.toolUseId)
      const key = toolUseId ? `${session.id}|${toolUseId}` : `${session.id}|#${st.anonymous++}`
      // A `hermes kanban ...` call is a Kanban action (EventUseTracker records it), not a bash block. The ids of a
      // suppressed call are remembered, so the other delivery of the same call (hook / transcript, one of them cut
      // at 80 characters) cannot slip in as a `hermes` use.
      if (this.kanbanCalls.has(key)) continue
      const cli = kanbanCliUse(command)
      if (cli !== null && cli.leading) {
        this.kanbanCalls.add(key)
        this.uses.delete(key)
        this.dirty = true
        continue
      }
      const masked = maskAndCap(command)
      const prev = this.uses.get(key)
      if (prev) {
        // The second report of the same call (hook, then transcript): the longer text wins, the call counts once.
        if (masked.length > prev.command.length) {
          prev.command = masked
          this.dirty = true
        }
        continue
      }
      this.uses.set(key, { sid: session.id, profile, head: commandHead(command), at, command: masked })
      this.dirty = true
    }
    st.read = events.length
    // Bound memory: the oldest uses first.
    while (this.uses.size > MAX_USES) {
      const oldest = this.uses.keys().next().value
      if (oldest === undefined) break
      this.uses.delete(oldest)
    }
    while (this.kanbanCalls.size > MAX_USES) {
      const oldest = this.kanbanCalls.values().next().value
      if (oldest === undefined) break
      this.kanbanCalls.delete(oldest)
    }
  }

  private build(nowMs: number): BashHeadNode[] {
    const byHead = new Map<string, UseRec[]>()
    for (const [key, u] of this.uses) {
      if (nowMs - u.at > MAX_AGE_MS) {
        this.uses.delete(key)
        continue
      }
      const list = byHead.get(u.head)
      if (list) list.push(u)
      else byHead.set(u.head, [u])
    }
    const nodes: BashHeadNode[] = []
    for (const [head, list] of byHead) {
      const byProfile: BashHeadNode['byProfile'] = {}
      for (const u of list) {
        const cur = byProfile[u.profile]
        byProfile[u.profile] = { count: (cur?.count ?? 0) + 1, lastUsedAt: Math.max(cur?.lastUsedAt ?? 0, u.at) }
      }
      const recent = [...list]
        .sort((a, b) => b.at - a.at || a.profile.localeCompare(b.profile))
        .slice(0, MAX_RECENT_COMMANDS)
        .map(u => ({ at: u.at, profile: u.profile, command: u.command }))
      nodes.push({ id: bashBlockId(head), type: 'bash-head', head, total: list.length, byProfile, lastUsedAt: recent[0].at, recent })
    }
    nodes.sort((a, b) => b.lastUsedAt - a.lastUsedAt || a.head.localeCompare(b.head))
    return nodes.slice(0, MAX_HEADS)
  }
}

/**
 * The bash block of each head: `lastUsedAt` is the newest call by a profile for which `include` is true (the profiles
 * whose cloud is on the map), `useCount` their calls, `agents` those profiles. A head without such a call has no block.
 */
export function buildBashBlocks(nodes: readonly BashHeadNode[] | undefined, include: (profile: string) => boolean = () => true): BlockStore {
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
    store.set(bashBlockId(node.head), { kind: 'bash', key: node.head, label: node.head, lastUsedAt: last, useCount: count, agents, agentLast })
  }
  return store
}

/** Second line of the block: the number of calls ("3 calls"). No command text. */
export function bashCountsLine(count: number): string {
  return `${count} call${count === 1 ? '' : 's'}`
}
