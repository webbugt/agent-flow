"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { COLORS } from "@/lib/colors"
import { Z } from "@/lib/agent-types"
import { BASH_COLOR, KANBAN_COLOR, SUBSYSTEM_COLOR, SUPERMEMORY_COLOR } from "@/lib/fleet/fleet-colors"
import type { ResourceKind } from "@/lib/fleet/options-registry"
import { EMPTY_PINS, togglePin, type PinSet } from "@/lib/fleet/resource-block"
import { SingleSessionTracker, buildSingleBlocks, type SingleSessionLike } from "@/lib/fleet/single-blocks"
import type { BashEventLike } from "@/lib/fleet/bash-blocks"
import type { UseEventLike } from "@/lib/fleet/event-uses"
import { useOptions } from "@/hooks/use-options"
import { FleetInspector } from "./fleet-inspector"

interface SingleBlocksProps {
  /** The open session (tab), or null: nothing is drawn. */
  session: SingleSessionLike | null
  /** Buffered events of a session (a ref-backed getter). Only the open session is ever read. */
  eventsOf: (sessionId: string) => ReadonlyArray<BashEventLike & UseEventLike>
  /** False while the Fleet map covers the canvas (it has its own blocks). */
  visible: boolean
}

const KIND_COLOR: Record<ResourceKind, string> = {
  kanban: KANBAN_COLOR, memory: SUPERMEMORY_COLOR, bash: BASH_COLOR, subsystem: SUBSYSTEM_COLOR,
}
const KIND_LABEL: Record<ResourceKind, string> = { kanban: 'Kanban', memory: 'Memory', bash: 'Bash', subsystem: 'Subsystem' }

/** Re-read the buffers and re-fade the chips this often, ms. Cheap: the trackers read only new events. */
const REFRESH_MS = 1000

/**
 * Resource blocks of the single-session view: a row of chips on the canvas, one per Kanban board / memory container /
 * bash command head / Hermes subsystem THIS session used lately. A chip is lit for the linger of its kind, fades, and goes
 * (the options panel sets linger, fade and show/hide for the single view); the pin keeps it. Click a chip for the
 * read-only list of this session's latest uses (the full bash command is masked, see secret-mask.ts).
 *
 * The trackers get the open session only, so a block never carries another session's use. Pins are kept per session.
 */
export function SingleBlocks({ session, eventsOf, visible }: SingleBlocksProps) {
  const options = useOptions()
  const [now, setNow] = useState(() => Date.now())
  const [pinned, setPinned] = useState<ReadonlySet<string>>(new Set())
  const [openId, setOpenId] = useState<string | null>(null)
  const trackerRef = useRef<SingleSessionTracker | null>(null)
  if (!trackerRef.current) trackerRef.current = new SingleSessionTracker()

  useEffect(() => {
    if (!visible || !session) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS)
    return () => clearInterval(timer)
  }, [visible, session])

  const sid = session?.id ?? null
  const sessionKey = session ? `${session.id}\u0000${session.label}` : null
  const sources = useMemo(
    () => (trackerRef.current as SingleSessionTracker).update(visible ? session : null, eventsOf, now),
    // `now` is the poll clock: the buffers are refs, so React does not see new events by itself
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visible, sessionKey, eventsOf, now],
  )
  const pins: PinSet = useMemo(() => {
    if (sid === null) return EMPTY_PINS
    const prefix = `${sid}\u0000`
    return new Set([...pinned].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length)))
  }, [pinned, sid])
  const blocks = useMemo(() => buildSingleBlocks({ sources, now, options, pins }), [sources, now, options, pins])

  // A block that is over (or switched off) cannot stay open; a switch of session closes it.
  const open = openId !== null ? blocks.find(b => b.id === openId) ?? null : null
  useEffect(() => {
    if (openId !== null && !open) setOpenId(null)
  }, [openId, open])
  useEffect(() => { setOpenId(null) }, [sid])

  if (!visible || !session || blocks.length === 0) return null

  const onTogglePin = (id: string) => {
    if (sid === null) return
    const next = togglePin(pins, id)
    setPinned(prev => {
      const keep = [...prev].filter(k => !k.startsWith(`${sid}\u0000`))
      return new Set([...keep, ...[...next].map(x => `${sid}\u0000${x}`)])
    })
  }

  return (
    <>
      {/* The read-only list of this session's latest uses of the open block: top left, above the message feed. */}
      {open && (
        <div className="absolute inset-0 pointer-events-none" style={{ zIndex: Z.sidePanel }}>
          <div className="pointer-events-auto">
            <FleetInspector
              inspection={open.inspection}
              now={now}
              top={0}
              right={0}
              narrow={false}
              pinned={open.pinned}
              onTogglePin={() => onTogglePin(open.id)}
              onClose={() => setOpenId(null)}
            />
          </div>
        </div>
      )}
      <div
        data-testid="single-blocks"
        data-count={blocks.length}
        className="absolute left-3 bottom-24 flex flex-wrap gap-1.5 font-mono text-[10px]"
        style={{ zIndex: Z.sidePanel, maxWidth: 'min(70vw, 560px)' }}
      >
        {blocks.map(b => {
          const color = KIND_COLOR[b.kind]
          return (
            <div
              key={b.id}
              data-testid="single-block"
              data-kind={b.kind}
              data-id={b.id}
              data-pinned={b.pinned}
              className="flex items-stretch rounded"
              style={{
                opacity: b.alpha, transition: 'opacity 1s linear',
                background: 'rgba(8,12,24,0.88)', border: `1px solid ${color}${open?.id === b.id ? 'cc' : '66'}`,
              }}
            >
              <button
                type="button"
                title={`${KIND_LABEL[b.kind]} · ${b.label}`}
                onClick={() => setOpenId(id => (id === b.id ? null : b.id))}
                className="flex flex-col items-start px-2 py-1 text-left"
                style={{ color: COLORS.textPrimary }}
              >
                <span style={{ color }}>{KIND_LABEL[b.kind]} · {b.label}</span>
                <span style={{ color: COLORS.textMuted }}>{b.sublabel}</span>
              </button>
              <button
                type="button"
                data-testid="single-block-pin"
                aria-pressed={b.pinned}
                title={b.pinned ? 'Unpin: the block fades after its linger again' : 'Pin: keep this block'}
                onClick={() => onTogglePin(b.id)}
                className="px-1.5"
                style={{ color: b.pinned ? color : COLORS.textMuted, borderLeft: `1px solid ${color}33` }}
              >
                {b.pinned ? '●' : '○'}
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}
