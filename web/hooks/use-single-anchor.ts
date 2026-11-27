'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BashEventLike } from '@/lib/fleet/bash-blocks'
import type { UseEventLike } from '@/lib/fleet/event-uses'
import { useNodeId } from '@/lib/fleet/event-uses'
import { fleetNow } from '@/lib/fleet/fleet-clock'
import { glideStep } from '@/lib/fleet/fleet-glide'
import { identityFromLabel } from '@/lib/fleet/fleet-model'
import { profileColor } from '@/lib/fleet/anchor-mode'
import {
  composeSingleFrame, layoutSingleAnchor, rootOf, treeRadius, type SingleAnchorBlock, type SingleUseEvent,
} from '@/lib/fleet/single-anchor'
import { SingleSessionTracker, buildSingleBlocks, type SingleSessionLike } from '@/lib/fleet/single-blocks'
import { useOptions } from '@/hooks/use-options'
import type { SimulationState } from './simulation/types'

/** Re-read the buffers and re-lay the anchors this often, ms. */
const REFRESH_MS = 1000

export interface UseSingleAnchorOptions {
  /** Anchor mode on and the single view showing (not the fleet map). */
  enabled: boolean
  /** The open session, or null. */
  session: SingleSessionLike | null
  eventsOf: (sessionId: string) => ReadonlyArray<BashEventLike & UseEventLike>
  /** The live single-view simulation (what is drawn when the mode is off). */
  sourceRef: { readonly current: SimulationState }
  /** The simulation's own drag handler. */
  updateAgentPosition: (id: string, x: number, y: number) => void
}

/**
 * Resource-anchor mode of the single view: the frame the canvas draws instead of the plain simulation (see
 * lib/fleet/single-anchor.ts). The tree of the open session glides to the resource it uses; the resources it used
 * are anchor nodes laid out by co-use. Returns the frame ref and a drag handler that undoes the tree's offset.
 */
export function useSingleAnchor(opts: UseSingleAnchorOptions) {
  const { enabled, session, eventsOf, sourceRef, updateAgentPosition } = opts
  const options = useOptions()
  const trackerRef = useRef<SingleSessionTracker | null>(null)
  if (!trackerRef.current) trackerRef.current = new SingleSessionTracker()
  // The canvas keeps the ref it was first given, so this object must stay the same across enabled/disabled. It is a
  // live view: off, a read returns the simulation's own current frame (never a copy that can be a frame old); on, the
  // last frame composed by the draw loop below.
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const composedRef = useRef<SimulationState>(sourceRef.current)
  const frameRef = useMemo(() => ({
    get current(): SimulationState { return enabledRef.current ? composedRef.current : sourceRef.current },
    set current(v: SimulationState) { composedRef.current = v },
  }), [sourceRef])
  const [now, setNow] = useState(() => Date.now())
  const drawnRootRef = useRef<{ x: number; y: number } | null>(null)
  const offsetRef = useRef({ x: 0, y: 0 })
  const lastRootRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !session) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled, session])

  const sessionKey = session ? `${session.id}\u0000${session.label}` : null
  const sources = useMemo(
    () => (trackerRef.current as SingleSessionTracker).update(enabled ? session : null, eventsOf, now),
    // `now` is the poll clock: the buffers are refs, so React does not see new events by itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [enabled, sessionKey, eventsOf, now],
  )

  const { blocks, events } = useMemo(() => {
    const views = enabled ? buildSingleBlocks({ sources, now, options }) : []
    const list: SingleAnchorBlock[] = views.map(v => ({
      id: v.id, kind: v.kind, label: v.label, sublabel: v.sublabel, alpha: v.alpha,
      lingerMs: options.lingerSeconds[v.kind] * 1000, fadeMs: options.fadeSeconds * 1000,
    }))
    const evs: SingleUseEvent[] = []
    for (const u of sources.uses) evs.push({ resource: useNodeId(u.kind, u.key), at: u.at })
    for (const b of sources.bash) for (const r of b.recent) evs.push({ resource: b.id, at: r.at })
    return { blocks: list, events: evs }
  }, [enabled, sources, now, options])

  const tint = useMemo(
    () => profileColor(identityFromLabel(session?.label), options.profilePalette, options.profileColors),
    [session?.label, options.profilePalette, options.profileColors],
  )
  const profile = identityFromLabel(session?.label)

  // The layout is re-made with the buffers (once a second), the draw loop only glides and composes.
  const layoutRef = useRef<ReturnType<typeof layoutSingleAnchor> | null>(null)
  const layoutSigRef = useRef('')
  useEffect(() => {
    // Off: no loop at all; reads of frameRef go straight to the simulation.
    if (!enabled) { drawnRootRef.current = null; lastRootRef.current = null; return }
    let raf = 0
    let last = 0
    const frame = (ts: number) => {
      raf = requestAnimationFrame(frame)
      const source = sourceRef.current
      const root = rootOf(source.agents)
      if (!root) { frameRef.current = source; return }
      const sig = `${blocks.map(b => b.id).join('|')}#${events.length}#${now}`
      if (layoutSigRef.current !== sig || !layoutRef.current) {
        layoutSigRef.current = sig
        layoutRef.current = layoutSingleAnchor(blocks, events, treeRadius(source.agents, source.toolCalls, root), fleetNow())
      }
      const layout = layoutRef.current
      const dt = last ? Math.min(ts - last, 100) : 16
      last = ts
      // A first frame (or another session) starts at its place; later changes of the target are glided to.
      const at = drawnRootRef.current && lastRootRef.current === (session?.id ?? null)
        ? glideStep(drawnRootRef.current, layout.rootAt, dt)
        : { ...layout.rootAt }
      drawnRootRef.current = at
      lastRootRef.current = session?.id ?? null
      offsetRef.current = { x: at.x - root.x, y: at.y - root.y }
      frameRef.current = composeSingleFrame({ source, blocks, layout, rootAt: at, tint, profile })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [enabled, blocks, events, now, tint, profile, session?.id, sourceRef])

  /** Drag in the anchor frame: resources stay (they are anchors), the tree's offset is taken off before the simulation sees it. */
  const onAgentDrag = useCallback((id: string, x: number, y: number) => {
    if (!enabled) { updateAgentPosition(id, x, y); return }
    const agent = frameRef.current.agents.get(id)
    if (!agent || agent.resourceKind) return
    updateAgentPosition(id, x - offsetRef.current.x, y - offsetRef.current.y)
  }, [enabled, updateAgentPosition])

  return { frameRef, onAgentDrag }
}
