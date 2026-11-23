import type { SimulationState } from './types'
import { FINISHED_AGENT_OPACITY, RESTING_TOOL_OPACITY, pruneRestingTools } from './animate'
import { TOOL_MIN_DISPLAY_S, TOOL_MAX_RUNNING_S, DISCOVERY_HOLD_S, BUBBLE_VISIBLE_S, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'

/** Snap visual properties to their analytically correct values at a given time (used during seek) */
export function snapVisualState(state: SimulationState, targetTime: number): SimulationState {
  // Fleet map: nodes are never removed, finished ones rest dimmed, each node keeps its newest tool calls
  const keep = state.keepFinished === true

  const newAgents = new Map(state.agents)
  for (const [id, agent] of newAgents) {
    if (agent.state === 'complete' && !agent.isMain && !keep) {
      // Remove completed sub-agents entirely during seek
      newAgents.delete(id)
      continue
    }
    const snapped = { ...agent }
    if (agent.state !== 'complete') {
      snapped.opacity = 1
      snapped.scale = 1
      snapped.timeAlive = targetTime - agent.spawnTime
    } else {
      // Main agent that completed (the fleet map also rests finished session nodes here)
      snapped.opacity = FINISHED_AGENT_OPACITY
      snapped.scale = 1
    }
    snapped.messageBubbles = agent.messageBubbles.filter(b => targetTime - b.time <= BUBBLE_VISIBLE_S)
    newAgents.set(id, snapped)
  }

  const newToolCalls = new Map(state.toolCalls)
  for (const [id, tc] of newToolCalls) {
    const snapped = { ...tc }
    if (keep) {
      snapped.opacity = tc.state === 'running' || targetTime - (tc.completeTime ?? 0) < TOOL_MIN_DISPLAY_S ? 1 : RESTING_TOOL_OPACITY
    } else if (tc.state === 'running') {
      snapped.opacity = (targetTime - tc.startTime) > TOOL_MAX_RUNNING_S ? 0 : 1
    } else {
      const timeSinceComplete = targetTime - (tc.completeTime ?? 0)
      snapped.opacity = timeSinceComplete < TOOL_MIN_DISPLAY_S ? 1 : 0
    }
    newToolCalls.set(id, snapped)
  }

  const pruned = keep ? pruneRestingTools(newToolCalls, state.edges) : { toolCalls: newToolCalls, edges: state.edges }

  // Filter edges: only keep edges where both endpoints are visible
  const newEdges = pruned.edges
    .map(e => {
      const fromAgent = newAgents.get(e.from)
      const toAgent = newAgents.get(e.to)
      const toTool = pruned.toolCalls.get(e.to)
      const fromVisible = fromAgent && fromAgent.opacity > MIN_VISIBLE_OPACITY
      const toVisible = (toAgent && toAgent.opacity > MIN_VISIBLE_OPACITY) || (toTool && toTool.opacity > MIN_VISIBLE_OPACITY)
      return { ...e, opacity: (fromVisible && toVisible) ? 1 : 0 }
    })
    .filter(e => e.opacity > 0)

  const newDiscoveries = state.discoveries.map(d => {
    const age = targetTime - d.timestamp
    return { ...d, x: d.targetX, y: d.targetY, opacity: age < DISCOVERY_HOLD_S ? 0.9 : 0 }
  }).filter(d => d.opacity > 0)

  return {
    ...state,
    agents: newAgents, toolCalls: pruned.toolCalls,
    edges: newEdges, particles: [], discoveries: newDiscoveries,
  }
}
