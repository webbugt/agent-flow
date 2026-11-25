/**
 * Installer of the chained Claude Code statusLine wrapper (PLAN v2 section 8, task P6a). No `vscode` import: the
 * extension host, the relay / standalone app and the tests share it; every path derives from `env.home`, so a test
 * runs against a temp HOME and never touches the real `~/.claude/settings.json`.
 *
 * Rules (each has a test in extension/test/statusline-installer.test.ts):
 *  1. User scope only: `<home>/.claude/settings.json`. A file that does not parse is never touched.
 *  2. Cases: (a) no statusLine -> wrapper that only tees; (b) `{type:'command', command}` -> the original object is
 *     stored verbatim in `<home>/.agent-flow/statusline-original.json` (0600) and chained; (c) any other shape
 *     -> REFUSE, nothing written, reason reported; (d) a managed / enterprise settings file with a statusLine
 *     (it overrides user scope, so the wrapper would never run) -> REFUSE; (e) already wrapped -> no-op.
 *  3. A project / local settings file with its own statusLine shadows the user scope: reported as a warning, not a refusal.
 *  4. Before writing, settings.json is copied to `settings.json.agent-flow.bak` (0600); the write is temp + rename and
 *     keeps every other key, the key order, the indentation and the file mode.
 *  5. Uninstall puts the original statusLine back exactly (deep equal) and removes only Agent Flow's files. If the
 *     statusLine changed after install it is left alone and nothing is removed.
 *
 * Refusing is a normal result, not an error: the caller shows `reason` and the UI falls back to estimates.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { getShimScriptContent, STATUSLINE_SHIM_MARKER } from './statusline-shim'

type Obj = Record<string, unknown>

export const SETTINGS_BACKUP_SUFFIX = '.agent-flow.bak'
export const ORIGINAL_RECORD_FILE = 'statusline-original.json'
export const SHIM_FILE = 'statusline-shim.js'
export const LIMITS_RELATIVE = path.join('limits', 'claude.json')
/** A settings file larger than this is not a settings file; refuse instead of reading it. */
const MAX_SETTINGS_BYTES = 4 * 1024 * 1024
/** A statusLine command longer than this is not something to chain safely. */
const MAX_COMMAND_CHARS = 16 * 1024

export type RefuseCode =
  | 'settings-unreadable' | 'settings-invalid' | 'statusline-not-object' | 'statusline-not-command'
  | 'statusline-command-unusable' | 'managed-statusline' | 'managed-unreadable' | 'node-unavailable'
  | 'path-unsafe' | 'record-missing' | 'modified-after-install' | 'io-error'

export interface InstallerEnv {
  /** Home directory; every path derives from it. */
  home: string
  /** Absolute path of the node binary the wrapper command will use. */
  nodePath: string
  /** Managed (enterprise) settings files to check. Default: the per-OS locations. Tests pass their own. */
  managedSettingsPaths?: string[]
  /** Workspace folders whose `.claude/settings*.json` may shadow the user scope. */
  workspaceDirs?: string[]
  /** `CLAUDE_CONFIG_DIR` of the environment the editor runs in (default: process.env). */
  claudeConfigDir?: string
}

export type StatusLineState = 'not-installed' | 'installed' | 'refused' | 'broken'

export interface StatusLineInspection {
  state: StatusLineState
  /** Install would succeed right now (state `not-installed`). */
  canInstall: boolean
  reason?: string
  code?: RefuseCode
  /** Project / local settings files with their own statusLine (they win inside that project). */
  shadowedBy: string[]
  /** Things that may stop the wrapper from taking effect, without refusing (e.g. CLAUDE_CONFIG_DIR is set). */
  warnings: string[]
}

export type ActionResult =
  | { ok: true; action: 'installed' | 'already-installed' | 'uninstalled' | 'left-alone' | 'nothing-to-remove'; message: string; shadowedBy?: string[]; warnings?: string[] }
  | { ok: false; refused: true; code: RefuseCode; message: string }

// ─── Paths ──────────────────────────────────────────────────────────────────

export function paths(home: string) {
  const claude = path.join(home, '.claude')
  const af = path.join(home, '.agent-flow')
  return {
    settings: path.join(claude, 'settings.json'),
    backup: path.join(claude, 'settings.json' + SETTINGS_BACKUP_SUFFIX),
    shim: path.join(claude, 'agent-flow', SHIM_FILE),
    record: path.join(af, ORIGINAL_RECORD_FILE),
    limitsDir: path.join(af, 'limits'),
    limits: path.join(af, LIMITS_RELATIVE),
  }
}

/** Where an enterprise / managed Claude Code settings file lives. A statusLine there overrides the user scope. */
export function defaultManagedSettingsPaths(platform: NodeJS.Platform = process.platform): string[] {
  const list: string[] = []
  if (platform === 'darwin') list.push('/Library/Application Support/ClaudeCode/managed-settings.json')
  else if (platform === 'win32') list.push('C:\\Program Files\\ClaudeCode\\managed-settings.json')
  else list.push('/etc/claude-code/managed-settings.json')
  const dropIn = platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.d'
    : platform === 'win32' ? 'C:\\Program Files\\ClaudeCode\\managed-settings.d' : '/etc/claude-code/managed-settings.d'
  try {
    for (const f of fs.readdirSync(dropIn).sort()) if (f.endsWith('.json')) list.push(path.join(dropIn, f))
  } catch { /* no drop-in directory */ }
  return list
}

/** The wrapper command written into settings.json. Quoted like the hook command. */
export function wrapperCommand(env: Pick<InstallerEnv, 'home' | 'nodePath'>): string {
  return `"${env.nodePath}" "${paths(env.home).shim}"`
}

export function isWrapperCommand(command: unknown): boolean {
  return typeof command === 'string' && command.replace(/\\/g, '/').includes(STATUSLINE_SHIM_MARKER)
}

// ─── Reading ────────────────────────────────────────────────────────────────

type ReadResult = { ok: true; settings: Obj; raw: string; exists: boolean } | { ok: false; code: RefuseCode; message: string }

function readSettings(file: string): ReadResult {
  let raw: string
  try {
    const st = fs.statSync(file)
    if (st.size > MAX_SETTINGS_BYTES) return { ok: false, code: 'settings-invalid', message: `${file} is too large to be a settings file` }
    raw = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, settings: {}, raw: '', exists: false }
    return { ok: false, code: 'settings-unreadable', message: `could not read ${file}` }
  }
  if (raw.trim() === '') return { ok: true, settings: {}, raw, exists: true }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'settings-invalid', message: `${file} is not a JSON object` }
    return { ok: true, settings: parsed as Obj, raw, exists: true }
  } catch {
    // Parser messages can quote file content: say only that it does not parse.
    return { ok: false, code: 'settings-invalid', message: `${file} is not valid JSON; fix it first (Agent Flow never rewrites a file it cannot parse)` }
  }
}

function hasKey(o: Obj, k: string): boolean { return Object.prototype.hasOwnProperty.call(o, k) }

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a)) {
    const bb = b as unknown[]
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]))
  }
  const ka = Object.keys(a as Obj); const kb = Object.keys(b as Obj)
  return ka.length === kb.length && ka.every(k => hasKey(b as Obj, k) && deepEqual((a as Obj)[k], (b as Obj)[k]))
}

/** Indentation and trailing newline of an existing file, so a rewrite does not reformat it. */
function styleOf(raw: string): { indent: string | number; newline: boolean } {
  const m = /^[ \t]+(?=")/m.exec(raw)
  return { indent: m ? m[0] : 2, newline: raw === '' ? true : raw.endsWith('\n') }
}

function serializeLike(raw: string, value: unknown): string {
  const s = styleOf(raw)
  return JSON.stringify(value, null, s.indent) + (s.newline ? '\n' : '')
}

// ─── Inspect ────────────────────────────────────────────────────────────────

interface Record1 { v: 1; installedAt: string; hadStatusLine: boolean; /** settings.json did not exist before the install */ createdSettings?: boolean; original?: unknown; installed: unknown }

function readRecord(file: string): Record1 | null {
  try {
    const rec = JSON.parse(fs.readFileSync(file, 'utf-8')) as Obj
    if (rec && rec.v === 1 && typeof rec.hadStatusLine === 'boolean' && hasKey(rec, 'installed') && (rec.hadStatusLine ? hasKey(rec, 'original') : true)) return rec as unknown as Record1
  } catch { /* missing or broken */ }
  return null
}

function checkManaged(env: InstallerEnv): { code: RefuseCode; message: string } | null {
  for (const file of env.managedSettingsPaths ?? defaultManagedSettingsPaths()) {
    const r = readSettings(file)
    if (!r.ok) return { code: 'managed-unreadable', message: `a managed settings file (${file}) cannot be read, so it is not known whether it sets a statusLine` }
    if (r.exists && hasKey(r.settings, 'statusLine')) return { code: 'managed-statusline', message: `an organisation-managed settings file (${file}) sets a statusLine; it overrides your user settings, so the wrapper would never run` }
  }
  return null
}

function shadowing(env: InstallerEnv): string[] {
  const out: string[] = []
  for (const dir of env.workspaceDirs ?? []) {
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = path.join(dir, '.claude', name)
      const r = readSettings(file)
      if (r.ok && r.exists && hasKey(r.settings, 'statusLine')) out.push(file)
    }
  }
  return out
}

function environmentWarnings(env: InstallerEnv): string[] {
  const out: string[] = []
  const dir = env.claudeConfigDir ?? process.env.CLAUDE_CONFIG_DIR
  if (dir && path.resolve(dir) !== path.join(env.home, '.claude')) {
    out.push('CLAUDE_CONFIG_DIR is set in this environment: Claude Code reads its settings from there instead of ~/.claude, so the wrapper may not take effect')
  }
  return out
}

/** What an install would do right now, without writing anything. */
export function inspectStatusLine(env: InstallerEnv): StatusLineInspection {
  const p = paths(env.home)
  const base = { shadowedBy: shadowing(env), warnings: environmentWarnings(env) }
  const refuse = (code: RefuseCode, reason: string, state: StatusLineState = 'refused'): StatusLineInspection => ({ state, canInstall: false, code, reason, ...base })

  const r = readSettings(p.settings)
  if (!r.ok) return refuse(r.code, r.message)
  const sl = r.settings.statusLine

  if (hasKey(r.settings, 'statusLine') && sl && typeof sl === 'object' && !Array.isArray(sl) && isWrapperCommand((sl as Obj).command)) {
    const rec = readRecord(p.record)
    if (!rec) return refuse('record-missing', 'the wrapper is in settings.json but its saved original (~/.agent-flow/statusline-original.json) is missing or damaged; Agent Flow cannot restore your status line automatically', 'broken')
    if (!fs.existsSync(p.shim)) return refuse('io-error', 'the wrapper script (~/.claude/agent-flow/statusline-shim.js) is missing; reinstall to repair it', 'broken')
    return { state: 'installed', canInstall: false, ...base }
  }

  const managed = checkManaged(env)
  if (managed) return refuse(managed.code, managed.message)

  if (hasKey(r.settings, 'statusLine')) {
    if (!sl || typeof sl !== 'object' || Array.isArray(sl)) return refuse('statusline-not-object', 'the statusLine setting is not an object, so it cannot be chained safely')
    const o = sl as Obj
    if (o.type !== 'command') return refuse('statusline-not-command', `the statusLine type is ${typeof o.type === 'string' ? `"${o.type.slice(0, 40)}"` : 'not set'}; only a command status line can be chained`)
    if (typeof o.command !== 'string' || o.command.trim() === '' || o.command.length > MAX_COMMAND_CHARS || o.command.includes('\0')) {
      return refuse('statusline-command-unusable', 'the statusLine command is empty, too long or not text, so it cannot be chained safely')
    }
  }

  const node = checkNode(env)
  if (node) return refuse(node.code, node.message)
  return { state: 'not-installed', canInstall: true, ...base }
}

function checkNode(env: InstallerEnv): { code: RefuseCode; message: string } | null {
  const n = env.nodePath
  if (!n || !path.isAbsolute(n)) return { code: 'node-unavailable', message: 'the absolute path of the node binary is not known, so the wrapper command cannot be written safely' }
  try { fs.accessSync(n, fs.constants.X_OK) } catch { return { code: 'node-unavailable', message: `node (${n}) is not executable` } }
  for (const s of [n, env.home]) {
    if (/["\0\r\n]/.test(s)) return { code: 'path-unsafe', message: 'a path contains a character that cannot be put in the wrapper command safely' }
  }
  return null
}

// ─── Install ────────────────────────────────────────────────────────────────

function writeFileAtomic(file: string, content: string, mode: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    fs.writeFileSync(tmp, content, { mode, flag: 'wx' })
    fs.chmodSync(tmp, mode)
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch { /* nothing to clean */ }
    throw err
  }
}

function refusal(code: RefuseCode, message: string): ActionResult { return { ok: false, refused: true, code, message } }

export function installStatusLine(env: InstallerEnv): ActionResult {
  const insp = inspectStatusLine(env)
  const p = paths(env.home)
  if (insp.state === 'installed') {
    // Idempotent: nothing in settings.json changes. A newer shim script (an upgrade) is refreshed, it is ours.
    try { if (!fs.existsSync(p.shim) || fs.readFileSync(p.shim, 'utf-8') !== getShimScriptContent()) writeFileAtomic(p.shim, getShimScriptContent(), 0o755) } catch { /* keep the old script */ }
    return { ok: true, action: 'already-installed', message: 'The statusLine wrapper is already installed. Nothing changed.', shadowedBy: insp.shadowedBy, warnings: insp.warnings }
  }
  if (!insp.canInstall) return refusal(insp.code ?? 'io-error', `Not installed, nothing was changed: ${insp.reason ?? 'unsafe to chain'}. Limits stay estimated.`)

  const r = readSettings(p.settings)
  if (!r.ok) return refusal(r.code, r.message) // inspect passed a moment ago; a race, still refuse
  const had = hasKey(r.settings, 'statusLine')
  const original = had ? r.settings.statusLine : undefined
  const wrapper = wrapperCommand(env)
  const installed: Obj = had ? { ...(original as Obj), command: wrapper } : { type: 'command', command: wrapper }
  const next: Obj = { ...r.settings, statusLine: installed } // spread keeps key order; a new key lands last

  const created: string[] = []
  try {
    const shimExisted = fs.existsSync(p.shim)
    writeFileAtomic(p.shim, getShimScriptContent(), 0o755)
    if (!shimExisted) created.push(p.shim)
    const record: Record1 = { v: 1, installedAt: new Date().toISOString(), hadStatusLine: had, ...(r.exists ? {} : { createdSettings: true }), ...(had ? { original } : {}), installed }
    const recordExisted = fs.existsSync(p.record)
    writeFileAtomic(p.record, JSON.stringify(record, null, 2) + '\n', 0o600)
    if (!recordExisted) created.push(p.record)
    if (r.exists) writeFileAtomic(p.backup, r.raw, 0o600)
    const mode = r.exists ? fs.statSync(p.settings).mode & 0o777 : 0o600
    writeFileAtomic(p.settings, serializeLike(r.raw, next), mode)
  } catch {
    for (const f of created) { try { fs.unlinkSync(f) } catch { /* best effort */ } }
    return refusal('io-error', 'Not installed: a file could not be written. settings.json was not changed.')
  }
  const extra = insp.shadowedBy.length > 0 ? ` Limits may not be observed in projects that set their own statusLine (${insp.shadowedBy.length} found in the open workspace).` : ''
  return {
    ok: true, action: 'installed', shadowedBy: insp.shadowedBy, warnings: insp.warnings,
    message: (had ? 'Installed. Your existing status line still runs unchanged; ' : 'Installed. You had no status line, so none is shown; ')
      + `usage limits are saved to ~/.agent-flow/limits/claude.json after the next Claude Code reply.${extra}`,
  }
}

// ─── Uninstall ──────────────────────────────────────────────────────────────

function removeOurFiles(env: InstallerEnv): void {
  const p = paths(env.home)
  for (const f of [p.shim, p.record, p.limits, p.backup]) { try { fs.unlinkSync(f) } catch { /* not there */ } }
  try { fs.rmdirSync(p.limitsDir) } catch { /* not empty or not there: leave it */ }
}

export function uninstallStatusLine(env: InstallerEnv): ActionResult {
  const p = paths(env.home)
  const r = readSettings(p.settings)
  if (!r.ok) return refusal(r.code, r.message)
  const sl = r.settings.statusLine
  const ours = hasKey(r.settings, 'statusLine') && !!sl && typeof sl === 'object' && !Array.isArray(sl) && isWrapperCommand((sl as Obj).command)

  if (!ours) {
    const leftovers = [p.shim, p.record, p.limits].some(f => fs.existsSync(f))
    if (!leftovers) return { ok: true, action: 'nothing-to-remove', message: 'The statusLine wrapper is not installed. Nothing to remove.' }
    removeOurFiles(env)
    return { ok: true, action: 'left-alone', message: 'Your statusLine setting no longer points to Agent Flow, so it was left as it is. Agent Flow\'s own files were removed.' }
  }

  const rec = readRecord(p.record)
  if (!rec) return refusal('record-missing', 'Not removed, nothing was changed: the saved original (~/.agent-flow/statusline-original.json) is missing or damaged, so your status line cannot be restored automatically. Edit the statusLine entry in ~/.claude/settings.json by hand.')
  if (!deepEqual(sl, rec.installed)) {
    return refusal('modified-after-install', 'Not removed, nothing was changed: the statusLine entry was edited after the wrapper was installed. Restore it by hand (the original is in ~/.agent-flow/statusline-original.json).')
  }

  const next: Obj = { ...r.settings }
  if (rec.hadStatusLine) next.statusLine = rec.original // the key keeps its position
  else delete next.statusLine
  try {
    if (rec.createdSettings === true && Object.keys(next).length === 0) {
      fs.unlinkSync(p.settings) // we created the file for the wrapper alone: leave no empty file behind
    } else {
      const mode = fs.statSync(p.settings).mode & 0o777
      writeFileAtomic(p.settings, serializeLike(r.raw, next), mode)
    }
  } catch {
    return refusal('io-error', 'Not removed: settings.json could not be written. It was not changed.')
  }
  removeOurFiles(env)
  return { ok: true, action: 'uninstalled', message: rec.hadStatusLine ? 'Removed. Your original status line is back exactly as it was.' : 'Removed. The statusLine entry is gone again.' }
}

// ─── Environment ────────────────────────────────────────────────────────────

/** The real environment: HOME from the OS, managed files from the default locations. */
export function defaultInstallerEnv(opts: { nodePath: string; workspaceDirs?: string[]; home?: string }): InstallerEnv {
  return { home: opts.home ?? os.homedir(), nodePath: opts.nodePath, workspaceDirs: opts.workspaceDirs }
}
