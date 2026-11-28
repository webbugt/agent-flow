/**
 * Synthetic event source of the /demo route: a pure reducer (no React, no DOM, no clock, no Math.random).
 *
 * The demo owns its own data. It never reads or writes live sessions, the relay or the event stream
 * (isolation guard: demo-isolation.test.ts). Each action returns a NEW state; an action that cannot apply
 * (unknown session, nothing to return, bad key) returns the SAME state object, so callers can tell.
 *
 * What the state holds, and how the visualiser sees it (the same shapes the live bridge delivers):
 *   - one bridge SESSION per Hermes profile (`demo-<profile>`, label `<profile> · demo`), with its buffered
 *     events (`events[sessionId]`, append only);
 *   - inside a session, agent NODES: a session node per "session start", subagent nodes below them;
 *   - a registry of RESOURCES (Kanban board, Supermemory container, Bash command head, Hermes subsystem). A use
 *     of a resource is a tool call (or a gateway message) that the visualiser's own readers (event-uses.ts,
 *     bash-blocks.ts) turn into a block, plus, for Kanban and Supermemory, a node in `kanban` / `supermemory`
 *     (the Fleet map reads those two kinds from /api/fleet in live mode, from here in the demo).
 *
 * Content rules of the live readers apply: a resource carries a name only (board slug, container tag, command
 * head, subsystem), never task text or memory content.
 */
import type { SimulationEvent } from '@/lib/agent-types'
import type { SessionInfo } from '@/lib/bridge-types'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import type { SupermemoryAction, SupermemoryNamespaceNode } from '@/lib/fleet/supermemory-source'
import type { DemoSources } from './demo-feed'
import { BOARD_RE, SUBSYSTEM_KEYS, normaliseContainerTag, usesOfCall } from '@/lib/fleet/event-uses'
import { commandHead } from '@/lib/fleet/command-head'
import { RESOURCE_KINDS, isResourceKind, type ResourceKind } from '@/lib/fleet/options-registry'

export { RESOURCE_KINDS }
export type { ResourceKind }

/** Profile names the demo accepts: lower case words (the label's identity is the first word before ` · `). */
export const PROFILE_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/
/** Tool names the demo fires. */
export const TOOL_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,39}$/
export const MAX_ARGS_CHARS = 200
export const DEMO_MODEL = 'demo-model'
export const DEMO_SESSION_PREFIX = 'demo-'

export type SupermemoryCall = SupermemoryAction

export interface DemoNode {
  /** Agent node name (the id of the node in the simulation). */
  name: string
  /** `session`: started by "session start"; `subagent`: dispatched by another node. */
  kind: 'session' | 'subagent'
  /** The node that dispatched it (subagent), or null. */
  parent: string | null
  /** Epoch ms: time base of the node's event times (seconds since it). */
  startedAt: number
  status: 'active' | 'done'
  /** Tool calls started and not returned yet, oldest first. */
  open: Array<{ toolUseId: string; tool: string }>
  /** Subagents dispatched by this node so far (names the next one). */
  subagents: number
}

export interface DemoSession extends SessionInfo {
  profile: string
  nodes: DemoNode[]
}

export interface DemoResource {
  kind: ResourceKind
  key: string
}

export interface DemoState {
  /** Counts what was created (tool call ids, node names, board event ids): the same actions give the same state. */
  seq: number
  sessions: DemoSession[]
  /** Buffered events per session id. Append only (the readers keep how many events they have read). */
  events: Readonly<Record<string, readonly SimulationEvent[]>>
  resources: DemoResource[]
  /** Kanban boards and Supermemory namespaces of the registered resources, the shape /api/fleet delivers in live mode. */
  kanban: PublicKanbanBoardNode[]
  supermemory: SupermemoryNamespaceNode[]
}

export type DemoAction =
  /** A new agent node ("session") of a profile; creates the profile's bridge session on first use. */
  | { type: 'session_start'; profile: string; task?: string }
  | { type: 'tool_call'; sessionId: string; node?: string; tool: string; args?: string }
  /** Ends the oldest open tool call of the node. */
  | { type: 'tool_return'; sessionId: string; node?: string; isError?: boolean }
  /** The node finishes. When it was the last active node, the profile's session completes. */
  | { type: 'done'; sessionId: string; node?: string }
  | { type: 'permission_wait'; sessionId: string; node?: string }
  /** The node dispatches a subagent (a new child node). */
  | { type: 'subagent_dispatch'; sessionId: string; node?: string; task?: string }
  /** The node's newest active subagent returns and finishes. */
  | { type: 'subagent_return'; sessionId: string; node?: string }
  /** Register a resource; with a session, that session also uses it once. */
  | { type: 'resource_add'; kind: ResourceKind; key: string; sessionId?: string; node?: string; call?: SupermemoryCall }
  /** A session node uses a registered resource (one tool call and its return). */
  | { type: 'resource_use'; sessionId: string; node?: string; kind: ResourceKind; key: string; call?: SupermemoryCall }
  /** Unregister a resource. Kanban and Supermemory nodes go at once; blocks already drawn fade by their own linger. */
  | { type: 'resource_remove'; kind: ResourceKind; key: string }
  | { type: 'reset' }

export function createDemoState(): DemoState {
  return { seq: 0, sessions: [], events: {}, resources: [], kanban: [], supermemory: [] }
}

export function demoSessionId(profile: string): string {
  return `${DEMO_SESSION_PREFIX}${profile}`
}

export function demoSessionLabel(profile: string): string {
  return `${profile} · demo`
}

/** The profile name in canonical form (trimmed, lower case), or null when it is not usable. */
export function normaliseProfile(name: string): string | null {
  if (typeof name !== 'string') return null
  const p = name.trim().toLowerCase()
  return PROFILE_RE.test(p) ? p : null
}

/**
 * The key of a resource in canonical form, or null when the live readers would not accept it:
 * a Kanban board slug, a Supermemory container tag (not `personal*`), a command head, `cron` or `gateway`.
 */
export function normaliseResourceKey(kind: ResourceKind, key: string): string | null {
  if (!isResourceKind(kind) || typeof key !== 'string') return null
  const k = key.trim()
  switch (kind) {
    case 'kanban':
      return BOARD_RE.test(k) ? k : null
    case 'memory': {
      const tag = normaliseContainerTag(k)
      // The same check the tool-call reader makes, so a key that passes here is also drawn.
      const uses = usesOfCall({ name: 'supermemory_search', input: { container_tag: tag } })
      return uses.length === 1 && uses[0].key === tag ? tag : null
    }
    case 'bash': {
      const head = k.toLowerCase()
      return /^[a-z][a-z0-9._-]{0,30}$/.test(head) && commandHead(`${head} status`) === head ? head : null
    }
    case 'subsystem': {
      const s = k.toLowerCase()
      return (SUBSYSTEM_KEYS as readonly string[]).includes(s) ? s : null
    }
  }
}

export function sessionOf(state: DemoState, sessionId: string): DemoSession | undefined {
  return state.sessions.find(s => s.id === sessionId)
}

/** The node an action addresses: the named one when active, else the newest active session node (then the newest active node). */
export function activeNode(session: DemoSession, name?: string): DemoNode | undefined {
  if (name !== undefined) {
    const n = session.nodes.find(x => x.name === name)
    return n && n.status === 'active' ? n : undefined
  }
  const active = session.nodes.filter(n => n.status === 'active')
  for (let i = active.length - 1; i >= 0; i--) if (active[i].kind === 'session') return active[i]
  return active[active.length - 1]
}

/** Default arguments of the tools the panel offers. */
export function defaultArgs(tool: string, seq: number): string {
  switch (tool) {
    case 'Read': return `src/demo-${seq}.ts`
    case 'Edit': return `src/demo-${seq}.ts`
    case 'Bash': return `pnpm test ${seq}`
    case 'Grep': return `TODO src/`
    default: return ''
  }
}

function inputDataOf(tool: string, args: string): Record<string, unknown> {
  if (tool === 'Bash') return { command: args }
  if (tool === 'Read' || tool === 'Edit' || tool === 'Write') return { file_path: args }
  return {}
}

// ─── event building ─────────────────────────────────────────────────────────

function elapsed(node: DemoNode, now: number): number {
  return Math.max(0, (now - node.startedAt) / 1000)
}

function withEvents(state: DemoState, sessionId: string, add: readonly SimulationEvent[]): DemoState['events'] {
  return { ...state.events, [sessionId]: [...(state.events[sessionId] ?? []), ...add] }
}

function replaceSession(state: DemoState, next: DemoSession): DemoSession[] {
  return state.sessions.map(s => (s.id === next.id ? next : s))
}

function replaceNode(session: DemoSession, next: DemoNode, now: number): DemoSession {
  return { ...session, lastActivityTime: now, nodes: session.nodes.map(n => (n.name === next.name ? next : n)) }
}

function mainSpawn(profile: string, sessionId: string): SimulationEvent {
  return {
    time: 0, type: 'agent_spawn', sessionId,
    payload: { name: profile, isMain: true, profile, group: profile, task: `Hermes profile ${profile}` },
  }
}

function nodeSpawn(session: DemoSession, node: DemoNode, task: string): SimulationEvent {
  return {
    time: 0, type: 'agent_spawn', sessionId: session.id,
    payload: {
      name: node.name, parent: node.parent ?? session.profile, group: session.profile, profile: session.profile,
      startedAt: node.startedAt, task, model: DEMO_MODEL,
    },
  }
}

// ─── reducer ────────────────────────────────────────────────────────────────

/** Apply one action at time `now` (epoch ms). Pure. Returns the same `state` object when nothing changed. */
export function applyDemoAction(state: DemoState, action: DemoAction, now: number): DemoState {
  switch (action.type) {
    case 'reset':
      return createDemoState()
    case 'session_start':
      return sessionStart(state, action, now)
    case 'tool_call':
      return toolCall(state, action, now)
    case 'tool_return':
      return toolReturn(state, action, now)
    case 'done':
      return done(state, action, now)
    case 'permission_wait':
      return permissionWait(state, action, now)
    case 'subagent_dispatch':
      return subagentDispatch(state, action, now)
    case 'subagent_return':
      return subagentReturn(state, action, now)
    case 'resource_add':
      return resourceAdd(state, action, now)
    case 'resource_use':
      return resourceUse(state, action, now)
    case 'resource_remove':
      return resourceRemove(state, action)
    default:
      return state
  }
}

function sessionStart(state: DemoState, action: Extract<DemoAction, { type: 'session_start' }>, now: number): DemoState {
  const profile = normaliseProfile(action.profile)
  if (profile === null) return state
  const id = demoSessionId(profile)
  const existing = sessionOf(state, id)
  const sessionNodes = existing ? existing.nodes.filter(n => n.kind === 'session').length : 0
  const node: DemoNode = {
    name: `${profile} s${sessionNodes + 1}`, kind: 'session', parent: null,
    startedAt: now, status: 'active', open: [], subagents: 0,
  }
  const task = (action.task ?? '').trim().slice(0, MAX_ARGS_CHARS) || `Demo session ${sessionNodes + 1} of ${profile}`
  const base: DemoSession = existing ?? {
    id, label: demoSessionLabel(profile), status: 'active', startTime: now, lastActivityTime: now, profile, nodes: [],
  }
  const wasCompleted = existing !== undefined && existing.status === 'completed'
  const session: DemoSession = { ...base, status: 'active', lastActivityTime: now, nodes: [...base.nodes, node] }
  const add: SimulationEvent[] = []
  // The profile's main node is announced once, and again when the profile comes back after it completed.
  if (!existing || wasCompleted) add.push(mainSpawn(profile, id))
  add.push(nodeSpawn(session, node, task))
  return {
    ...state,
    seq: state.seq + 1,
    sessions: existing ? replaceSession(state, session) : [...state.sessions, session],
    events: withEvents(state, id, add),
  }
}

/** Resolve session and active node of an action, or null. */
function target(state: DemoState, sessionId: string, nodeName?: string): { session: DemoSession; node: DemoNode } | null {
  const session = sessionOf(state, sessionId)
  if (!session) return null
  const node = activeNode(session, nodeName)
  return node ? { session, node } : null
}

function toolCallEvents(session: DemoSession, node: DemoNode, tool: string, toolUseId: string, args: string, inputData: Record<string, unknown>, now: number): SimulationEvent {
  return {
    time: elapsed(node, now), type: 'tool_call_start', sessionId: session.id,
    payload: { agent: node.name, tool, toolUseId, args, inputData, at: now },
  }
}

function toolReturnEvent(session: DemoSession, node: DemoNode, tool: string, toolUseId: string, isError: boolean, now: number): SimulationEvent {
  return {
    time: elapsed(node, now), type: 'tool_call_end', sessionId: session.id,
    payload: { agent: node.name, tool, toolUseId, result: isError ? 'failed (demo)' : 'ok', isError, at: now },
  }
}

function toolCall(state: DemoState, action: Extract<DemoAction, { type: 'tool_call' }>, now: number): DemoState {
  const t = target(state, action.sessionId, action.node)
  if (!t || typeof action.tool !== 'string' || !TOOL_RE.test(action.tool)) return state
  const { session, node } = t
  const args = (action.args ?? '').trim().slice(0, MAX_ARGS_CHARS) || defaultArgs(action.tool, state.seq + 1)
  const toolUseId = `${session.id}-${node.name}-c${state.seq + 1}`
  const ev = toolCallEvents(session, node, action.tool, toolUseId, args, inputDataOf(action.tool, args), now)
  const next: DemoNode = { ...node, open: [...node.open, { toolUseId, tool: action.tool }] }
  return {
    ...state,
    seq: state.seq + 1,
    sessions: replaceSession(state, replaceNode(session, next, now)),
    events: withEvents(state, session.id, [ev]),
  }
}

function toolReturn(state: DemoState, action: Extract<DemoAction, { type: 'tool_return' }>, now: number): DemoState {
  // An open call is needed: with the node addressed or not, the newest active node that has one.
  let t = target(state, action.sessionId, action.node)
  if (t && t.node.open.length === 0 && action.node === undefined) {
    const session = t.session
    const withOpen = [...session.nodes].reverse().find(n => n.status === 'active' && n.open.length > 0)
    t = withOpen ? { session, node: withOpen } : null
  }
  if (!t || t.node.open.length === 0) return state
  const { session, node } = t
  const [call, ...rest] = node.open
  const ev = toolReturnEvent(session, node, call.tool, call.toolUseId, action.isError === true, now)
  return {
    ...state,
    sessions: replaceSession(state, replaceNode(session, { ...node, open: rest }, now)),
    events: withEvents(state, session.id, [ev]),
  }
}

function done(state: DemoState, action: Extract<DemoAction, { type: 'done' }>, now: number): DemoState {
  const t = target(state, action.sessionId, action.node)
  if (!t) return state
  const { session, node } = t
  const finished = replaceNode(session, { ...node, status: 'done', open: [] }, now)
  const add: SimulationEvent[] = [{ time: elapsed(node, now), type: 'agent_complete', sessionId: session.id, payload: { name: node.name } }]
  // Children of a finished node finish with it (the simulation does the same), so the session has no active node left then.
  const ended = finished.nodes.map(n => (n.parent === node.name && n.status === 'active' ? { ...n, status: 'done' as const, open: [] } : n))
  const last: DemoSession = { ...finished, nodes: ended }
  if (!last.nodes.some(n => n.status === 'active')) {
    last.status = 'completed'
    add.push({ time: 0, type: 'agent_complete', sessionId: session.id, payload: { name: session.profile } })
  }
  return { ...state, sessions: replaceSession(state, last), events: withEvents(state, session.id, add) }
}

function permissionWait(state: DemoState, action: Extract<DemoAction, { type: 'permission_wait' }>, now: number): DemoState {
  const t = target(state, action.sessionId, action.node)
  if (!t) return state
  const { session, node } = t
  const ev: SimulationEvent = {
    time: elapsed(node, now), type: 'permission_requested', sessionId: session.id,
    payload: { agent: node.name, at: now },
  }
  return {
    ...state,
    sessions: replaceSession(state, replaceNode(session, node, now)),
    events: withEvents(state, session.id, [ev]),
  }
}

function subagentDispatch(state: DemoState, action: Extract<DemoAction, { type: 'subagent_dispatch' }>, now: number): DemoState {
  const t = target(state, action.sessionId, action.node)
  if (!t) return state
  const { session, node } = t
  const child: DemoNode = {
    name: `${node.name} › sub${node.subagents + 1}`, kind: 'subagent', parent: node.name,
    startedAt: now, status: 'active', open: [], subagents: 0,
  }
  const task = (action.task ?? '').trim().slice(0, MAX_ARGS_CHARS) || `Demo subtask ${node.subagents + 1}`
  const parentNext: DemoNode = { ...node, subagents: node.subagents + 1 }
  const nextSession: DemoSession = {
    ...session, lastActivityTime: now,
    nodes: [...session.nodes.map(n => (n.name === node.name ? parentNext : n)), child],
  }
  const add: SimulationEvent[] = [
    nodeSpawn(nextSession, child, task),
    { time: elapsed(node, now), type: 'subagent_dispatch', sessionId: session.id, payload: { parent: node.name, child: child.name, task } },
  ]
  return { ...state, seq: state.seq + 1, sessions: replaceSession(state, nextSession), events: withEvents(state, session.id, add) }
}

function subagentReturn(state: DemoState, action: Extract<DemoAction, { type: 'subagent_return' }>, now: number): DemoState {
  const t = target(state, action.sessionId, action.node)
  if (!t) return state
  const { session, node } = t
  const child = [...session.nodes].reverse().find(n => n.parent === node.name && n.status === 'active')
  if (!child) return state
  const nextSession: DemoSession = {
    ...session, lastActivityTime: now,
    nodes: session.nodes.map(n => (n.name === child.name ? { ...n, status: 'done' as const, open: [] } : n)),
  }
  const add: SimulationEvent[] = [
    { time: elapsed(node, now), type: 'subagent_return', sessionId: session.id, payload: { parent: node.name, child: child.name, summary: `${child.name} finished (demo)` } },
    { time: elapsed(child, now), type: 'agent_complete', sessionId: session.id, payload: { name: child.name } },
  ]
  return { ...state, sessions: replaceSession(state, nextSession), events: withEvents(state, session.id, add) }
}

// ─── resources ──────────────────────────────────────────────────────────────

const KANBAN_EVENT_KINDS = ['claimed', 'completed', 'heartbeat'] as const

function hasResource(state: DemoState, kind: ResourceKind, key: string): boolean {
  return state.resources.some(r => r.kind === kind && r.key === key)
}

function emptyKanbanBoard(slug: string): PublicKanbanBoardNode {
  return {
    id: `kanban:${slug}`, type: 'kanban-board', slug, name: slug, description: '', archived: false,
    taskCounts: { running: 0, done: 0 }, totalTasks: 0, recentEvents: [], lastEventAt: null,
  } as PublicKanbanBoardNode
}

function emptyNamespace(tag: string): SupermemoryNamespaceNode {
  return {
    id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag,
    counts: { store: 0, search: 0, forget: 0 }, total: 0, byProfile: {}, daily: [], lastEventAt: null, lastByProfile: {}, recent: [],
  }
}

/** The board after one more event by `profile` (kind cycles claimed / completed / heartbeat by `seq`). */
function boardWithEvent(board: PublicKanbanBoardNode, profile: string, now: number, seq: number): PublicKanbanBoardNode {
  const id = Math.max(0, ...board.recentEvents.map(e => e.id)) + 1
  const kind = KANBAN_EVENT_KINDS[seq % KANBAN_EVENT_KINDS.length]
  const recentEvents = [
    { id, taskId: `t_demo${id}`, taskTitle: `Demo task ${id}`, assignee: profile, kind, runId: null, at: now },
    ...board.recentEvents,
  ]
  const done = recentEvents.filter(e => e.kind === 'completed').length
  const running = recentEvents.some(e => e.kind === 'claimed') ? 1 : 0
  return { ...board, recentEvents, lastEventAt: now, totalTasks: recentEvents.length, taskCounts: { running, done } }
}

function namespaceWithCall(space: SupermemoryNamespaceNode, profile: string, action: SupermemoryAction, now: number): SupermemoryNamespaceNode {
  const own = space.byProfile[profile] ?? { store: 0, search: 0, forget: 0 }
  return {
    ...space,
    counts: { ...space.counts, [action]: space.counts[action] + 1 },
    total: space.total + 1,
    byProfile: { ...space.byProfile, [profile]: { ...own, [action]: own[action] + 1 } },
    lastEventAt: now,
    lastByProfile: { ...space.lastByProfile, [profile]: now },
    recent: [{ at: now, profile, action }, ...space.recent],
  }
}

function resourceAdd(state: DemoState, action: Extract<DemoAction, { type: 'resource_add' }>, now: number): DemoState {
  const key = normaliseResourceKey(action.kind, action.key)
  if (key === null) return state
  // With a session the add also uses the resource: say first whether that is possible, so a failed add changes nothing.
  if (action.sessionId !== undefined && !target(state, action.sessionId, action.node)) return state
  let next = state
  if (!hasResource(state, action.kind, key)) {
    next = {
      ...state,
      resources: [...state.resources, { kind: action.kind, key }],
      kanban: action.kind === 'kanban' ? [...state.kanban, emptyKanbanBoard(key)] : state.kanban,
      supermemory: action.kind === 'memory' ? [...state.supermemory, emptyNamespace(key)] : state.supermemory,
    }
  } else if (action.sessionId === undefined) {
    return state
  }
  if (action.sessionId === undefined) return next
  return resourceUse(next, { type: 'resource_use', sessionId: action.sessionId, node: action.node, kind: action.kind, key, call: action.call }, now)
}

function resourceUse(state: DemoState, action: Extract<DemoAction, { type: 'resource_use' }>, now: number): DemoState {
  const key = normaliseResourceKey(action.kind, action.key)
  if (key === null || !hasResource(state, action.kind, key)) return state
  const t = target(state, action.sessionId, action.node)
  if (!t) return state
  const { session, node } = t
  const callId = `${session.id}-${node.name}-r${state.seq + 1}`
  const add: SimulationEvent[] = []
  let kanban = state.kanban
  let supermemory = state.supermemory

  switch (action.kind) {
    case 'kanban': {
      const args = JSON.stringify({ board: key })
      add.push(toolCallEvents(session, node, 'kanban_show', callId, args, { board: key }, now))
      add.push(toolReturnEvent(session, node, 'kanban_show', callId, false, now))
      kanban = kanban.map(b => (b.slug === key ? boardWithEvent(b, session.profile, now, state.seq) : b))
      break
    }
    case 'memory': {
      const call: SupermemoryAction = action.call === 'store' || action.call === 'forget' ? action.call : 'search'
      const tool = `supermemory_${call}`
      // The tag only: no query, no content (the live reader would drop them anyway).
      const args = JSON.stringify({ container_tag: key })
      add.push(toolCallEvents(session, node, tool, callId, args, { container_tag: key }, now))
      add.push(toolReturnEvent(session, node, tool, callId, false, now))
      supermemory = supermemory.map(n => (n.containerTag === key ? namespaceWithCall(n, session.profile, call, now) : n))
      break
    }
    case 'bash': {
      const command = `${key} status`
      add.push(toolCallEvents(session, node, 'Bash', callId, command, { command }, now))
      add.push(toolReturnEvent(session, node, 'Bash', callId, false, now))
      break
    }
    case 'subsystem': {
      if (key === 'cron') {
        add.push(toolCallEvents(session, node, 'cronjob_manage', callId, JSON.stringify({ action: 'list' }), { action: 'list' }, now))
        add.push(toolReturnEvent(session, node, 'cronjob_manage', callId, false, now))
      } else {
        // The gateway is seen from a message that came in through it (the session's source platform).
        add.push({
          time: elapsed(node, now), type: 'message', sessionId: session.id,
          payload: { agent: node.name, role: 'user', content: 'Demo message via the gateway', platform: 'matrix', at: now },
        })
      }
      break
    }
  }
  return {
    ...state,
    seq: state.seq + 1,
    sessions: replaceSession(state, replaceNode(session, node, now)),
    events: withEvents(state, session.id, add),
    kanban,
    supermemory,
  }
}

function resourceRemove(state: DemoState, action: Extract<DemoAction, { type: 'resource_remove' }>): DemoState {
  const key = normaliseResourceKey(action.kind, action.key)
  if (key === null || !hasResource(state, action.kind, key)) return state
  return {
    ...state,
    resources: state.resources.filter(r => !(r.kind === action.kind && r.key === key)),
    kanban: action.kind === 'kanban' ? state.kanban.filter(b => b.slug !== key) : state.kanban,
    supermemory: action.kind === 'memory' ? state.supermemory.filter(n => n.containerTag !== key) : state.supermemory,
  }
}

// ─── selectors ──────────────────────────────────────────────────────────────

/** The Kanban boards and Supermemory namespaces the Fleet map and its timeline read (the shape of /api/fleet). */
export function demoSources(state: DemoState): DemoSources {
  return { kanban: state.kanban, supermemory: state.supermemory }
}

/** The bridge's session list. */
export function demoSessionList(state: DemoState): SessionInfo[] {
  return state.sessions.map(({ id, label, status, startTime, lastActivityTime }) => ({ id, label, status, startTime, lastActivityTime }))
}

/** Every node of every session, flat, for a picker: `<sessionId>::<node name>` (the id format of the fleet selection). */
export function demoNodeChoices(state: DemoState): Array<{ value: string; sessionId: string; node: string; profile: string; kind: DemoNode['kind']; status: DemoNode['status'] }> {
  const out: Array<{ value: string; sessionId: string; node: string; profile: string; kind: DemoNode['kind']; status: DemoNode['status'] }> = []
  for (const s of state.sessions) {
    for (const n of s.nodes) out.push({ value: `${s.id}::${n.name}`, sessionId: s.id, node: n.name, profile: s.profile, kind: n.kind, status: n.status })
  }
  return out
}
