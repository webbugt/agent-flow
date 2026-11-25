/**
 * Host-side loader of the costs config: finds, reads, watches and writes the files. No `vscode` import, so the
 * extension host, the dev relay and the standalone app share it.
 *
 *   ~/.agent-flow/costs.json                      user file (source of truth). Override: setting
 *                                                 `agentVisualizer.costs.configPath`, else env AGENT_FLOW_COSTS.
 *   <workspace>/.agent-flow/costs.json            project override (highest precedence)
 *   VS Code scalar settings                       lowest precedence, scalars only
 *
 * What lives here (I/O and safety) and what does not:
 *  - Here: locating files (HOME honoured through os.homedir()), a size cap, JSON parsing, last-good per file,
 *    confinement of the project file, hot reload (fs.watch on the directory + debounce + a slow stat poll), atomic writes.
 *  - Not here: validation and merging. extension/src cannot import web/lib (tsconfig rootDir), so the host ships
 *    each layer's parsed JSON in a `costs-config` message and web/lib/costs/layers.ts validates and merges it with
 *    the P1 modules, identically in the VS Code webview and the browser app.
 *
 * Safety rules (PLAN v2 P3-A4, v1 risk table):
 *  - The project file is attacker-influenced (a cloned repo can carry one). It cannot set `configPath`
 *    (the key is dropped with a warning), is read only if it resolves inside `<workspace>/.agent-flow/`,
 *    and writes for it go only into that directory (a symlinked `.agent-flow` or costs.json cannot redirect them).
 *  - Files are written to a temp file in the same directory (mode 0600, fsync) and renamed, so a reader never sees half a file.
 *  - Nothing from a file's content is logged (parser messages can quote it); logs carry layer ids and statuses.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { randomBytes } from 'crypto'
import type { CostsConfigLayer, CostsConfigPayload, CostsLayerId } from './protocol'
import { createLogger } from './logger'

const log = createLogger('Costs')

export const CONFIG_DIR_NAME = '.agent-flow'
export const COSTS_FILE_NAME = 'costs.json'
export const COSTS_ENV = 'AGENT_FLOW_COSTS'
/** Same cap as MAX_CONFIG_BYTES in web/lib/costs/validate.ts (this file cannot import it). */
export const MAX_COSTS_FILE_BYTES = 256 * 1024

type Obj = Record<string, unknown>

// ─── Paths ──────────────────────────────────────────────────────────────────

/** `~` and `~/x` to the home directory. Anything else is returned unchanged. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2))
  return p
}

/** Home shown as `~`, for display only. */
export function displayPath(p: string, home: string): string {
  if (p === home) return '~'
  const rel = path.relative(home, p)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : p
}

/** True when `child` is `parent` or below it. Both must already be normalised absolute paths. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function defaultUserConfigPath(home: string): string {
  return path.join(home, CONFIG_DIR_NAME, COSTS_FILE_NAME)
}

export function projectConfigPath(workspaceDir: string): string {
  return path.join(workspaceDir, CONFIG_DIR_NAME, COSTS_FILE_NAME)
}

export interface UserPathInput { configPath?: string; env?: NodeJS.ProcessEnv; home: string }

/** The user file location: setting, else env, else `~/.agent-flow/costs.json`. A relative or malformed override is an error. */
export function resolveUserConfigPath(i: UserPathInput): { path: string } | { error: string } {
  const fromSetting = typeof i.configPath === 'string' ? i.configPath.trim() : ''
  const fromEnv = (i.env ?? process.env)[COSTS_ENV]?.trim() ?? ''
  const raw = fromSetting || fromEnv
  if (!raw) return { path: defaultUserConfigPath(i.home) }
  const source = fromSetting ? 'setting agentVisualizer.costs.configPath' : `environment variable ${COSTS_ENV}`
  if (raw.includes('\0')) return { error: `${source} contains an invalid character` }
  const expanded = expandHome(raw, i.home)
  if (!path.isAbsolute(expanded)) return { error: `${source} must be an absolute path or start with ~/` }
  return { path: path.normalize(expanded) }
}

// ─── Reading one file ───────────────────────────────────────────────────────

function isPlainObject(v: unknown): v is Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const p = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}

function errCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined
}

export interface ReadLayerOptions {
  home: string
  /** The file must resolve (symlinks followed) inside this directory, which must itself be a real path
   *  (no symlinks), so a symlinked `.agent-flow` is refused too. Used for the project file. */
  confineDir?: string
  /** Keys a project file may not carry; dropped with a warning. */
  forbiddenKeys?: readonly string[]
}

/** Read and parse one layer file. Never throws; problems come back as `status: 'error'` with a message (no file content). */
export function readLayerFile(file: string, id: CostsLayerId, opts: ReadLayerOptions): CostsConfigLayer {
  const base = { id, path: displayPath(file, opts.home) }
  const fail = (error: string): CostsConfigLayer => ({ ...base, status: 'error', error })

  let real: string
  try { real = fs.realpathSync(file) } catch (e) {
    const code = errCode(e)
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ...base, status: 'missing' }
    return fail(`cannot resolve the file (${code ?? 'error'})`)
  }
  if (opts.confineDir && !isInside(opts.confineDir, real)) {
    return fail(`refused: it resolves outside ${displayPath(opts.confineDir, opts.home)}`)
  }
  let fd: number | undefined
  try {
    const st = fs.statSync(real)
    if (!st.isFile()) return fail('not a regular file')
    if (st.size > MAX_COSTS_FILE_BYTES) return fail(`file is ${st.size} bytes; the limit is ${MAX_COSTS_FILE_BYTES}`)
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const buf = Buffer.alloc(MAX_COSTS_FILE_BYTES + 1)
    let n = 0
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null)
      if (r === 0) break
      n += r
      if (n > MAX_COSTS_FILE_BYTES) return fail(`file is larger than the limit of ${MAX_COSTS_FILE_BYTES} bytes`)
    }
    let text = buf.toString('utf8', 0, n)
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    if (text.trim() === '') return { ...base, status: 'ok', raw: {} }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch (e) {
      const m = e instanceof Error ? e.message : 'parse error'
      return fail(`invalid JSON: ${m.slice(0, 160)}`)
    }
    if (!isPlainObject(parsed)) return fail('the document must be a JSON object')
    const warnings: string[] = []
    for (const k of opts.forbiddenKeys ?? []) {
      if (Object.prototype.hasOwnProperty.call(parsed, k)) {
        delete parsed[k]
        warnings.push(`"${k}" is not allowed in a project file and was ignored`)
      }
    }
    return { ...base, status: 'ok', raw: parsed, ...(warnings.length ? { warnings } : {}) }
  } catch (e) {
    return fail(`cannot read the file (${errCode(e) ?? 'error'})`)
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* nothing to do */ } }
  }
}

// ─── VS Code scalar settings layer ──────────────────────────────────────────

/** Only values the user set; `undefined` means "not set". */
export interface CostsScalars {
  enabled?: boolean
  displayCurrency?: string
  unit?: string
  unknownModelPolicy?: string
  configPath?: string
}

/** The lowest layer: the scalar settings, written as a partial costs.json document. */
export function settingsLayer(s: CostsScalars): CostsConfigLayer {
  const raw: Obj = {}
  const cur = typeof s.displayCurrency === 'string' ? s.displayCurrency.trim().toUpperCase() : ''
  if (cur) raw.currency = { display: cur }
  const unit = typeof s.unit === 'string' ? s.unit.trim() : ''
  if (unit) raw.display = { unit }
  const pol = typeof s.unknownModelPolicy === 'string' ? s.unknownModelPolicy.trim() : ''
  if (pol) raw.pricing = { unknownModel: { policy: pol } }
  return Object.keys(raw).length > 0 ? { id: 'settings', path: null, status: 'ok', raw } : { id: 'settings', path: null, status: 'missing' }
}

// ─── Atomic write ───────────────────────────────────────────────────────────

const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

function hasForbiddenKey(v: unknown, depth = 0): boolean {
  if (depth > 20) return true
  if (typeof v !== 'object' || v === null) return false
  if (Array.isArray(v)) return v.some(x => hasForbiddenKey(x, depth + 1))
  return Object.getOwnPropertyNames(v).some(k => FORBIDDEN_KEYS.includes(k) || hasForbiddenKey((v as Obj)[k], depth + 1))
}

/**
 * Write `text` to `file` so a reader sees either the old or the new content, never a mix: temp file in the same
 * directory (created exclusively, mode `mode`, fsync), then rename over the target. The directory is created 0700.
 * On any failure the temp file is removed and the target is untouched.
 */
export function writeFileAtomic(file: string, text: string, mode = 0o600): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  let fd: number | undefined
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode)
    fs.fchmodSync(fd, mode)
    fs.writeSync(fd, text)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmp, file)
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch { /* ignore */ } }
    try { fs.unlinkSync(tmp) } catch { /* may not exist */ }
    throw e
  }
  try { // make the rename durable; not supported everywhere
    const dfd = fs.openSync(dir, fs.constants.O_RDONLY)
    try { fs.fsyncSync(dfd) } finally { fs.closeSync(dfd) }
  } catch { /* best effort */ }
}

// ─── Loader ─────────────────────────────────────────────────────────────────

export interface CostsLoaderOptions {
  /** Workspace folders; the project file is the first one that has `.agent-flow/costs.json`, else the first folder. */
  workspaceDirs?: () => readonly string[]
  /** VS Code scalar settings the user set. */
  scalars?: () => CostsScalars
  env?: NodeJS.ProcessEnv
  /** Default os.homedir(), which honours $HOME. */
  homeDir?: () => string
  /** Wait after a file event before reloading. Default 150 ms. */
  debounceMs?: number
  /** Slow safety-net check for platforms or directories fs.watch misses. Default 5000 ms; 0 disables. */
  pollMs?: number
}

const PROJECT_FORBIDDEN_KEYS = ['configPath'] as const

function realOrSelf(p: string): string {
  try { return fs.realpathSync(p) } catch { return p }
}

export class CostsConfigLoader {
  private readonly opts: CostsLoaderOptions
  private seq = 0
  private lastKey = ''
  private payload: CostsConfigPayload | null = null
  private readonly lastGood = new Map<CostsLayerId, Obj>()
  private readonly listeners = new Set<(p: CostsConfigPayload) => void>()
  private readonly watchers = new Map<string, fs.FSWatcher>()
  private debounce: NodeJS.Timeout | undefined
  private pollTimer: NodeJS.Timeout | undefined
  private lastSignature = ''
  private disposed = false

  constructor(opts: CostsLoaderOptions = {}) { this.opts = opts }

  private home(): string { return (this.opts.homeDir ?? os.homedir)() }

  /** Load once and start watching. */
  start(): void {
    this.reload()
    const pollMs = this.opts.pollMs ?? 5000
    if (pollMs > 0 && !this.pollTimer) {
      this.pollTimer = setInterval(() => {
        const sig = this.signature()
        if (sig !== this.lastSignature) this.schedule()
      }, pollMs)
      this.pollTimer.unref?.()
    }
  }

  onChange(cb: (p: CostsConfigPayload) => void): () => void {
    this.listeners.add(cb)
    return () => { this.listeners.delete(cb) }
  }

  /** The current payload (loads on first use). */
  snapshot(): CostsConfigPayload {
    if (!this.payload) this.reload()
    return this.payload as CostsConfigPayload
  }

  /** Resolved user file path, or null when the override is malformed. */
  userConfigPath(): string | null {
    const r = this.userPath()
    return 'path' in r ? r.path : null
  }

  /** The project file path (first workspace folder with one, else the first folder), or null without a workspace. */
  projectFilePath(): string | null {
    const dir = this.projectWorkspace()
    return dir === null ? null : projectConfigPath(dir)
  }

  private userPath(): { path: string } | { error: string } {
    return resolveUserConfigPath({ configPath: this.opts.scalars?.().configPath, env: this.opts.env, home: this.home() })
  }

  private projectWorkspace(): string | null {
    const dirs = (this.opts.workspaceDirs?.() ?? []).filter(d => typeof d === 'string' && d !== '' && path.isAbsolute(d))
    if (dirs.length === 0) return null
    return dirs.find(d => { try { return fs.statSync(projectConfigPath(d)).isFile() } catch { return false } }) ?? dirs[0]
  }

  private buildLayers(): CostsConfigLayer[] {
    const home = this.home()
    const scalars = this.opts.scalars?.() ?? {}
    const layers: CostsConfigLayer[] = [settingsLayer(scalars)]

    const up = this.userPath()
    if ('error' in up) layers.push({ id: 'user', path: null, status: 'error', error: up.error })
    else layers.push(this.keepLastGood(readLayerFile(up.path, 'user', { home })))

    const ws = this.projectWorkspace()
    if (ws !== null) {
      layers.push(this.keepLastGood(readLayerFile(projectConfigPath(ws), 'project', {
        home, confineDir: path.join(realOrSelf(ws), CONFIG_DIR_NAME), forbiddenKeys: PROJECT_FORBIDDEN_KEYS,
      })))
    }
    this.lastGood.forEach((_v, id) => { if (!layers.some(l => l.id === id)) this.lastGood.delete(id) })
    return layers
  }

  /** ok: remember it; missing: forget it (a deleted file is gone, not "last good"); error: serve the previous good copy. */
  private keepLastGood(layer: CostsConfigLayer): CostsConfigLayer {
    if (layer.status === 'ok' && layer.raw) this.lastGood.set(layer.id, layer.raw)
    else if (layer.status === 'missing') this.lastGood.delete(layer.id)
    else if (layer.status === 'error') {
      const prev = this.lastGood.get(layer.id)
      if (prev) return { ...layer, raw: prev, stale: true }
    }
    return layer
  }

  /** Re-read everything now. Emits to listeners and returns true only when something changed. */
  reload(): boolean {
    if (this.disposed) return false
    const layers = this.buildLayers()
    const enabled = this.opts.scalars?.().enabled !== false
    const key = JSON.stringify({ enabled, layers })
    this.lastSignature = this.signature()
    this.rewatch()
    if (this.payload && key === this.lastKey) return false
    const first = this.payload === null
    this.lastKey = key
    this.payload = { version: 1, seq: ++this.seq, enabled, layers }
    log.info(`${first ? 'loaded' : 'reloaded'}: ${layers.map(l => `${l.id}=${l.status}${l.stale ? '(stale)' : ''}`).join(' ')}${enabled ? '' : ' (disabled)'}`)
    // The first load is not a change: consumers read it with snapshot().
    if (first) return true
    for (const cb of [...this.listeners]) {
      try { cb(this.payload) } catch (e) { log.warn('costs-config listener failed:', e instanceof Error ? e.message : e) }
    }
    return true
  }

  // ── watching ──

  private wantedFiles(): { dir: string; file: string }[] {
    const out: { dir: string; file: string }[] = []
    const up = this.userPath()
    if ('path' in up) out.push({ dir: path.dirname(up.path), file: path.basename(up.path) })
    const pf = this.projectFilePath()
    if (pf) out.push({ dir: path.dirname(pf), file: path.basename(pf) })
    return out
  }

  private signature(): string {
    return this.wantedFiles().map(({ dir, file }) => {
      try { const s = fs.statSync(path.join(dir, file)); return `${s.mtimeMs}:${s.size}:${s.ino}` } catch { return 'x' }
    }).join('|')
  }

  private rewatch(): void {
    if (this.disposed) return
    const wanted = this.wantedFiles()
    const dirs = new Set(wanted.map(w => w.dir))
    for (const [d, w] of this.watchers) {
      if (!dirs.has(d)) { w.close(); this.watchers.delete(d) }
    }
    for (const dir of dirs) {
      if (this.watchers.has(dir)) continue
      const names = wanted.filter(w => w.dir === dir).map(w => w.file)
      try {
        // Watch the directory, not the file: an atomic write replaces the inode and a file watcher would go blind.
        const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
          if (filename === null || filename === undefined || names.includes(String(filename))) this.schedule()
        })
        w.on('error', () => { w.close(); this.watchers.delete(dir) })
        this.watchers.set(dir, w)
      } catch { /* directory does not exist yet: the slow poll notices when it appears */ }
    }
  }

  private schedule(): void {
    if (this.disposed) return
    if (this.debounce) clearTimeout(this.debounce)
    this.debounce = setTimeout(() => { this.debounce = undefined; this.reload() }, this.opts.debounceMs ?? 150)
    this.debounce.unref?.()
  }

  // ── writing ──

  /**
   * Write a whole document to the user file or the project file, atomically (0600). The document is not
   * validated here (web/lib/costs/validate.ts does that in the UI before it asks). Refuses poisoned keys,
   * oversize documents, `configPath` in a project file, and a project directory that is not inside the workspace.
   * Throws on refusal or I/O failure; the existing file is then untouched.
   */
  writeConfig(layer: 'user' | 'project', doc: unknown): { path: string } {
    if (!isPlainObject(doc)) throw new Error('the config must be a JSON object')
    if (hasForbiddenKey(doc)) throw new Error('the config contains a forbidden key')
    const text = JSON.stringify(doc, null, 2) + '\n'
    if (Buffer.byteLength(text) > MAX_COSTS_FILE_BYTES) throw new Error(`the config is larger than ${MAX_COSTS_FILE_BYTES} bytes`)

    let target: string
    if (layer === 'user') {
      const up = this.userPath()
      if ('error' in up) throw new Error(up.error)
      target = up.path
    } else {
      if (PROJECT_FORBIDDEN_KEYS.some(k => Object.prototype.hasOwnProperty.call(doc, k))) {
        throw new Error('"configPath" cannot be set in a project file')
      }
      const ws = this.projectWorkspace()
      if (ws === null) throw new Error('no workspace folder is open')
      const dir = path.join(ws, CONFIG_DIR_NAME)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (!isInside(fs.realpathSync(ws), fs.realpathSync(dir))) throw new Error(`${CONFIG_DIR_NAME} resolves outside the workspace`)
      target = path.join(dir, COSTS_FILE_NAME)
    }
    writeFileAtomic(target, text, 0o600)
    this.reload()
    return { path: target }
  }

  /** Create the user file with a minimal template when it does not exist yet; returns its path. */
  ensureUserFile(): string {
    const up = this.userPath()
    if ('error' in up) throw new Error(up.error)
    if (!fs.existsSync(up.path)) {
      writeFileAtomic(up.path, JSON.stringify({ schemaVersion: 1 }, null, 2) + '\n', 0o600)
      this.reload()
    }
    return up.path
  }

  dispose(): void {
    this.disposed = true
    if (this.debounce) clearTimeout(this.debounce)
    if (this.pollTimer) clearInterval(this.pollTimer)
    for (const w of this.watchers.values()) w.close()
    this.watchers.clear()
    this.listeners.clear()
  }
}

/** The `costs-config` message for a payload (extension webview, SSE). */
export function costsConfigMessage(costs: CostsConfigPayload): { type: 'costs-config'; costs: CostsConfigPayload } {
  return { type: 'costs-config', costs }
}
