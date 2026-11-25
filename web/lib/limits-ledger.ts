/**
 * The usage ledger of ALL sessions for the plan-limit estimate (P6b). A plan limit is one meter for the whole account,
 * so the sum over every Hermes profile and Claude Code session counts, not only the open tab. Each agent's
 * `context_update` events carry its cumulative `spend` (including the 10-minute `byTime` buckets), so the newest one
 * per (session, agent) is that agent's whole ledger.
 */
import type { UsageTokens } from './costs/types'
import { parseByTime } from '@/hooks/simulation/handle-message-events'

export interface LedgerEvent { type: string; payload?: unknown }

/** `byTime` of every agent that has one, newest `context_update` of each (session, agent) pair. */
export function collectByTime(
  sessionIds: readonly string[],
  eventsOf: (sessionId: string) => readonly LedgerEvent[],
): Record<string, UsageTokens>[] {
  const out: Record<string, UsageTokens>[] = []
  for (const id of sessionIds) {
    const latest = new Map<string, unknown>()
    for (const e of eventsOf(id)) {
      if (e.type !== 'context_update' || !e.payload || typeof e.payload !== 'object') continue
      const p = e.payload as Record<string, unknown>
      const spend = p.spend
      if (typeof p.agent !== 'string' || !spend || typeof spend !== 'object') continue
      const raw = (spend as Record<string, unknown>).byTime
      if (raw) latest.set(p.agent, raw)
    }
    for (const raw of latest.values()) {
      const byTime = parseByTime(raw)
      if (byTime) out.push(byTime)
    }
  }
  return out
}
