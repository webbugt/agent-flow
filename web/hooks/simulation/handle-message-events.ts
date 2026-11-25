import type { ContextBreakdown, SpendTotals, TokenCounts } from '@/lib/agent-types'
import type { EnergyUsage } from '@/lib/costs/types'
import type { ConversationMessage } from './types'
import { appendConversation, asString, asNumber, MAX_BUBBLES } from './types'
import type { MutableEventState } from './process-event'

export function handleMessage(
  payload: Record<string, unknown>,
  currentTime: number,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const content = asString(payload.content)
  const role = typeof payload.role === 'string' ? payload.role : undefined

  // Map role to conversation message type
  const msgType: ConversationMessage['type'] =
    role === 'user' ? 'user' :
    role === 'thinking' ? 'thinking' :
    'assistant'

  // Rename main agent to the first user message (more recognizable than "orchestrator")
  if (role === 'user') {
    const msgAgentForName = state.agents.get(agentName)
    if (msgAgentForName && msgAgentForName.isMain && msgAgentForName.name === agentName) {
      // Full text: the canvas fits the name to the node, the detail card shows the task.
      const fullName = content.replace(/\s+/g, ' ').trim()
      state.agents.set(agentName, { ...msgAgentForName, name: fullName || agentName, task: content })
    }
  }

  // Update agent state and push message bubble to queue
  const msgAgent = state.agents.get(agentName)
  if (msgAgent) {
    const bubbleRole: 'user' | 'thinking' | 'assistant' = role === 'user' ? 'user' : role === 'thinking' ? 'thinking' : 'assistant'
    const updates: Partial<typeof msgAgent> = {}

    {
      // Bubbles carry the full text for every role, thinking included. The canvas
      // draws the first lines that fit and the message feed panel shows all of it.
      const bubbleText = content
      // Dedup: skip if last bubble has the same text (dual event source race)
      const lastBubble = msgAgent.messageBubbles[msgAgent.messageBubbles.length - 1]
      if (!lastBubble || lastBubble.text !== bubbleText) {
        const newBubbles = [...msgAgent.messageBubbles, { text: bubbleText, time: currentTime, role: bubbleRole }]
        updates.messageBubbles = newBubbles.length > MAX_BUBBLES ? newBubbles.slice(-MAX_BUBBLES) : newBubbles
      }
    }

    if (msgAgent.state !== 'complete' && msgAgent.state !== 'tool_calling') {
      if (role === 'user' || role === 'thinking' || role === 'assistant') {
        updates.state = 'thinking'
      }
    }
    if (Object.keys(updates).length > 0) {
      state.agents.set(agentName, { ...msgAgent, ...updates })
    }
  }

  const at = typeof payload.at === 'number' && Number.isFinite(payload.at) ? payload.at : undefined
  const sender = typeof payload.sender === 'string' && payload.sender ? payload.sender : undefined
  const platform = typeof payload.platform === 'string' && payload.platform ? payload.platform : undefined
  appendConversation(state.conversations, agentName, {
    type: msgType, content, timestamp: currentTime,
    ...(at !== undefined ? { at } : {}),
    ...(sender ? { sender } : {}),
    ...(platform ? { platform } : {}),
  })
}

const BUCKET_KEYS = ['le100000', 'le200000', 'le272000', 'gt272000'] as const
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

function parseCounts(raw: unknown): TokenCounts | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  return {
    inputTokens: num(r.inputTokens),
    outputTokens: num(r.outputTokens),
    cacheReadTokens: num(r.cacheReadTokens),
    cacheWrite5mTokens: num(r.cacheWrite5mTokens),
    cacheWrite1hTokens: num(r.cacheWrite1hTokens),
  }
}

const MAX_ENERGY_HOURS = 24 * 400

/** Hour-bucketed local-model busy time (P5). Keys must be integer hour indexes; every field a finite non-negative number. */
export function parseEnergy(raw: unknown): EnergyUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const src = (raw as Record<string, unknown>).byHour
  if (!src || typeof src !== 'object') return undefined
  const byHour: EnergyUsage['byHour'] = {}
  let n = 0
  for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
    if (!/^\d{1,9}$/.test(k) || !v || typeof v !== 'object' || ++n > MAX_ENERGY_HOURS) continue
    const e = v as Record<string, unknown>
    byHour[k] = {
      busySec: num(e.busySec), callSec: num(e.callSec), calls: num(e.calls),
      untimedCalls: num(e.untimedCalls), untimedInTok: num(e.untimedInTok), untimedOutTok: num(e.untimedOutTok),
    }
    for (const f of Object.keys(byHour[k]) as Array<keyof EnergyUsage['byHour'][string]>) if (byHour[k][f] < 0) byHour[k][f] = 0
  }
  return n > 0 ? { v: 1, byHour } : undefined
}

/**
 * Validate the billed-usage totals sent with a context update: flat counts, model, and (P2) the
 * provider, the per-prompt-size buckets and the call/latency counters. Unknown bucket keys are dropped.
 */
export function parseSpend(raw: unknown): SpendTotals | undefined {
  const counts = parseCounts(raw)
  if (!counts) return undefined
  const r = raw as Record<string, unknown>
  let byBucket: SpendTotals['byBucket']
  if (r.byBucket && typeof r.byBucket === 'object') {
    const src = r.byBucket as Record<string, unknown>
    for (const key of BUCKET_KEYS) {
      const c = parseCounts(src[key])
      if (c) (byBucket ??= {})[key] = c
    }
  }
  const optNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined)
  const calls = optNum(r.calls)
  const timedCalls = optNum(r.timedCalls)
  const latencySeconds = optNum(r.latencySeconds)
  const energy = parseEnergy(r.energy)
  return {
    ...counts,
    ...(energy ? { energy } : {}),
    model: typeof r.model === 'string' ? r.model : undefined,
    ...(typeof r.provider === 'string' && r.provider ? { provider: r.provider } : {}),
    ...(byBucket ? { byBucket } : {}),
    ...(calls !== undefined ? { calls } : {}),
    ...(timedCalls !== undefined ? { timedCalls } : {}),
    ...(latencySeconds !== undefined ? { latencySeconds } : {}),
  }
}

export function handleContextUpdate(
  payload: Record<string, unknown>,
  state: MutableEventState,
): void {
  const agentName = asString(payload.agent)
  const tokens = asNumber(payload.tokens)
  const raw = payload.breakdown
  const breakdown = (raw && typeof raw === 'object' && 'systemPrompt' in raw) ? raw as ContextBreakdown : undefined
  // Optional override from runtimes that report an authoritative context window
  // (e.g. Codex's event_msg.token_count.info.model_context_window).
  const tokensMaxOverride = typeof payload.tokensMax === 'number' && payload.tokensMax > 0
    ? payload.tokensMax
    : undefined
  const spend = parseSpend(payload.spend)
  const agent = state.agents.get(agentName)
  if (agent) {
    state.agents.set(agentName, {
      ...agent,
      tokensUsed: tokens,
      tokensMax: tokensMaxOverride ?? agent.tokensMax,
      contextBreakdown: breakdown || agent.contextBreakdown,
      spend: spend ?? agent.spend,
      state: agent.state === 'complete' ? 'complete' : 'thinking'
    })
  }
}
