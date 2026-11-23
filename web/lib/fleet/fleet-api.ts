import type { KanbanBoardNode, PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryNamespaceNode } from './supermemory-source'
import { anonymizeTaskTitle, isAnonymized } from '../content-privacy'
import type { AnonymizePolicy } from '../content-privacy'

/**
 * Access policy for the read-only /api/fleet endpoint.
 *
 * The endpoint exposes Kanban board names, task titles, assignees and
 * Supermemory container tags. It has no login, so it is LOOPBACK-ONLY BY
 * DEFAULT:
 *   - the request's Host header must name a loopback host (localhost,
 *     127.0.0.0/8, ::1). This also blocks DNS-rebinding from a browser.
 *   - the request must not look proxied: no Forwarded / X-Real-IP header, and
 *     X-Forwarded-Host / X-Forwarded-For (if present) must be loopback. A
 *     reverse proxy (e.g. a tailnet proxy) that reaches us over loopback
 *     therefore cannot be used to read the data by accident.
 * This is a guard, not authentication: route handlers can't see the socket
 * peer, and a client can forge these headers. The real protection is the
 * loopback bind (`-H 127.0.0.1`); with a non-loopback bind, rely on the network.
 *
 * Serving it beyond loopback is an explicit opt-in: set
 * AGENT_FLOW_FLEET_ALLOW_REMOTE=1. Doing so exposes board and task metadata to
 * everyone who can reach the port, so only enable it on a trusted network.
 * `next dev` / `next start` also bind to 127.0.0.1 by default (web/package.json);
 * a non-loopback bind is likewise something the operator has to ask for.
 */
export const ALLOW_REMOTE_ENV = 'AGENT_FLOW_FLEET_ALLOW_REMOTE'

export const FLEET_ERROR_MESSAGE = 'fleet read failed'

interface HeaderReader { get(name: string): string | null }

// Never added by Next itself, so their presence means a proxy is in front.
const PROXY_HEADERS = ['x-real-ip', 'forwarded']

/** Strip the port from a Host header value; handles bracketed IPv6. */
function hostnameOf(host: string): string {
  const h = host.trim().toLowerCase()
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(1, end)
  }
  const colon = h.lastIndexOf(':')
  return colon !== -1 && h.indexOf(':') === colon ? h.slice(0, colon) : h
}

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false
  const name = hostnameOf(host)
  return name === 'localhost' || name === '::1' || /^127(\.\d{1,3}){3}$/.test(name)
}

export function isLoopbackAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '')
  return a === '::1' || /^127(\.\d{1,3}){3}$/.test(a)
}

export function isFleetRequestAllowed(headers: HeaderReader, env: Record<string, string | undefined>): boolean {
  if (env[ALLOW_REMOTE_ENV] === '1') return true
  if (PROXY_HEADERS.some(h => headers.get(h) !== null)) return false
  if (!isLoopbackHost(headers.get('host'))) return false
  // Next.js fills X-Forwarded-Host / X-Forwarded-For itself (Host and the socket's peer
  // address) when no proxy is in front, so those two are accepted only if they are
  // loopback too; a real proxy puts the original (non-loopback) values there.
  const fwdHost = headers.get('x-forwarded-host')
  if (fwdHost !== null && !isLoopbackHost(fwdHost)) return false
  const fwdFor = headers.get('x-forwarded-for')
  if (fwdFor !== null && !fwdFor.split(',').every(isLoopbackAddress)) return false
  return true
}

export interface FleetApiDeps {
  readKanban: () => { nodes: KanbanBoardNode[] }
  readSupermemory: () => { nodes: SupermemoryNamespaceNode[] }
  env?: Record<string, string | undefined>
  now?: () => number
  /** Server-side error sink; the detail never goes to the client. */
  logError?: (message: string, err: unknown) => void
  /**
   * Same per-profile setting as the live feed. The title of a task assigned to an
   * anonymized profile is replaced by its id and length; boards, counts, ids and
   * assignees stay. Without a policy titles are shown.
   */
  anonymize?: AnonymizePolicy
}

/**
 * Drop the absolute database path from a board node (the browser has no use for
 * it) and scrub it from the node's error text, which can quote it.
 */
export function toPublicNode(node: KanbanBoardNode): PublicKanbanBoardNode {
  const { dbPath, ...rest } = node
  if (rest.error && dbPath) rest.error = rest.error.split(dbPath).join('<kanban.db>')
  return rest
}

/** Hide task titles of anonymized assignees. Returns new nodes; the input is not changed. */
export function applyAnonymization(nodes: PublicKanbanBoardNode[], policy: AnonymizePolicy | undefined): PublicKanbanBoardNode[] {
  if (!policy) return nodes
  return nodes.map(node => ({
    ...node,
    recentEvents: node.recentEvents.map(e =>
      e.assignee && isAnonymized(policy, e.assignee) ? { ...e, taskTitle: anonymizeTaskTitle(e.taskId, e.taskTitle) } : e,
    ),
  }))
}

/** Pure request handler behind app/api/fleet/route.ts (kept separate so it is testable). */
export function handleFleetRequest(req: Request, deps: FleetApiDeps): Response {
  const env = deps.env ?? process.env
  if (!isFleetRequestAllowed(req.headers, env)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }
  try {
    const kanban = deps.readKanban()
    const supermemory = deps.readSupermemory()
    return Response.json({ readAt: (deps.now ?? Date.now)(), kanban: applyAnonymization(kanban.nodes.map(toPublicNode), deps.anonymize), supermemory: supermemory.nodes })
  } catch (err) {
    // Errors can contain absolute DB paths: log them here, tell the client nothing specific.
    ;(deps.logError ?? ((m, e) => console.error(m, e)))('[fleet] /api/fleet read failed', err)
    return Response.json({ error: FLEET_ERROR_MESSAGE }, { status: 500 })
  }
}
