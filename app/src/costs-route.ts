/**
 * POST /costs-config: the settings drawer's save in standalone / relay mode (the VS Code build posts a message
 * to the extension host instead). The page sends the whole costs document; the host writes the user (or project)
 * file atomically with mode 0600 and the file watcher publishes the new config to every page.
 *
 * A browser page can reach any loopback port, so beyond the router's Host check this route requires:
 *  - POST with a JSON content type (a cross-site form cannot send one without a preflight, which is not answered),
 *  - no cross-site origin: `Sec-Fetch-Site` same-origin / none, and `Origin` (when sent) equal to the Host,
 *  - a body of at most MAX_BODY bytes.
 * The writer re-checks the document (plain object, no forbidden keys, size) and refuses a project file outside the workspace.
 */
import type * as http from 'http'

export const COSTS_PATH = '/costs-config'
/** The loader's own file limit (256 KiB) plus room for the JSON envelope. */
export const MAX_BODY = 256 * 1024 + 4096

export interface CostsWriter {
  /**
   * `base` is the fingerprint of the file version `doc` was edited from; the writer refuses (an error with
   * `code: 'conflict'`) when the file no longer has it. Returns the fingerprint of the new content.
   */
  writeConfig(layer: 'user' | 'project', doc: unknown, base: string): { path: string; fingerprint?: string }
}

export function isCostsPath(url: string | undefined): boolean {
  if (!url) return false
  const q = url.indexOf('?')
  return (q === -1 ? url : url.slice(0, q)) === COSTS_PATH
}

function json(res: http.ServerResponse, status: number, body: unknown, extra: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra })
  res.end(JSON.stringify(body))
}

/** True when the request cannot have been made by a page on another site. */
export function isSameSiteRequest(headers: http.IncomingHttpHeaders, allowOrigin?: (origin: string) => boolean): boolean {
  // Dev mode: the page (Next.js on :3000) and the relay (:3001) are different origins; the caller names the pages it trusts.
  if (allowOrigin && typeof headers.origin === 'string' && allowOrigin(headers.origin)) return true
  const site = headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false
  const origin = headers.origin
  if (origin !== undefined) {
    try { return new URL(origin).host.toLowerCase() === String(headers.host ?? '').toLowerCase() } catch { return false }
  }
  return true
}

function readBody(req: http.IncomingMessage, limit: number): Promise<string | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { over = true; chunks.length = 0; return }
      if (!over) chunks.push(c)
    })
    req.on('end', () => resolve(over ? 'too-large' : Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export async function handleCostsWrite(req: http.IncomingMessage, res: http.ServerResponse, writer: CostsWriter | undefined, allowOrigin?: (origin: string) => boolean): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' }, { Allow: 'POST' })
  if (!writer) return json(res, 503, { ok: false, error: 'costs config is not available' })
  if (!isSameSiteRequest(req.headers, allowOrigin)) return json(res, 403, { ok: false, error: 'cross-site request refused' })
  const ct = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!/^application\/json\s*(;|$)/.test(ct)) return json(res, 415, { ok: false, error: 'content-type must be application/json' })

  let text: string | 'too-large'
  try { text = await readBody(req, MAX_BODY) } catch { return json(res, 400, { ok: false, error: 'could not read the request body' }) }
  if (text === 'too-large') return json(res, 413, { ok: false, error: 'request body too large' })

  let body: unknown
  try { body = JSON.parse(text) } catch { return json(res, 400, { ok: false, error: 'request body is not valid JSON' }) }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return json(res, 400, { ok: false, error: 'request body must be an object' })
  const { layer, doc, base } = body as { layer?: unknown; doc?: unknown; base?: unknown }
  if (layer !== 'user' && layer !== 'project') return json(res, 400, { ok: false, error: 'layer must be "user" or "project"' })
  // Required: a save that does not say which version of the file it edited could replace a newer one unseen.
  if (typeof base !== 'string' || base === '' || base.length > 128) return json(res, 400, { ok: false, error: 'base (the fingerprint of the file version that was edited) is required' })

  try {
    const { path, fingerprint } = writer.writeConfig(layer, doc, base)
    return json(res, 200, { ok: true, path, ...(fingerprint ? { fingerprint } : {}) })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'write failed'
    if ((err as { code?: unknown } | null)?.code === 'conflict') return json(res, 409, { ok: false, conflict: true, error: message })
    return json(res, 400, { ok: false, error: message })
  }
}
