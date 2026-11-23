/**
 * Demo fleet as bridge sessions with buffered events, so the demo (and tests) feed the Fleet
 * map through the same path as live data: one session per identity of the fixture, a main node,
 * one node per fixture instance, each with tool calls and a message.
 */
import type { SimulationEvent } from '@/lib/agent-types'
import { createFleetFixture, groupInstances, type SessionLike } from './fleet-model'

export interface FleetFixtureSessions {
  sessions: SessionLike[]
  eventsOf: (sessionId: string) => readonly SimulationEvent[]
}

export function createFleetFixtureSessions(now: number): FleetFixtureSessions {
  const sessions: SessionLike[] = []
  const events = new Map<string, SimulationEvent[]>()
  for (const group of groupInstances(createFleetFixture(now))) {
    const id = `fx-${group.identity}`
    const first = group.instances[0]
    const running = group.instances.some(i => i.endTime === undefined)
    sessions.push({
      id, label: `${group.identity} · demo`, status: running ? 'active' : 'completed',
      startTime: first.startTime, lastActivityTime: Math.max(...group.instances.map(i => i.endTime ?? now)),
    })
    const list: SimulationEvent[] = [
      { time: 0, type: 'agent_spawn', sessionId: id, payload: { name: group.identity, isMain: true, task: `${group.identity} demo`, model: first.runtime === 'codex' ? 'gpt-5' : 'claude-sonnet' } },
    ]
    group.instances.forEach((inst, k) => {
      const name = `${group.identity} · #${k + 1}`
      list.push({
        time: 0, type: 'agent_spawn', sessionId: id,
        payload: { name, parent: group.identity, startedAt: inst.startTime, model: inst.runtime, task: `${group.identity} node ${k + 1}` },
      })
      inst.markers.forEach((m, j) => {
        const t = (m.at - inst.startTime) / 1000
        const toolUseId = `${name}-${j}`
        const tool = j % 2 === 0 ? 'Read' : 'Bash'
        list.push({ time: t, type: 'tool_call_start', sessionId: id, payload: { agent: name, tool, toolUseId, args: tool === 'Read' ? `src/file-${j}.ts` : `pnpm test ${j}` } })
        list.push({ time: t + 2, type: 'tool_call_end', sessionId: id, payload: { agent: name, tool, toolUseId, result: 'ok' } })
      })
      list.push({ time: 1, type: 'message', sessionId: id, payload: { agent: name, role: 'assistant', content: `working on item ${k + 1} of ${group.identity}` } })
      if (inst.endTime !== undefined) list.push({ time: (inst.endTime - inst.startTime) / 1000, type: 'agent_complete', sessionId: id, payload: { name } })
    })
    events.set(id, list)
  }
  return { sessions, eventsOf: sid => events.get(sid) ?? [] }
}
