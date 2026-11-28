/**
 * Static file server for the pre-built webview assets.
 * Serves index.html, index.js, and index.css from app/dist/webview/.
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { BUILD_INFO, type BuildInfo } from './build-info'
import { isDemoPath } from '../../web/lib/demo/demo-route'

const WEBVIEW_DIR = path.join(__dirname, 'webview')

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The HTML page around the bundle; the build-branch / build-commit meta tags identify the served build. */
export function renderHtmlShell(info: BuildInfo = BUILD_INFO): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="build-branch" content="${escapeAttr(info.branch)}">
  <meta name="build-commit" content="${escapeAttr(info.commit)}">
  <title>Agent Flow</title>
  <link rel="stylesheet" href="/index.css">
  <style>html, body { height: 100%; margin: 0; padding: 0; }</style>
</head>
<body class="font-sans antialiased" style="background: #0a0a1a;">
  <div id="root" style="height: 100%;"></div>
  <script src="/index.js"></script>
</body>
</html>`
}

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
}

/** The request path without its query string or fragment (`/?shot=1` -> `/`). */
export function pathOnly(rawUrl: string): string {
  const cut = rawUrl.search(/[?#]/)
  return cut === -1 ? rawUrl : rawUrl.slice(0, cut)
}

export function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = pathOnly(req.url || '/')

  // `/demo` is the same page: the bundle picks the demo view by the path (web/app-entry.tsx).
  if (url === '/' || url === '/index.html' || isDemoPath(url)) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(renderHtmlShell())
    return
  }

  // Only serve known asset files from the webview directory
  const basename = path.basename(url)
  const ext = path.extname(basename)
  const mime = MIME_TYPES[ext]

  if (!mime) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const filePath = path.join(WEBVIEW_DIR, basename)

  // Prevent path traversal
  if (!filePath.startsWith(WEBVIEW_DIR)) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }

  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': mime })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not found')
  }
}
