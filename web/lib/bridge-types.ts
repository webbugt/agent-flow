/**
 * Shared types for the VS Code bridge protocol.
 *
 * These types mirror extension/src/protocol.ts and are kept separate
 * to avoid cross-project imports. When updating these, also update
 * the canonical definitions in extension/src/protocol.ts.
 */

export interface AgentEvent {
  time: number
  type: string
  payload: Record<string, unknown>
  sessionId?: string
  /** Set by the bridge on events that arrive in an `agent-event-batch` (buffered history). */
  history?: boolean
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** Listed from history only (Hermes profile with recent sessions, nothing live): fleet view only, no tab. */
  idle?: boolean
}

export type ConnectionStatus = 'connected' | 'disconnected' | 'watching'
