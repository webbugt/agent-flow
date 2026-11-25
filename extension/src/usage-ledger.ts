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
  const timed = typeof meta.latencySeconds === 'number' && Number.isFinite(meta.latencySeconds) && meta.latencySeconds >= 0
  return {
    ...flat,
    model: meta.model ?? prev?.model,
    ...((meta.provider ?? prev?.provider) ? { provider: meta.provider ?? prev?.provider } : {}),
    byBucket: { ...(prev?.byBucket ?? {}), [bucket]: addCounts(prev?.byBucket?.[bucket], delta) },
    calls: (prev?.calls ?? 0) + 1,
    timedCalls: (prev?.timedCalls ?? 0) + (timed ? 1 : 0),
    latencySeconds: (prev?.latencySeconds ?? 0) + (timed ? (meta.latencySeconds as number) : 0),
  }
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
      { model: isRealModel(message.model) ? message.model : undefined, provider: CLAUDE_CODE_PROVIDER },
    ),
  )
  return true
}
