/**
 * History of observed limit readings (P6b). The statusLine shim keeps only the LAST reading; the estimate needs pairs
 * of (observed %, local usage) over time to calibrate a budget, so the host appends each reading that moved to
 * `~/.agent-flow/limits/claude-history.json` (numbers only: time, used %, reset time; no session, model, prompt or path).
 * No `vscode` import: the extension host and the relay share it.
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ObservedReading } from './protocol'

export const HISTORY_FILE = 'claude-history.json'
export const HISTORY_VERSION = 1
/** Readings kept (about 30 days of a moving meter) and the age after which one is dropped. */
export const HISTORY_MAX = 400
export const HISTORY_MAX_AGE_MS = 35 * 24 * 3_600_000
/** A reading whose numbers did not move is stored again only after this long (keeps a quiet meter from filling the file). */
export const HISTORY_REPEAT_MS = 30 * 60_000
const MAX_BYTES = 256 * 1024
/** How many readings go to the page (the newest). */
export const HISTORY_SENT = 200

type Obj = Record<string, unknown>
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function parseWindow(v: unknown): { usedPct: number; resetsAt: number } | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const w = v as Obj
  return finite(w.usedPct) && w.usedPct >= 0 && w.usedPct <= 1000 && finite(w.resetsAt) && w.resetsAt > 0 ? { usedPct: w.usedPct, resetsAt: w.resetsAt } : undefined
}

/** The readings of a history file's text (oldest first); an unusable file is an empty history. Never throws. */
export function parseHistory(text: string): ObservedReading[] {
  let doc: unknown
  try { doc = JSON.parse(text) } catch { return [] }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || (doc as Obj).v !== HISTORY_VERSION || !Array.isArray((doc as Obj).readings)) return []
  const out: ObservedReading[] = []
  for (const r of (doc as Obj).readings as unknown[]) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue
    const o = r as Obj
    if (!finite(o.at) || o.at <= 0) continue
    const fiveHour = parseWindow(o.fiveHour)
    const sevenDay = parseWindow(o.sevenDay)
    if (!fiveHour && !sevenDay) continue
    out.push({ at: o.at, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) })
  }
  return out.sort((a, b) => a.at - b.at)
}

export function readHistory(file: string): ObservedReading[] {
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_BYTES) return []
    return parseHistory(fs.readFileSync(file, 'utf-8'))
  } catch { return [] }
}

/** The reading of a parsed limits file: only the two known windows, only when they carry both numbers. */
export function readingOf(parsed: { at: number; windows: { kind: string; usedPct: number | null; resetsAt: number | null }[] }): ObservedReading | null {
  const pick = (kind: string) => {
    const w = parsed.windows.find(x => x.kind === kind)
    return w && w.usedPct !== null && w.resetsAt !== null ? { usedPct: w.usedPct, resetsAt: w.resetsAt } : undefined
  }
  const fiveHour = pick('five_hour')
  const sevenDay = pick('seven_day')
  if (!fiveHour && !sevenDay) return null
  return { at: parsed.at, ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) }
}

const sameNumbers = (a: ObservedReading, b: ObservedReading): boolean =>
  JSON.stringify([a.fiveHour, a.sevenDay]) === JSON.stringify([b.fiveHour, b.sevenDay])

/** The history with `r` added (or unchanged when it adds nothing), trimmed by age and count. */
export function appendReading(history: readonly ObservedReading[], r: ObservedReading, now: number): ObservedReading[] {
  const last = history[history.length - 1]
  let next = [...history]
  if (!last || (r.at > last.at && (!sameNumbers(last, r) || r.at - last.at >= HISTORY_REPEAT_MS))) next.push(r)
  next = next.filter(x => now - x.at <= HISTORY_MAX_AGE_MS)
  return next.length > HISTORY_MAX ? next.slice(next.length - HISTORY_MAX) : next
}

/** Record `r` in the history file (private file, atomic). Returns the history now on disk; never throws. */
export function recordReading(file: string, r: ObservedReading, now: number): ObservedReading[] {
  const before = readHistory(file)
  const after = appendReading(before, r, now)
  if (after.length === before.length && after[after.length - 1]?.at === before[before.length - 1]?.at) return before
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ v: HISTORY_VERSION, readings: after }) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch { /* the history is a convenience: keep working without it */ }
  return after
}
