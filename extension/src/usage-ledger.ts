/**
 * Accumulates the billed token usage Claude Code records on each assistant
 * message (`message.usage`). Claude Code writes one transcript line per content
 * block, and every line of one API response repeats the same usage, so each
 * message id is counted once.
 */
import type { SpendTotals, WatchedSession } from './protocol'

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
  const prev: SpendTotals = session.spendByAgent.get(agentName) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
  }
  session.spendByAgent.set(agentName, {
    inputTokens: prev.inputTokens + num(u.input_tokens),
    outputTokens: prev.outputTokens + num(u.output_tokens),
    cacheReadTokens: prev.cacheReadTokens + num(u.cache_read_input_tokens),
    cacheWrite5mTokens: prev.cacheWrite5mTokens + writes.fiveMin,
    cacheWrite1hTokens: prev.cacheWrite1hTokens + writes.oneHour,
    model: isRealModel(message.model) ? message.model : prev.model,
  })
  return true
}
