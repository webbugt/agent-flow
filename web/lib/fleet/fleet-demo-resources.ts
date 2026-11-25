/**
 * Demo Kanban boards and Supermemory namespaces for the Fleet map in demo mode, so the demo shows
 * resource placement, link linger and pulses without a relay. Pure; the caller passes `now`.
 * Invented data only: board and namespace names, profile names of the demo fleet, no content.
 */
import type { PublicKanbanBoardNode } from './kanban-source'
import type { SupermemoryAction, SupermemoryNamespaceNode } from './supermemory-source'
import type { FleetSources } from '@/hooks/use-fleet-sources'

const S = 1000
const DEMO_PROFILES = ['taxis', 'sophia', 'hestia'] as const
const DEMO_ACTIONS: SupermemoryAction[] = ['store', 'search', 'forget']

function board(slug: string, name: string, now: number, events: Array<[string, string, number]>, tasks: number): PublicKanbanBoardNode {
  return {
    id: `kanban:${slug}`, type: 'kanban-board', slug, name, description: '', archived: false,
    taskCounts: { running: events.length > 0 ? 1 : 0, done: Math.max(tasks - 1, 0) }, totalTasks: tasks,
    recentEvents: events.map(([assignee, kind, agoSec], i) => ({
      id: i + 1, taskId: `t_demo${i + 1}`, taskTitle: `Demo task ${i + 1}`, assignee, kind, runId: null, at: now - agoSec * S,
    })),
    lastEventAt: events.length ? now - Math.min(...events.map(e => e[2])) * S : null,
  } as PublicKanbanBoardNode
}

function space(tag: string, now: number, events: Array<[string, SupermemoryAction, number]>): SupermemoryNamespaceNode {
  const recent = events.map(([profile, action, agoSec]) => ({ at: now - agoSec * S, profile, action })).sort((a, b) => b.at - a.at)
  const counts = { store: 0, search: 0, forget: 0 }
  const byProfile: SupermemoryNamespaceNode['byProfile'] = {}
  const lastByProfile: Record<string, number> = {}
  for (const r of recent) {
    counts[r.action]++
    byProfile[r.profile] = byProfile[r.profile] ?? { store: 0, search: 0, forget: 0 }
    byProfile[r.profile][r.action]++
    lastByProfile[r.profile] = Math.max(lastByProfile[r.profile] ?? 0, r.at)
  }
  return {
    id: `supermemory:${tag}`, type: 'supermemory-namespace', containerTag: tag, counts,
    total: recent.length, byProfile, daily: [], lastEventAt: recent[0]?.at ?? null, lastByProfile, recent,
  }
}

/** Boards and namespaces of the demo fleet: two linked boards, one unlinked; two linked namespaces, one unlinked. */
export function createDemoResources(now: number): FleetSources {
  return {
    kanban: [
      board('agent-flow', 'Agent Flow', now, [['taxis', 'claimed', 25], ['hestia', 'completed', 70], ['taxis', 'completed', 600], ['sophia', 'claimed', 900]], 8),
      board('media', 'Media', now, [['sophia', 'completed', 1800]], 4),
      board('backlog', 'Backlog', now, [], 5),
    ],
    supermemory: [
      space('omh_family', now, [['taxis', 'search', 40], ['sophia', 'store', 130], ['hestia', 'search', 300], ['taxis', 'store', 900]]),
      space('webbugt_video_memory', now, [['sophia', 'search', 2400]]),
      space('matrix_org', now, []),
    ],
  }
}

export type DemoEventKind = 'kanban' | 'memory'

/** The demo fleet does something: one new Kanban event or memory call, attributed to a demo profile. */
export function addDemoEvent(src: FleetSources, kind: DemoEventKind, now: number, seq: number): FleetSources {
  const profile = DEMO_PROFILES[seq % DEMO_PROFILES.length]
  if (kind === 'kanban') {
    return {
      ...src,
      kanban: src.kanban.map(b => {
        if (b.slug !== 'agent-flow') return b
        const id = Math.max(0, ...b.recentEvents.map(e => e.id)) + 1
        const ev = { id, taskId: `t_demo${id}`, taskTitle: `Demo task ${id}`, assignee: profile, kind: seq % 2 ? 'completed' : 'claimed', runId: null, at: now }
        return { ...b, recentEvents: [ev, ...b.recentEvents], lastEventAt: now }
      }),
    }
  }
  const action = DEMO_ACTIONS[seq % DEMO_ACTIONS.length]
  return {
    ...src,
    supermemory: src.supermemory.map(n => {
      if (n.containerTag !== 'omh_family') return n
      const byProfile = { ...n.byProfile, [profile]: { ...(n.byProfile[profile] ?? { store: 0, search: 0, forget: 0 }) } }
      byProfile[profile][action]++
      return {
        ...n, counts: { ...n.counts, [action]: n.counts[action] + 1 }, total: n.total + 1, byProfile,
        lastEventAt: now, lastByProfile: { ...n.lastByProfile, [profile]: now }, recent: [{ at: now, profile, action }, ...n.recent],
      }
    }),
  }
}
