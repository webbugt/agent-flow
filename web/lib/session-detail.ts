/**
 * Pure helpers behind the session detail and tool detail views: pairing tool
 * calls with their results, picking which session to open, and the text the
 * copy buttons put on the clipboard. No React, no DOM, so they are unit-tested.
 */
import type { ConversationMessage } from '@/hooks/simulation/types'

// ─── Conversation → display items ───────────────────────────────────────────

export type SessionItem =
  | { id: string; kind: 'message'; message: ConversationMessage }
  | { id: string; kind: 'tool'; toolName: string; call?: ConversationMessage; result?: ConversationMessage }

/**
 * Turn a flat conversation into display items: a tool call and its result
 * become ONE item. Pairing uses the call id when both sides have one (Hermes
 * does); otherwise a result is paired with the earliest still-open call of the
 * same tool. A call without a result yet is shown as running; a result whose
 * call is not in the list (it was dropped by the message cap) stands alone.
 */
export function buildSessionItems(conversation: readonly ConversationMessage[]): SessionItem[] {
  const items: SessionItem[] = []
  const openById = new Map<string, Extract<SessionItem, { kind: 'tool' }>>()
  const open: Array<Extract<SessionItem, { kind: 'tool' }>> = []

  for (const msg of conversation) {
    if (msg.type === 'tool_call') {
      const item: Extract<SessionItem, { kind: 'tool' }> = { id: msg.id, kind: 'tool', toolName: msg.toolName ?? 'Tool', call: msg }
      items.push(item)
      open.push(item)
      if (msg.toolUseId) openById.set(msg.toolUseId, item)
    } else if (msg.type === 'tool_result') {
      let target = msg.toolUseId ? openById.get(msg.toolUseId) : undefined
      if (!target) {
        // No usable id: first open call of the same tool that carries no id of its own
        target = open.find(c => !c.result && !c.call?.toolUseId && c.toolName === (msg.toolName ?? c.toolName))
      }
      if (target && !target.result) {
        target.result = msg
        const at = open.indexOf(target)
        if (at !== -1) open.splice(at, 1)
        if (target.call?.toolUseId) openById.delete(target.call.toolUseId)
      } else {
        items.push({ id: msg.id, kind: 'tool', toolName: msg.toolName ?? 'Tool', result: msg })
      }
    } else {
      items.push({ id: msg.id, kind: 'message', message: msg })
    }
  }
  return items
}

/** Which agent's session opens by default: the one with the newest message. */
export function pickDefaultAgentId(
  agents: ReadonlyMap<string, { isMain?: boolean }>,
  conversations: ReadonlyMap<string, readonly ConversationMessage[]>,
): string | null {
  let best: string | null = null
  let bestScore = -1
  let bestIsMain = true
  let bestCount = -1
  for (const [id, agent] of agents) {
    const msgs = conversations.get(id) ?? []
    if (msgs.length === 0) continue
    let at = 0
    for (const m of msgs) if (m.at !== undefined && m.at > at) at = m.at
    const isMain = Boolean(agent.isMain)
    // newest wall-clock message first; then a session node over the profile's main node; then the longer conversation
    const better =
      at > bestScore
      || (at === bestScore && (bestIsMain && !isMain || (bestIsMain === isMain && msgs.length >= bestCount)))
    if (better) {
      best = id
      bestScore = at
      bestIsMain = isMain
      bestCount = msgs.length
    }
  }
  if (best) return best
  // nothing has been said yet: show a session node if there is one, else the main node
  let first: string | null = null
  for (const [id, agent] of agents) {
    if (!agent.isMain) return id
    first = first ?? id
  }
  return first
}

/** Session detail panel width: the fixed card width, but never wider than the viewport (phones). */
export function sessionDetailWidth(viewportWidth: number, cardWidth = 540): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return cardWidth
  return Math.min(cardWidth, Math.floor(viewportWidth))
}

/**
 * Space the Fleet map and timeline leave on the right for the open detail panel. On a phone the
 * panel covers the whole screen, so the map keeps its full area underneath instead of collapsing to 0px.
 */
export function detailInset(open: boolean, viewportWidth: number, cardWidth = 540, minMapWidth = 280): number {
  if (!open) return 0
  const w = sessionDetailWidth(viewportWidth, cardWidth)
  return viewportWidth - w >= minMapWidth ? w : 0
}

// ─── Tool detail text ───────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Tool names whose input has a dedicated renderer (see tool-content-renderer.tsx). */
export const RICH_TOOLS = new Set(['Edit', 'Write', 'Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion'])

/**
 * True when the dedicated renderer for this tool has something to draw: its
 * key fields are present. Otherwise the detail view shows the plain arguments,
 * so a tool never renders as an empty box.
 */
export function hasRichInput(toolName: string, inputData: Record<string, unknown> | undefined): boolean {
  if (!inputData || !RICH_TOOLS.has(toolName)) return false
  const d = inputData
  switch (toolName) {
    case 'Bash': return str(d.command) !== ''
    case 'Edit': return str(d.old_string) !== '' || str(d.new_string) !== ''
    case 'Write': return str(d.content) !== '' || str(d.file_path) !== ''
    case 'Read': return str(d.file_path) !== ''
    case 'Grep':
    case 'Glob': return str(d.pattern) !== ''
    case 'WebSearch': return str(d.query) !== ''
    case 'WebFetch': return str(d.url) !== ''
    case 'TodoWrite': return Array.isArray(d.todos) && d.todos.length > 0
    case 'AskUserQuestion': return Array.isArray(d.questions) && d.questions.length > 0
    default: return false
  }
}

/** Pretty JSON of the structured input; empty string when there is none. */
export function toolInputJson(inputData: Record<string, unknown> | undefined): string {
  if (!inputData || Object.keys(inputData).length === 0) return ''
  try {
    return JSON.stringify(inputData, null, 2)
  } catch {
    return ''
  }
}

/** Text a copy button puts on the clipboard for the arguments of a tool call. */
export function toolCopyText(toolName: string, inputData: Record<string, unknown> | undefined, args: string): string {
  const d = inputData ?? {}
  switch (toolName) {
    case 'Bash': {
      const command = str(d.command)
      if (command) return command
      break
    }
    case 'Edit': {
      const oldS = str(d.old_string)
      const newS = str(d.new_string)
      if (oldS || newS) {
        const path = str(d.file_path)
        const lines = (text: string, sign: string) => (text === '' ? [] : text.split('\n').map(l => `${sign}${l}`))
        return [...(path ? [`--- ${path}`] : []), ...lines(oldS, '-'), ...lines(newS, '+')].join('\n')
      }
      break
    }
    case 'Write': {
      const content = str(d.content)
      if (content) return content
      break
    }
    default:
      break
  }
  return toolInputJson(inputData) || args
}

/** Whole call for "copy all": name, arguments, result. */
export function toolCopyAll(toolName: string, inputData: Record<string, unknown> | undefined, args: string, result: string | undefined): string {
  const parts = [`# ${toolName}`, toolCopyText(toolName, inputData, args)]
  if (result !== undefined && result !== '') parts.push('# result', result)
  return parts.filter(p => p !== '').join('\n')
}

// ─── Formatting ─────────────────────────────────────────────────────────────

/** Local HH:MM:SS of an epoch-ms time; empty when there is none. */
export function formatClock(at: number | undefined): string {
  if (at === undefined || !Number.isFinite(at)) return ''
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** `~$0.123` for an estimate, `$0.123` for billed usage; `$0.0042` below one cent. */
export function formatCostUsd(usd: number, estimate = false): string {
  const body = usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)
  return `${estimate ? '~' : ''}$${body}`
}

/** `sender via platform`, or whichever half is known. */
export function formatOrigin(sender?: string, platform?: string): string {
  if (sender && platform) return `${sender} via ${platform}`
  return sender ?? platform ?? ''
}
