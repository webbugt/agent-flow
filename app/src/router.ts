/**
 * Request routing of the standalone server (app/src/server.ts), separate from the
 * relay setup so it can be tested with a fake relay.
 */
import type * as http from 'http'

import { serveStatic } from './static'
import { handleFleetHttp, isFleetPath, type FleetRouteOptions } from './fleet-route'
import { BUILD_INFO, type BuildInfo } from './build-info'
import { isLoopbackHost } from '../../extension/src/request-guard'

export const HEALTH_PATH = '/health'

/** True if `url` (req.url) addresses the health endpoint, ignoring any query string. */
export function isHealthPath(url: string | undefined): boolean {
  if (!url) return false
  const q = url.indexOf('?')
  return (q === -1 ? url : url.slice(0, q)) === HEALTH_PATH
}

/** GET /health: liveness plus the branch and commit this bundle was built from. */
export function handleHealth(req: http.IncomingMessage, res: http.ServerResponse, info: BuildInfo = BUILD_INFO): void {
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' })
    res.end(JSON.stringify({ error: 'method not allowed' }))
    return
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify({ status: 'ok', branch: info.branch, commit: info.commit }))
}

export interface RouterDeps {
  handleSSE: (req: http.IncomingMessage, res: http.ServerResponse) => void
  fleet?: FleetRouteOptions
  buildInfo?: BuildInfo
}

export function createRequestListener(deps: RouterDeps): http.RequestListener {
  return (req, res) => {
    // Reject DNS-rebinding requests, which reach 127.0.0.1 under a foreign Host.
    // This guard runs before every route, /health included.
    if (!isLoopbackHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' })
      res.end('Forbidden')
      return
    }

    // SSE endpoint
    if (req.url === '/events') {
      return deps.handleSSE(req, res)
    }

    if (isHealthPath(req.url)) {
      return handleHealth(req, res, deps.buildInfo)
    }

    // Read-only Kanban / Supermemory fleet data (loopback-only unless opted in)
    if (isFleetPath(req.url)) {
      void handleFleetHttp(req, res, deps.fleet).catch(err => {
        console.error('[fleet] /api/fleet failed', err)
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'fleet read failed' }))
      })
      return
    }

    // Static files (UI)
    if (req.method === 'GET') {
      return serveStatic(req, res)
    }

    res.writeHead(404)
    res.end('Not found')
  }
}
