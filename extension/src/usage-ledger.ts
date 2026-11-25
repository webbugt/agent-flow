/**
 * Accumulates the billed token usage Claude Code records on each assistant
 * message (`message.usage`). Claude Code writes one transcript line per content
 * block, and every line of one API response repeats the same usage, so each
 * message id is counted once.
 */
import type { SpendTotals, TokenCounts, WatchedSession } from './protocol'
import { promptBucket } from './spend-tiers'

interface UsageSource {
  id?: unknown
  model?: unknown
  usage?: unknown
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function isRealModel(model: unknown): model is string {
  return typeof model === 'string' && model.length > 0 && !model.startsWith('<')
}

/** Provider id for usage read from Claude Code transcripts (subscription or API: the user's config says which). */
export const CLAUDE_CODE_PROVIDER = 'anthropic'

/** One API call's usage. `input` is the NEW (uncached) input only, as in `SpendTotals`. */
export type UsageDelta = TokenCounts

export interface UsageMeta {
  model?: string
  provider?: string
  /** Latency of this call in seconds, when the source reports one */
  latencySeconds?: number
  /**
   * Prompt size of the request for the tier bucket. Default: input + cache read + cache write
   * (the same definition the catalog thresholds use).
   */
  promptTokens?: number
  /**
   * When the call happened (ms epoch). With a time, a model and a provider the call is also recorded in the
   * 10-minute buckets `byTime` that the plan-limit estimate (P6b) needs. Without one the call only counts in the totals.
   */
  atMs?: number
}

/** Width of one `byTime` bucket. Limit windows are 5 hours and 7 days, so 10 minutes is exact enough. */
export const TIME_SLOT_MS = 10 * 60 * 1000
/** `byTime` keeps this many slots behind the newest one (8 days: the weekly limit window plus a day of slack). */
export const TIME_SLOTS_KEPT = 8 * 24 * 6
/**
 * Resolution fades with age so the ledger that rides on every context update stays small: slots newer than this many
 * (6 hours) keep their 10 minutes, older ones are merged into hours (slot index rounded down to a multiple of 6).
 * The 5-hour window needs the fine slots; the weekly window does not need them.
 */
export const TIME_SLOTS_FINE = 6 * 6
export const TIME_SLOTS_PER_HOUR = 6
/** Hard cap on the number of `byTime` keys of one agent (many models in one slot would otherwise grow it). */
export const TIME_KEYS_MAX = 1500

/** Key of a `byTime` entry: `<slot>|<provider>|<model>|<prompt bucket>`. `|` inside an id is replaced. */
export function timeKey(slot: number, provider: string, model: string, bucket: string): string {
  return `${slot}|${provider.replace(/\|/g, '_')}|${model.replace(/\|/g, '_')}|${bucket}`
}

function slotOf(key: string): number { return Number(key.slice(0, key.indexOf('|'))) }

function addTimed(
  prev: Record<string, TokenCounts> | undefined, delta: UsageDelta, atMs: number | undefined,
  provider: string | undefined, model: string | undefined, bucket: string,
): Record<string, TokenCounts> | undefined {
  if (atMs === undefined || !Number.isFinite(atMs) || atMs <= 0 || !provider || !model) return prev
  const slot = Math.floor(atMs / TIME_SLOT_MS)
  const key = timeKey(slot, provider, model, bucket)
  const next: Record<string, TokenCounts> = { ...(prev ?? {}), [key]: addCounts(prev?.[key], delta) }
  // Drop what fell out of the kept range (relative to the newest slot, so replaying old history stays deterministic).
  let keys = Object.keys(next)
  let newest = slot
  for (const k of keys) { const sl = slotOf(k); if (sl > newest) newest = sl }
  const floor = newest - TIME_SLOTS_KEPT
  for (const k of keys) if (slotOf(k) < floor) delete next[k]
  // Older than the fine range: merge into the hour (same provider, model and bucket)
  const fineFloor = newest - TIME_SLOTS_FINE
  for (const k of Object.keys(next)) {
    const sl = slotOf(k)
    if (sl >= fineFloor || sl % TIME_SLOTS_PER_HOUR === 0) continue
    const rest = k.slice(k.indexOf('|'))
    const to = `${sl - (sl % TIME_SLOTS_PER_HOUR)}${rest}`
    next[to] = addCounts(next[to], next[k])
    delete next[k]
  }
  keys = Object.keys(next)
  if (keys.length > TIME_KEYS_MAX) {
    keys.sort((a, b) => slotOf(a) - slotOf(b))
    for (const k of keys.slice(0, keys.length - TIME_KEYS_MAX)) delete next[k]
  }
  return next
}

const COUNT_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWrite5mTokens', 'cacheWrite1hTokens'] as const

function addCounts(a: TokenCounts | undefined, b: TokenCounts): TokenCounts {
  const out = { ...(a ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 }) }
  for (const k of COUNT_KEYS) out[k] = (a?.[k] ?? 0) + b[k]
  return out
}

/**
 * Add one API call to an agent's running totals. Pure: returns a new object. Updates the flat
 * totals, the per-prompt-size bucket (so the buckets always sum to the flat totals), the call and
 * latency counters, and keeps the latest model and provider.
 */
export function addUsage(prev: SpendTotals | undefined, delta: UsageDelta, meta: UsageMeta = {}): SpendTotals {
  const flat = addCounts(prev, delta)
  const prompt = meta.promptTokens ?? delta.inputTokens + delta.cacheReadTokens + delta.cacheWrite5mTokens + delta.cacheWrite1hTokens
  const bucket = promptBucket(prompt)
  const byTime = addTimed(prev?.byTime, delta, meta.atMs, meta.provider ?? prev?.provider, meta.model ?? prev?.model, bucket)
  const timed = typeof meta.latencySeconds === 'number' && Number.isFinite(meta.latencySeconds) && meta.latencySeconds >= 0
  return {
    ...flat,
    model: meta.model ?? prev?.model,
    ...((meta.provider ?? prev?.provider) ? { provider: meta.provider ?? prev?.provider } : {}),
    byBucket: { ...(prev?.byBucket ?? {}), [bucket]: addCounts(prev?.byBucket?.[bucket], delta) },
    ...(byTime ? { byTime } : {}),
    calls: (prev?.calls ?? 0) + 1,
    timedCalls: (prev?.timedCalls ?? 0) + (timed ? 1 : 0),
    latencySeconds: (prev?.latencySeconds ?? 0) + (timed ? (meta.latencySeconds as number) : 0),
  }
}

/** A transcript `timestamp` (ISO 8601 text or ms epoch) as ms epoch; undefined when it is neither. */
export function timestampMs(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : undefined
  if (typeof v !== 'string') return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) && ms > 0 ? ms : undefined
}

/** Split cache-creation tokens into 5-minute and 1-hour buckets. */
export function splitCacheWrites(usage: Record<string, unknown>): { fiveMin: number; oneHour: number } {
  const total = num(usage.cache_creation_input_tokens)
  const detail = usage.cache_creation as Record<string, unknown> | undefined
  if (!detail || typeof detail !== 'object') return { fiveMin: total, oneHour: 0 }
  let fiveMin = num(detail.ephemeral_5m_input_tokens)
  const oneHour = num(detail.ephemeral_1h_input_tokens)
  // Any part of the total the breakdown does not name is treated as 5-minute.
  if (fiveMin + oneHour < total) fiveMin += total - (fiveMin + oneHour)
  return { fiveMin, oneHour }
}

/**
 * Add one assistant message's usage to the agent's running totals.
 * `fallbackKey` (the transcript line uuid) is used when the message has no id.
 * Returns true when the usage was counted, false when skipped.
 */
export function recordAssistantUsage(
  session: WatchedSession,
  agentName: string,
  message: UsageSource,
  fallbackKey?: string,
  /** The transcript line's `timestamp` (ISO text or ms epoch), when it has one. */
  timestamp?: unknown,
): boolean {
  const usage = message.usage
  if (!usage || typeof usage !== 'object') return false
  const key = typeof message.id === 'string' ? message.id : fallbackKey
  if (!key || session.seenUsageIds.has(key)) return false
  session.seenUsageIds.add(key)

  const u = usage as Record<string, unknown>
  const writes = splitCacheWrites(u)
  session.spendByAgent.set(
    agentName,
    addUsage(
      session.spendByAgent.get(agentName),
      {
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWrite5mTokens: writes.fiveMin,
        cacheWrite1hTokens: writes.oneHour,
      },
      // Claude Code transcripts carry no provider and no latency.
      { model: isRealModel(message.model) ? message.model : undefined, provider: CLAUDE_CODE_PROVIDER, atMs: timestampMs(timestamp) },
    ),
  )
  return true
}
