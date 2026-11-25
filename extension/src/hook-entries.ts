/**
 * Pure helpers for reading and rewriting Claude Code settings.json hook entries.
 *
 * Kept free of `vscode` so they can be unit tested. scripts/setup.js and
 * extension/scripts/uninstall.js are plain JS and mirror the matching rules;
 * keep the three in sync.
 */

import * as fs from 'fs'
import * as path from 'path'
import { ClaudeHookDef, ClaudeHookEntry } from './protocol'
import { HOOK_COMMAND_MARKER } from './discovery'

/**
 * Legacy Agent Flow HTTP hooks pointed straight at the hook server's origin
 * (`http://127.0.0.1:<port>`, no path). Other tools also register loopback
 * HTTP hooks, usually with a path, so we must only ever match the bare origin.
 */
const LEGACY_HOOK_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/?$/

export function isLegacyAgentFlowHookUrl(url: string | undefined): boolean {
  return typeof url === 'string' && LEGACY_HOOK_URL_RE.test(url)
}

function isAgentFlowHookDef(h: ClaudeHookDef): boolean {
  // Normalize backslashes so Windows paths (C:\...\agent-flow\hook.js) match.
  return !!h.command?.replace(/\\/g, '/').includes(HOOK_COMMAND_MARKER) ||
    isLegacyAgentFlowHookUrl(h.url)
}

/** Check whether a single hook entry belongs to Agent Flow */
export function isAgentFlowHook(entry: ClaudeHookEntry): boolean {
  return !!entry?.hooks?.some(isAgentFlowHookDef)
}

export type SettingsReadResult =
  | { ok: true; settings: Record<string, unknown> }
  | { ok: false; error: string }

/**
 * Read a settings file. A missing file reads as `{}`. A file that exists but
 * can't be parsed is reported as an error so callers never overwrite it. So is
 * a symlink whose target is missing (or that loops): writing would replace the
 * link with a regular file, so it is refused like the statusLine installer does.
 */
export function readSettingsFile(settingsPath: string): SettingsReadResult {
  let raw: string
  try {
    raw = fs.readFileSync(settingsPath, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (isDanglingLink(settingsPath)) { return { ok: false, error: danglingLinkMessage(settingsPath) } }
      return { ok: true, settings: {} }
    }
    return { ok: false, error: (err as Error).message }
  }
  if (raw.trim() === '') { return { ok: true, settings: {} } }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'top-level value is not an object' }
    }
    return { ok: true, settings: parsed }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** True when `p` is itself a symlink (lstat succeeds) but nothing readable is behind it. */
function isDanglingLink(p: string): boolean {
  try { return fs.lstatSync(p).isSymbolicLink() } catch { return false }
}

function danglingLinkMessage(p: string): string {
  return `${p} is a symbolic link that cannot be followed (missing target or a loop); fix the link first`
}

/**
 * Write JSON via temp file + rename so a crash mid-write can't truncate the file.
 *
 * - A symlinked file (dotfile managers) is written THROUGH: tmp next to the real target, rename onto the target, so the link stays a link.
 * - A link that cannot be followed is refused (throws), never replaced by a regular file.
 * - The existing file's mode is kept (the target's, through a link); a new file is 0600.
 * - The temp file is created exclusively with a random suffix and removed if anything fails.
 *
 * Mirrored in scripts/setup.js; keep the two in sync.
 */
export function writeJsonAtomic(requestedPath: string, value: unknown): void {
  let filePath = requestedPath
  let isLink = false
  try { isLink = fs.lstatSync(requestedPath).isSymbolicLink() } catch { /* missing file: create it at the requested path */ }
  if (isLink) {
    try { filePath = fs.realpathSync(requestedPath) } catch { throw new Error(danglingLinkMessage(requestedPath)) }
  }
  let mode = 0o600
  try { mode = fs.statSync(filePath).mode & 0o777 } catch { /* new file */ }
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2) + '\n', { mode, flag: 'wx' })
    fs.chmodSync(tmpPath, mode) // the umask can narrow the create mode; chmod is exact
    fs.renameSync(tmpPath, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* nothing to clean */ }
    throw err
  }
}

/**
 * Replace Agent Flow's entries for each event with `hookEntry`, leaving every
 * other tool's hooks untouched. Mutates and returns `settings`.
 */
export function mergeAgentFlowHooks(
  settings: Record<string, unknown>,
  hookEntry: ClaudeHookEntry,
  events: readonly string[],
): Record<string, unknown> {
  const hooks = (settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}) as Record<string, unknown>
  for (const event of events) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] as ClaudeHookEntry[] : []
    hooks[event] = [...existing.filter(entry => !isAgentFlowHook(entry)), hookEntry]
  }
  settings.hooks = hooks
  return settings
}

/** True if any event in `settings` has an Agent Flow hook. */
export function hasAgentFlowHook(settings: Record<string, unknown>): boolean {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object') { return false }
  return Object.values(hooks).some(entries =>
    Array.isArray(entries) && entries.some(entry => isAgentFlowHook(entry as ClaudeHookEntry)),
  )
}

/**
 * Rewrite legacy Agent Flow HTTP hooks into command hooks in place.
 * Returns true if anything changed.
 */
export function migrateLegacyHttpHooks(
  settings: Record<string, unknown>,
  hookCommand: string,
  timeoutS: number,
): boolean {
  const hooks = settings.hooks
  if (!hooks || typeof hooks !== 'object') { return false }
  let changed = false
  for (const entries of Object.values(hooks)) {
    if (!Array.isArray(entries)) { continue }
    for (const entry of entries as ClaudeHookEntry[]) {
      for (const h of entry?.hooks ?? []) {
        if (!isLegacyAgentFlowHookUrl(h.url)) { continue }
        delete h.url
        h.type = 'command'
        h.command = hookCommand
        if (h.timeout === undefined) { h.timeout = timeoutS }
        changed = true
      }
    }
  }
  return changed
}
