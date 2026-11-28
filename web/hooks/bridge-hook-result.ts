import type { SimulationEvent } from '@/lib/agent-types'
import type { ConnectionStatus, SessionInfo } from '@/lib/bridge-types'

/**
 * What the visualiser reads from its event source. The live source is `useVSCodeBridge` (relay SSE or the VS Code
 * extension); the /demo route supplies the same shape from synthetic data (`useDemoBridge`). This file holds only the
 * shape, so neither source has to import the other.
 */
export interface BridgeHookResult {
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Arrival time (ms since epoch) of the last stream message of ANY type (history replays and agent_idle ticks included: they prove the stream is alive), null before the first. Updated at most once a second. */
  lastEventAt: number | null
  /** Arrival time of the last live message that shows real activity (tool call, message, spawn...), null before the first. */
  lastActivityAt: number | null
  /** When the event stream last connected (browser build), null if it never did. */
  connectedAt: number | null
  /** Events received from VS Code extension, converted to SimulationEvent format */
  pendingEvents: readonly SimulationEvent[]
  /** Call after consuming events to clear the queue */
  consumeEvents: () => void
  /** Whether to show mock data (standalone mode or explicit config) */
  useMockData: boolean
  /** Whether CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set — caps context window to 200k */
  disable1MContext: boolean
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  /** Known sessions from the extension */
  sessions: SessionInfo[]
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
  /** Every event buffered for a session (all sessions are buffered, not only the open tab). */
  getSessionEvents: (sessionId: string) => readonly SimulationEvent[]
  /** Sessions whose tab was closed. They are still running, so the fleet view lists them. */
  getDismissedSessions: () => SessionInfo[]
}
