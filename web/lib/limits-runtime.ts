/**
 * Client store of the observed Claude limits (task P6a): the latest `limits-update` message from the host (VS Code
 * extension or relay), checked field by field. A malformed message is ignored and the previous state stays; the
 * newest valid message wins (a restarted host starts `seq` over, like the costs config).
 */
import type { LimitsUpdatePayload, ObservedLimitWindow, ObservedReading, ObservedWindowKind } from './costs/observed-types'

let current: LimitsUpdatePayload | null = null
const listeners = new Set<() => void>()

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown, max: number): string | undefined => (typeof v === 'string' ? v.slice(0, max) : undefined)
const KINDS: readonly ObservedWindowKind[] = ['five_hour', 'seven_day', 'other']
const INSTALL_STATES = ['not-installed', 'installed', 'refused', 'broken'] as const
const WINDOW_STATES = ['fresh', 'stale', 'expired'] as const

function parseWindow(v: unknown): ObservedLimitWindow | null {
  if (!isObj(v) || typeof v.key !== 'string' || v.key.length === 0 || v.key.length > 40) return null
  if (!KINDS.includes(v.kind as ObservedWindowKind)) return null
  if (!WINDOW_STATES.includes(v.state as (typeof WINDOW_STATES)[number])) return null
  const usedPct = v.usedPct === null ? null : num(v.usedPct) && v.usedPct >= 0 ? v.usedPct : undefined
  const resetsAt = v.resetsAt === null ? null : num(v.resetsAt) && v.resetsAt > 0 ? v.resetsAt : undefined
  if (usedPct === undefined || resetsAt === undefined) return null
  return { key: v.key, kind: v.kind as ObservedWindowKind, usedPct, resetsAt, state: v.state as ObservedLimitWindow['state'] }
}

function parseReadingWindow(v: unknown): { usedPct: number; resetsAt: number } | undefined {
  return isObj(v) && num(v.usedPct) && v.usedPct >= 0 && v.usedPct <= 1000 && num(v.resetsAt) && v.resetsAt > 0 ? { usedPct: v.usedPct, resetsAt: v.resetsAt } : undefined
}

/** Readings that do not have the expected shape are dropped one by one (a bad one never hides the others). */
function parseHistory(v: unknown): ObservedReading[] | undefined {
  if (!Array.isArray(v)) return undefined
  const out: ObservedReading[] = []
  for (const r of v.slice(-200)) {
    if (!isObj(r) || !num(r.at) || r.at <= 0) continue
    const fiveHour = parseReadingWindow(r.fiveHour)
    const sevenDay = parseReadingWindow(r.sevenDay)
    if (!fiveHour && !sevenDay) continue
    out.push({ at: r.at, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) })
  }
  return out.length > 0 ? out : undefined
}

/** The payload when it has the expected shape (strings cut to a sane length), else null. */
export function parseLimitsPayload(v: unknown): LimitsUpdatePayload | null {
  if (!isObj(v) || v.version !== 1 || !num(v.seq) || v.provider !== 'claude' || v.source !== 'statusline') return null
  if (typeof v.canConfigure !== 'boolean' || !isObj(v.install)) return null
  const i = v.install
  if (!INSTALL_STATES.includes(i.state as (typeof INSTALL_STATES)[number]) || typeof i.canInstall !== 'boolean') return null
  const list = (x: unknown): string[] | undefined => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(0, 8).map(s => s.slice(0, 400)) : undefined)
  const shadowedBy = list(i.shadowedBy)
  const warnings = list(i.warnings)
  const reason = str(i.reason, 600)
  const code = str(i.code, 60)
  let observed: LimitsUpdatePayload['observed'] = null
  if (v.observed !== null && v.observed !== undefined) {
    const o = v.observed
    if (!isObj(o) || !num(o.at) || o.at <= 0 || typeof o.stale !== 'boolean' || !Array.isArray(o.windows)) return null
    const windows = o.windows.slice(0, 12).map(parseWindow)
    if (windows.some(w => w === null)) return null
    const modelId = str(o.modelId, 128)
    observed = { at: o.at, stale: o.stale, ...(modelId ? { modelId } : {}), windows: windows as ObservedLimitWindow[] }
  }
  const fileError = str(v.fileError, 200)
  const history = parseHistory(v.history)
  return {
    version: 1, seq: v.seq, provider: 'claude', source: 'statusline', canConfigure: v.canConfigure,
    install: {
      state: i.state as LimitsUpdatePayload['install']['state'], canInstall: i.canInstall,
      ...(reason ? { reason } : {}), ...(code ? { code } : {}), ...(shadowedBy ? { shadowedBy } : {}), ...(warnings ? { warnings } : {}),
    },
    observed, ...(history ? { history } : {}), ...(fileError ? { fileError } : {}),
  }
}

/** Apply one message. Returns false (and changes nothing) when it is malformed. */
export function applyLimitsPayload(v: unknown): boolean {
  const p = parseLimitsPayload(v)
  if (!p) return false
  current = p
  for (const l of [...listeners]) l()
  return true
}

export function getLimits(): LimitsUpdatePayload | null { return current }

export function subscribeLimits(l: () => void): () => void {
  listeners.add(l)
  return () => { listeners.delete(l) }
}

/** Tests only. */
export function resetLimitsRuntime(): void {
  current = null
  for (const l of [...listeners]) l()
}
