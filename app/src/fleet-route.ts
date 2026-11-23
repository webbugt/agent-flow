/**
 * GET /api/fleet for the standalone relay (app/src/server.ts).
 *
 * Same pure handler and read-only readers as the Next route
 * (web/app/api/fleet/route.ts): web/lib/fleet/fleet-api.ts decides access
 * (loopback-only unless AGENT_FLOW_FLEET_ALLOW_REMOTE=1) and shapes the body
 * (generic error message, details only in the server log).
 *
 * The readers use node:sqlite (Node >= 22.5). They are loaded on the first
 * request so the relay still starts on older Node versions; if loading fails
 * the client gets the same generic 500 as any other read failure.
 */
import type * as http from 'http'
import { handleFleetRequest, type FleetApiDeps } from '../../web/lib/fleet/fleet-api'

export const FLEET_PATH = '/api/fleet'

export type FleetReaders = Pick<FleetApiDeps, 'readKanban' | 'readSupermemory'>

export interface FleetRouteOptions {
  /** Test seam; defaults to the real read-only Kanban and Supermemory readers. */
  loadReaders?: () => Promise<FleetReaders>
  env?: Record<string, string | undefined>
  logError?: FleetApiDeps['logError']
}

async function loadDefaultReaders(): Promise<FleetReaders> {
  const [kanban, supermemory] = await Promise.all([
    import('../../web/lib/fleet/kanban-source'),
    import('../../web/lib/fleet/supermemory-source'),
  ])
  return {
    readKanban: () => kanban.readKanbanFleet({ eventLimit: 200 }),
    readSupermemory: () => supermemory.readSupermemoryFleet(),
  }
}

/** True if `url` (req.url) addresses the fleet endpoint, ignoring any query string. */
export function isFleetPath(url: string | undefined): boolean {
  if (!url) return false
  const q = url.indexOf('?')
  return (q === -1 ? url : url.slice(0, q)) === FLEET_PATH
}

/** Copy the node request headers into a fetch Request for the pure handler. */
function toRequest(req: http.IncomingMessage): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) {
      try { headers.append(name, v) } catch { /* unrepresentable header value: drop it */ }
    }
  }
  return new Request(`http://localhost${FLEET_PATH}`, { headers })
}

export async function handleFleetHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: FleetRouteOptions = {},
): Promise<void> {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }

  const logError = options.logError ?? ((m, e) => console.error(m, e))
  let readers: FleetReaders | undefined
  let loadError: unknown
  try {
    readers = await (options.loadReaders ?? loadDefaultReaders)()
  } catch (err) {
    loadError = err
  }

  const response = handleFleetRequest(toRequest(req), {
    readKanban: () => { if (!readers) throw loadError; return readers.readKanban() },
    readSupermemory: () => { if (!readers) throw loadError; return readers.readSupermemory() },
    env: options.env,
    logError,
  })

  const body = await response.text()
  res.writeHead(response.status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
