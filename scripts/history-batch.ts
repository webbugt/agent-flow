import type { AgentEvent } from '../extension/src/protocol'

/** The SSE message that replays one session's buffered history to a newly connected page.
 *  Events keep their own `time` (seconds since the session started): the page applies the
 *  batch as a snapshot spaced as it really happened. Zeroing the times placed every event
 *  at the same instant on load, which showed up as one burst of nodes. */
export function buildHistoryBatch(buffered: readonly AgentEvent[]): { type: 'agent-event-batch'; events: AgentEvent[] } {
  return { type: 'agent-event-batch', events: buffered.map(e => ({ ...e })) }
}
