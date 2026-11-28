"use client"

import { COLORS } from "@/lib/colors"
import { ageLabel, type FleetInspection } from "@/lib/fleet/fleet-inspect"
import { BASH_COLOR, KANBAN_COLOR, SUBSYSTEM_COLOR, SUPERMEMORY_COLOR } from "@/lib/fleet/fleet-colors"
import { kanbanCountsLine } from "@/lib/fleet/kanban-blocks"

interface FleetInspectorProps {
  inspection: FleetInspection
  now: number
  onClose: () => void
  /** Space left of the session detail panel. */
  right: number
  top: number
  narrow: boolean
  /** Whether the block is pinned (kept on the map past its linger) and the toggle. */
  pinned?: boolean
  onTogglePin?: () => void
}

/** Space under the top bar that the session summary card (top left) takes, px: the panel starts below it. */
const SESSION_CARD_CLEARANCE = 52

/**
 * Read-only list of the latest interactions of a Kanban board, a Supermemory namespace or a Bash command head.
 * A Bash row shows the full command (masked when it was taken in, see bash-blocks.ts), wrapped, not cut.
 */
export function FleetInspector({ inspection, now, onClose, right, top, narrow, pinned = false, onTogglePin }: FleetInspectorProps) {
  const color = inspection.kind === 'kanban' ? KANBAN_COLOR : inspection.kind === 'bash' ? BASH_COLOR : inspection.kind === 'subsystem' ? SUBSYSTEM_COLOR : SUPERMEMORY_COLOR
  const kindLabel = inspection.kind === 'kanban' ? 'Kanban' : inspection.kind === 'bash' ? 'Bash' : inspection.kind === 'subsystem' ? 'Subsystem' : 'Memory'
  const isBash = inspection.kind === 'bash'
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
          {kindLabel} · {inspection.title}
        </span>
        <span className="flex items-center gap-3">
          {onTogglePin && (
            <button
              type="button"
              data-testid="fleet-inspector-pin"
              aria-pressed={pinned}
              title={pinned ? 'Unpin: the block fades after its linger again' : 'Pin: keep this block on the map'}
              onClick={onTogglePin}
              style={{ color: pinned ? color : COLORS.textMuted }}
            >
              {pinned ? 'Pinned' : 'Pin'}
            </button>
          )}
          <button type="button" aria-label="Close inspector" data-testid="fleet-inspector-close" className="af-tap af-focus px-1" onClick={onClose} style={{ color: COLORS.textMuted }}>
            ✕
          </button>
        </span>
      </div>
      {inspection.block && (
        <div data-testid="fleet-inspector-block" className="px-3 py-1" style={{ borderBottom: `1px solid ${color}22`, color: COLORS.textMuted }}>
          <div data-testid="fleet-inspector-counts">{kanbanCountsLine(inspection.block)}</div>
          {inspection.block.kinds.length > 0 && (
            <div data-testid="fleet-inspector-kinds">{inspection.block.kinds.map(([k, n]) => `${k} ×${n}`).join(' · ')}</div>
          )}
        </div>
      )}
      {inspection.summary && (
        <div data-testid="fleet-inspector-summary" className="px-3 py-1" style={{ borderBottom: `1px solid ${color}22`, color: COLORS.textMuted }}>
          {inspection.summary}
        </div>
      )}
      <div className="overflow-y-auto px-3 py-1" style={{ minHeight: 0 }}>
        {inspection.items.length === 0 && <div className="py-2" style={{ color: COLORS.textMuted }}>No interactions recorded yet.</div>}
        {inspection.items.map((item, i) => (
          <div key={`${item.at}-${i}`} data-testid="fleet-inspector-row" className="flex gap-2 py-1" style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <span className="shrink-0" style={{ color: COLORS.textMuted, width: 74 }}>{ageLabel(item.at, now)}</span>
            <span className="shrink-0 truncate" style={{ width: 72 }}>{item.profile ?? '—'}</span>
            <span className="shrink-0" style={{ color, width: 64 }}>{item.action}</span>
            {item.detail && (isBash
              ? <span data-testid="fleet-inspector-command" className="min-w-0" style={{ color: COLORS.textPrimary ?? '#cfe', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{item.detail}</span>
              : <span className="truncate" style={{ color: COLORS.textMuted }}>{item.detail}</span>)}
          </div>
        ))}
        {inspection.more > 0 && (
          <div data-testid="fleet-inspector-more" className="py-1" style={{ color: COLORS.textMuted }}>+{inspection.more} more</div>
        )}
      </div>
    </div>
  )
}
