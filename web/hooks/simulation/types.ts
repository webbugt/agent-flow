import type {
  Agent,
  ToolCallNode,
  Particle,
  Edge,
  Discovery,
  FileAttention,
  TimelineEntry,
  SimulationEvent,
} from '@/lib/agent-types'
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force'

export interface SimulationState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  particles: Particle[]
  edges: Edge[]
  discoveries: Discovery[]
  fileAttention: Map<string, FileAttention>
  timelineEntries: Map<string, TimelineEntry>
  conversations: Map<string, ConversationMessage[]>
  currentTime: number
  isPlaying: boolean
  speed: number
  eventIndex: number
  eventLog: SimulationEvent[]
  /** Highest currentTime ever reached (for scrubber range in live mode) */
  maxTimeReached: number
}

/** Create an empty simulation state, optionally preserving specific fields */
export function createEmptyState(overrides?: Partial<SimulationState>): SimulationState {
  return {
    agents: new Map(),
    toolCalls: new Map(),
    particles: [],
    edges: [],
    discoveries: [],
    fileAttention: new Map(),
    timelineEntries: new Map(),
    conversations: new Map(),
    currentTime: 0,
    isPlaying: false,
    speed: 1,
    eventIndex: 0,
    eventLog: [],
    maxTimeReached: 0,
    ...overrides,
  }
}

let _msgIdCounter = 0
export function nextMsgId(): string { return `msg-${_msgIdCounter++}` }

export interface ConversationMessage {
  id: string
  type: 'tool_call' | 'tool_result' | 'assistant' | 'user' | 'thinking'
  content: string
  timestamp: number
  toolName?: string
  inputData?: Record<string, unknown>
}

// ── Memory caps ──────────────────────────────────────────────────────
// These are the ONLY limits applied to live data. They bound how many items
// are kept, never how much of one item is shown: every label, message, tool
// argument and result is stored and passed through as the full text.
// (Long text is only shortened at draw time, to fit the pixels available;
// see truncateText in canvas/draw-misc.ts. Hermes text is bounded once at the
// source, see MAX_TEXT_CHARS in scripts/hermes-logs.ts.)

/** Max canvas message bubbles kept per agent (oldest are dropped). Bubbles fade
 *  after a few seconds, so this only matters for a burst of messages. */
export const MAX_BUBBLES = 40

/** Max conversation messages kept per agent (oldest are dropped). The
 *  conversation is what the message feed and transcript panels show, so this
 *  is sized for a long live session rather than a short demo. */
export const MAX_CONVERSATION_MESSAGES = 2000

/** Max events kept in the event log for seeking (oldest are dropped). Must not
 *  be smaller than the relay's per-session replay buffer (MAX_EVENT_BUFFER in
 *  scripts/relay.ts), or a reloaded page would replay events it cannot seek to. */
export const MAX_EVENT_LOG = 20000

/** Append a message to a conversation, creating the array if needed.
 *  Auto-assigns a unique id if not provided.
 *  Caps history at MAX_CONVERSATION_MESSAGES per agent. */
export function appendConversation(
  conversations: Map<string, ConversationMessage[]>,
  agentName: string,
  message: Omit<ConversationMessage, 'id'> & { id?: string },
): void {
  const msg: ConversationMessage = { id: message.id ?? nextMsgId(), ...message }
  const msgs = conversations.get(agentName) || []
  const updated = [...msgs, msg]
  conversations.set(agentName, updated.length > MAX_CONVERSATION_MESSAGES ? updated.slice(-MAX_CONVERSATION_MESSAGES) : updated)
}

/** Build a deterministic edge ID from two node names */
export function edgeId(from: string, to: string): string {
  return `edge-${from}-${to}`
}

// ── Safe payload extraction helpers ──────────────────────────────────
export function asString(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback }
export function asNumber(v: unknown, fallback = 0): number { return typeof v === 'number' ? v : fallback }
export function asBoolean(v: unknown, fallback = false): boolean { return typeof v === 'boolean' ? v : fallback }

export interface ForceNode extends SimulationNodeDatum {
  id: string
}

export interface ForceLink extends SimulationLinkDatum<ForceNode> {
  id: string
}

export interface UseAgentSimulationOptions {
  /** If true, use MOCK_SCENARIO for demo playback. Default: true */
  useMockData?: boolean
  /** External events to process (from VS Code bridge). Consumed each frame. */
  externalEvents?: readonly SimulationEvent[]
  /** Called after external events are consumed */
  onExternalEventsConsumed?: () => void
  /** If set, only process events matching this session ID */
  sessionFilter?: string | null
  /** Ref updated synchronously when session changes (avoids stale closure in rAF) */
  sessionFilterRef?: React.RefObject<string | null>
  /** If true, CLAUDE_CODE_DISABLE_1M_CONTEXT is set — cap context window to 200k */
  disable1MContext?: boolean
}
