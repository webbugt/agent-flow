"use client"

import { COLORS } from "@/lib/colors"
import { ageLabel, type FleetInspection } from "@/lib/fleet/fleet-inspect"
import { KANBAN_COLOR, SUPERMEMORY_COLOR } from "@/lib/fleet/fleet-colors"

interface FleetInspectorProps {
  inspection: FleetInspection
  now: number
  onClose: () => void
  /** Space left of the session detail panel. */
  right: number
  top: number
  narrow: boolean
}

/** Space under the top bar that the session summary card (top left) takes, px: the panel starts below it. */
const SESSION_CARD_CLEARANCE = 52

/** Read-only list of the latest interactions of a Kanban board or Supermemory namespace. */
export function FleetInspector({ inspection, now, onClose, right, top, narrow }: FleetInspectorProps) {
  const color = inspection.kind === 'kanban' ? KANBAN_COLOR : SUPERMEMORY_COLOR
  return (
    <div
      data-testid="fleet-inspector"
      data-kind={inspection.kind}
      data-count={inspection.items.length}
      className="absolute font-mono text-xs overflow-hidden flex flex-col"
      style={{
        top: top + SESSION_CARD_CLEARANCE,
        ...(narrow ? { left: 8, right: right + 8 } : { left: 12, width: 340 }),
        maxHeight: narrow ? 220 : 360,
        zIndex: 5,
        background: 'rgba(8,12,24,0.92)',
        border: `1px solid ${color}66`,
        borderRadius: 8,
        color: COLORS.textPrimary ?? '#cfe',
        backdropFilter: 'blur(6px)',
      }}
    >
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${color}33` }}>
        <span style={{ color }}>
          {inspection.kind === 'kanban' ? 'Kanban' : 'Memory'} · {inspection.title}
        </span>
        <button type="button" aria-label="Close inspector" data-testid="fleet-inspector-close" onClick={onClose} style={{ color: COLORS.textMuted }}>
          ✕
        </button>
      </div>
      <div className="overflow-y-auto px-3 py-1" style={{ minHeight: 0 }}>
        {inspection.items.length === 0 && <div className="py-2" style={{ color: COLORS.textMuted }}>No interactions recorded yet.</div>}
        {inspection.items.map((item, i) => (
          <div key={`${item.at}-${i}`} data-testid="fleet-inspector-row" className="flex gap-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <span style={{ color: COLORS.textMuted, minWidth: 64 }}>{ageLabel(item.at, now)}</span>
            <span style={{ minWidth: 70 }}>{item.profile ?? '—'}</span>
            <span style={{ color }}>{item.action}</span>
            {item.detail && <span className="truncate" style={{ color: COLORS.textMuted }}>{item.detail}</span>}
          </div>
        ))}
        {inspection.more > 0 && (
          <div data-testid="fleet-inspector-more" className="py-1" style={{ color: COLORS.textMuted }}>+{inspection.more} more</div>
        )}
      </div>
    </div>
  )
}
