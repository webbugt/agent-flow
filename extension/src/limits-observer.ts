/**
 * Observed Claude Code usage limits (PLAN v2 P6a). Reads `~/.agent-flow/limits/claude.json`, which the statusLine
 * shim writes (statusline-shim.ts), and combines it with the state of the wrapper install into one
 * `limits-update` payload for the UI. No `vscode` import: the extension host and the relay share it.
 *
 * What the file means:
 *  - It holds the last `rate_limits` Claude Code reported, as numbers only (`used_percentage` 0-100, `resets_at`
 *    epoch SECONDS). Windows are classified by key: `five_hour`, `seven_day`, anything else is `other` (the shim
 *    keeps unknown window names, so a future per-model window would show up without a code change).
 *  - It is the meter of the whole account, not of one session.
 *  - Absent file / absent window = unknown, never 0. A file that does not parse is reported as an error without
 *    quoting its content.
 *
 * Freshness: the status line only refreshes while Claude Code's TUI is running, so a reading ages. After
 * LIMITS_STALE_MS the UI shows `as of HH:MM` and the `stale` tag instead of `obs`. A window whose `resets_at` has
 * passed is `expired`: its percentage belongs to a window that ended, so the UI shows no value for it.
 *
 * Codex `rate_limits` are deliberately not parsed (out of scope, Webbugt decision 5).
 */
import * as fs from 'fs'
import * as path from 'path'
import type { LimitsUpdatePayload, ObservedLimitWindow, ObservedWindowKind } from './protocol'
import { inspectStatusLine, paths, type InstallerEnv } from './statusline-installer'
import { LIMITS_FILE_VERSION } from './statusline-shim'
import { createLogger } from './logger'
import { HISTORY_FILE, HISTORY_SENT, readHistory, readingOf, recordReading } from './limits-history'

const log = createLogger('Limits')

/** A reading older than this is shown as stale. */
export const LIMITS_STALE_MS = 10 * 60 * 1000
/** The limits file is tiny; anything bigger is not ours. */
const MAX_LIMITS_BYTES = 64 * 1024
/** Poll period: picks up new readings, install changes and fresh -> stale transitions. */
export const LIMITS_POLL_MS = 5000

type Obj = Record<string, unknown>

export type ParsedLimitsFile =
  | { ok: true; at: number; modelId?: string; windows: { key: string; kind: ObservedWindowKind; usedPct: number | null; resetsAt: number | null }[] }
  | { ok: false; error: string }

export function windowKind(key: string): ObservedWindowKind {
  return key === 'five_hour' ? 'five_hour' : key === 'seven_day' ? 'seven_day' : 'other'
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** `resets_at` is epoch seconds; a value that is clearly milliseconds is accepted too. Returns ms. */
function resetsToMs(v: number): number { return v > 1e11 ? v : v * 1000 }

/** Parse the file's text. Never throws; never echoes content in the error. */
export function parseLimitsFile(text: string): ParsedLimitsFile {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return { ok: false, error: 'the limits file is not valid JSON' } }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, error: 'the limits file is not a JSON object' }
  const o = doc as Obj
  if (o.v !== LIMITS_FILE_VERSION) return { ok: false, error: 'the limits file has an unknown version' }
  if (!finite(o.at) || o.at <= 0) return { ok: false, error: 'the limits file has no valid timestamp' }
  const rl = o.rate_limits
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return { ok: false, error: 'the limits file has no rate_limits' }
  const windows: { key: string; kind: ObservedWindowKind; usedPct: number | null; resetsAt: number | null }[] = []
  for (const key of Object.keys(rl as Obj)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue
    const w = (rl as Obj)[key]
    if (!w || typeof w !== 'object' || Array.isArray(w)) continue
    const used = (w as Obj).used_percentage
    const resets = (w as Obj).resets_at
    const usedPct = finite(used) && used >= 0 ? used : null
    const resetsAt = finite(resets) && resets > 0 ? resetsToMs(resets) : null
    if (usedPct === null && resetsAt === null) continue
    windows.push({ key, kind: windowKind(key), usedPct, resetsAt })
  }
  // Stable order: the two known windows first
  const rank = (k: ObservedWindowKind) => (k === 'five_hour' ? 0 : k === 'seven_day' ? 1 : 2)
  windows.sort((a, b) => rank(a.kind) - rank(b.kind) || a.key.localeCompare(b.key))
  const model = o.model && typeof o.model === 'object' ? (o.model as Obj).id : undefined
  return { ok: true, at: o.at, ...(typeof model === 'string' && /^[A-Za-z0-9._:/-]{1,128}$/.test(model) ? { modelId: model } : {}), windows }
}

/** Read and parse the file; `null` when it does not exist. */
export function readLimitsFile(file: string): ParsedLimitsFile | null {
  let text: string
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return { ok: false, error: 'the limits file is not a regular file' }
    if (st.size > MAX_LIMITS_BYTES) return { ok: false, error: 'the limits file is too large' }
    text = fs.readFileSync(file, 'utf-8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return { ok: false, error: 'the limits file cannot be read' }
  }
  return parseLimitsFile(text)
}

/** Classify the windows of a parsed file at `now` (ms). */
export function classifyWindows(parsed: Extract<ParsedLimitsFile, { ok: true }>, now: number, staleMs = LIMITS_STALE_MS): { stale: boolean; windows: ObservedLimitWindow[] } {
  const stale = now - parsed.at > staleMs
  const windows = parsed.windows.map((w): ObservedLimitWindow => {
    const expired = w.resetsAt !== null && w.resetsAt <= now
    return { key: w.key, kind: w.kind, usedPct: expired ? null : w.usedPct, resetsAt: w.resetsAt, state: expired ? 'expired' : stale ? 'stale' : 'fresh' }
  })
  return { stale, windows }
}

export interface BuildOptions {
  env: InstallerEnv
  now: number
  seq: number
  /** The host can install / remove the wrapper from the UI (VS Code, standalone app). */
  canConfigure: boolean
  staleMs?: number
}

/** The `limits-update` payload for the current state of the files. Pure apart from reading them. */
export function buildLimitsUpdate(opts: BuildOptions): LimitsUpdatePayload {
  const insp = inspectStatusLine(opts.env)
  const p = paths(opts.env.home)
  const parsed = readLimitsFile(p.limits)
  const history = readHistory(path.join(p.limitsDir, HISTORY_FILE)).slice(-HISTORY_SENT)
  const base: LimitsUpdatePayload = {
    version: 1, seq: opts.seq, provider: 'claude', source: 'statusline', canConfigure: opts.canConfigure,
    install: {
      state: insp.state, canInstall: insp.canInstall,
      ...(insp.reason ? { reason: insp.reason } : {}),
      ...(insp.code ? { code: insp.code } : {}),
      ...(insp.shadowedBy.length > 0 ? { shadowedBy: insp.shadowedBy.map(f => tilde(f, opts.env.home)) } : {}),
      ...(insp.warnings.length > 0 ? { warnings: insp.warnings } : {}),
    },
    observed: null,
    ...(history.length > 0 ? { history } : {}),
  }
  if (parsed === null) return base
  if (!parsed.ok) return { ...base, fileError: parsed.error }
  const c = classifyWindows(parsed, opts.now, opts.staleMs)
  return { ...base, observed: { at: parsed.at, stale: c.stale, ...(parsed.modelId ? { modelId: parsed.modelId } : {}), windows: c.windows } }
}

function tilde(file: string, home: string): string {
  const rel = path.relative(home, file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? `~${path.sep}${rel}` : file
}

/** Same payload apart from `seq` (what decides whether to publish again). */
function sameContent(a: LimitsUpdatePayload, b: LimitsUpdatePayload): boolean {
  return JSON.stringify({ ...a, seq: 0 }) === JSON.stringify({ ...b, seq: 0 })
}

export interface LimitsObserverOptions {
  env: () => InstallerEnv
  canConfigure: boolean
  pollMs?: number
  now?: () => number
}

/**
 * Polls the files, and calls `onChange` with a new payload when anything the UI shows changed (a reading, a
 * fresh -> stale transition, an install or refusal). Cheap: two or three tiny files every few seconds.
 */
export class LimitsObserver {
  private timer: ReturnType<typeof setInterval> | null = null
  private last: LimitsUpdatePayload | null = null
  private seq = 0
  private readonly listeners = new Set<(p: LimitsUpdatePayload) => void>()

  constructor(private readonly opts: LimitsObserverOptions) {}

  start(): void {
    if (this.timer) return
    this.refresh()
    this.timer = setInterval(() => this.refresh(), this.opts.pollMs ?? LIMITS_POLL_MS)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
  }

  onChange(fn: (p: LimitsUpdatePayload) => void): () => void {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }

  /** The newest payload (computed on first use). */
  snapshot(): LimitsUpdatePayload {
    return this.last ?? this.refresh()
  }

  /** Append the file's newest reading to the history (the shim keeps only the last one). A failure only costs history. */
  private recordLatest(): void {
    try {
      const env = this.opts.env()
      const p = paths(env.home)
      const parsed = readLimitsFile(p.limits)
      if (!parsed || !parsed.ok) return
      const r = readingOf(parsed)
      if (r) recordReading(path.join(p.limitsDir, HISTORY_FILE), r, (this.opts.now ?? Date.now)())
    } catch { /* keep going without history */ }
  }

  /** Re-read now (after an install, or on a poll tick); publishes only a real change. */
  refresh(): LimitsUpdatePayload {
    let next: LimitsUpdatePayload
    try {
      this.recordLatest()
      next = buildLimitsUpdate({ env: this.opts.env(), now: (this.opts.now ?? Date.now)(), seq: this.seq + 1, canConfigure: this.opts.canConfigure })
    } catch (err) {
      log.warn('Could not read the limits state:', err instanceof Error ? err.message : 'unknown error')
      return this.last ?? { version: 1, seq: this.seq, provider: 'claude', source: 'statusline', canConfigure: false, install: { state: 'refused', canInstall: false, reason: 'the limits state could not be read' }, observed: null }
    }
    if (this.last && sameContent(this.last, next)) return this.last
    this.seq = next.seq
    this.last = next
    for (const fn of [...this.listeners]) {
      try { fn(next) } catch (err) { log.warn('limits listener failed:', err instanceof Error ? err.message : 'unknown error') }
    }
    return next
  }
}

/** The message the host sends (same wrapper shape as `costsConfigMessage`). */
export function limitsUpdateMessage(limits: LimitsUpdatePayload): { type: 'limits-update'; limits: LimitsUpdatePayload } {
  return { type: 'limits-update', limits }
}
