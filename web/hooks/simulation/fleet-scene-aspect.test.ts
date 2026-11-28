/**
 * The Fleet map flows its blocks into the shape of the viewport (cloud layout: shelf-packed clouds; anchor layout:
 * anchors fitted to the aspect), for 1..12 profiles and several viewport shapes. A 4-profile fleet on a 16:9 screen used
 * to be one horizontal line.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { SimulationEvent } from '@/lib/agent-types'
import { instancesFromSessionEvents, type FleetSelectionView, type SessionLike } from '@/lib/fleet/fleet-model'
import { buildFleetGraph } from '@/lib/fleet/fleet-graph'
import { defaultOptions } from '@/lib/fleet/options-registry'
import type { PublicKanbanBoardNode } from '@/lib/fleet/kanban-source'
import { ANCHOR_SPACING } from '@/lib/fleet/anchor-mode'
import { buildFleetScene, FleetReplay, type FleetScene } from './fleet-scene'

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0)
const MIN = 60_000
const NOW = T0 + 60 * MIN
const all: FleetSelectionView = { isSelected: () => true }

const VIEWPORTS: Array<[string, number]> = [['16:9', 16 / 9], ['9:16', 9 / 16], ['1:1', 1]]
const factor = (a: number, b: number) => Math.max(a / b, b / a)

const name = (i: number) => `prof${String(i).padStart(2, '0')}`
const session = (profile: string): SessionLike => ({ id: `hermes-${profile}`, label: profile, status: 'active', startTime: T0, lastActivityTime: NOW })

/** A profile with 1..4 session nodes, each with a tool call: uneven clouds. */
function profileEvents(profile: string, nodes: number): SimulationEvent[] {
  const ev: SimulationEvent[] = [{ time: 0, type: 'agent_spawn', payload: { name: profile, isMain: true, profile, group: profile, task: profile } }]
  for (let k = 0; k < nodes; k++) {
    const node = `${profile} · S${k}`
    ev.push({ time: 0, type: 'agent_spawn', payload: { name: node, parent: profile, startedAt: T0 + k * 1000, task: node } })
    ev.push({ time: 5, type: 'tool_call_start', payload: { agent: node, tool: 'Bash', toolUseId: `u${k}`, args: 'pnpm test', inputData: { command: 'pnpm test' } } })
    ev.push({ time: 6, type: 'tool_call_end', payload: { agent: node, tool: 'Bash', toolUseId: `u${k}`, result: 'ok' } })
  }
  return ev
}

const board = (slug: string, assignee: string): PublicKanbanBoardNode => ({
  id: `kanban:${slug}`, type: 'kanban-board', slug, name: slug, description: '', archived: false,
  taskCounts: { running: 1, done: 1 }, totalTasks: 2,
  recentEvents: [{ id: 1, taskId: 't1', taskTitle: 'Write the plan', assignee, kind: 'claimed', runId: null, at: NOW - MIN }],
  lastEventAt: NOW - MIN,
} as PublicKanbanBoardNode)

/** n profiles (1 + i % 4 session nodes each), one Kanban board per profile. */
function fleet(n: number) {
  const profiles = Array.from({ length: n }, (_, i) => name(i))
  const sessions = profiles.map(session)
  const events: Record<string, SimulationEvent[]> = {}
  profiles.forEach((p, i) => { events[`hermes-${p}`] = profileEvents(p, 1 + (i % 4)) })
  const instances = instancesFromSessionEvents(sessions, id => events[id] ?? [])
  const graph = buildFleetGraph({ instances, selection: all, now: NOW, options: defaultOptions(), kanban: profiles.map(p => board(`board-${p}`, p)) })
  return { profiles, sessions, events, instances, graph }
}

function sceneFor(n: number, aspect: number, layout?: 'cloud' | 'anchor'): FleetScene {
  const f = fleet(n)
  const replay = new FleetReplay()
  return buildFleetScene({
    sessions: f.sessions, stateOf: id => replay.advance(id, f.events[id] ?? []), instances: f.instances, selection: all, graph: f.graph,
    aspect, ...(layout ? { layout, now: NOW } : {}),
  })
}

/** Bounding box of the halos (captions are not in it). */
function haloBox(scene: FleetScene) {
  const cl = [...scene.clusters.values()]
  const x0 = Math.min(...cl.map(c => c.x - c.r)); const x1 = Math.max(...cl.map(c => c.x + c.r))
  const y0 = Math.min(...cl.map(c => c.y - c.r)); const y1 = Math.max(...cl.map(c => c.y + c.r))
  return { w: x1 - x0, h: y1 - y0, aspect: (x1 - x0) / (y1 - y0) }
}

/** Positions of everything the scene draws as a node (session nodes and resources). */
const spots = (scene: FleetScene) => [...scene.state.agents.values()].map(a => [a.id, a.x, a.y] as const)

test('cloud layout: 4 profiles on 16:9 are no longer one row', () => {
  const scene = sceneFor(4, 16 / 9, 'cloud')
  const ys = new Set([...scene.clusters.values()].map(c => Math.round(c.y)))
  assert.ok(ys.size >= 2, 'more than one row of clouds')
  const box = haloBox(scene)
  assert.ok(factor(box.aspect, 16 / 9) <= 1.6, `block aspect ${box.aspect.toFixed(2)}`)
})

test('cloud layout: 1..12 profiles, 16:9 / 9:16 / 1:1: block shape follows the viewport, no cloud overlaps, deterministic', () => {
  for (const [vp, aspect] of VIEWPORTS) {
    for (let n = 1; n <= 12; n++) {
      const scene = sceneFor(n, aspect)
      assert.equal(scene.clusters.size, n)
      const cl = [...scene.clusters.values()]
      for (let i = 0; i < cl.length; i++) {
        for (let j = i + 1; j < cl.length; j++) {
          assert.ok(Math.hypot(cl[i].x - cl[j].x, cl[i].y - cl[j].y) >= cl[i].r + cl[j].r, `n=${n} ${vp}: halos of ${cl[i].identity}/${cl[j].identity} overlap`)
        }
      }
      // Within 1.6 of the viewport; a single cloud is a disc, and two or three clouds only fit a few shapes, so those
      // get the loose bound that no cloud arrangement beats (the packer test checks them against plain grids).
      const limit = n <= 3 ? 2 : 1.6
      const box = haloBox(scene)
      assert.ok(factor(box.aspect, aspect) <= limit, `n=${n} ${vp}: block aspect ${box.aspect.toFixed(2)} vs ${aspect.toFixed(2)}`)
      const again = sceneFor(n, aspect)
      assert.deepEqual(spots(again), spots(scene), `n=${n} ${vp}: same input, same map`)
    }
  }
})

test('cloud layout: resources are still placed near the clouds they link to, and outside every halo', () => {
  for (const [vp, aspect] of VIEWPORTS) {
    for (const n of [2, 5, 9, 12]) {
      const scene = sceneFor(n, aspect)
      for (const p of Array.from({ length: n }, (_, i) => name(i))) {
        const res = scene.state.agents.get(`kanban:board-${p}`)
        assert.ok(res, `n=${n} ${vp}: board of ${p} is on the map`)
        const own = [...scene.clusters.values()].find(c => c.identity === p)!
        const dOwn = Math.hypot(res.x - own.x, res.y - own.y)
        assert.ok(dOwn <= own.r + 400, `n=${n} ${vp}: ${p}'s board ${Math.round(dOwn - own.r)} beyond its halo`)
        for (const c of scene.clusters.values()) {
          assert.ok(Math.hypot(res.x - c.x, res.y - c.y) >= c.r - 1e-6 || c.identity === p, `n=${n} ${vp}: board of ${p} inside the halo of ${c.identity}`)
        }
      }
    }
  }
})

test('cloud layout: without an aspect the map is square-ish (the default)', () => {
  const f = fleet(6)
  const replay = new FleetReplay()
  const scene = buildFleetScene({ sessions: f.sessions, stateOf: id => replay.advance(id, f.events[id] ?? []), instances: f.instances, selection: all, graph: f.graph })
  assert.ok(factor(haloBox(scene).aspect, 1) <= 1.6)
})

test('anchor layout: 3..12 profiles, 16:9 / 9:16 / 1:1: resources are spread to the viewport shape and keep their separation, deterministic', () => {
  for (const [vp, aspect] of VIEWPORTS) {
    for (let n = 3; n <= 12; n++) {
      const scene = sceneFor(n, aspect, 'anchor')
      const res = [...scene.state.agents.values()].filter(a => a.resourceKind)
      assert.equal(res.length, n)
      for (let i = 0; i < res.length; i++) {
        for (let j = i + 1; j < res.length; j++) {
          assert.ok(Math.hypot(res[i].x - res[j].x, res[i].y - res[j].y) >= ANCHOR_SPACING - 1, `n=${n} ${vp}: ${res[i].id}/${res[j].id} keep the separation`)
        }
      }
      // What the viewport sees: every node, its tool cards included.
      const nodes = [...scene.state.agents.values()]
      const cards = [...scene.state.toolCalls.values()]
      const xs = [...nodes.map(a => a.x), ...cards.map(c => c.x)]
      const ys = [...nodes.map(a => a.y), ...cards.map(c => c.y)]
      const aspectSeen = (Math.max(...xs) - Math.min(...xs) + 200) / (Math.max(...ys) - Math.min(...ys) + 200)
      assert.ok(factor(aspectSeen, aspect) <= 1.6, `n=${n} ${vp}: map aspect ${aspectSeen.toFixed(2)} vs ${aspect.toFixed(2)}`)
      assert.deepEqual(spots(sceneFor(n, aspect, 'anchor')), spots(scene), `n=${n} ${vp}: same input, same map`)
    }
  }
})
