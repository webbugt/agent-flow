"use client"

import type { MutableRefObject } from "react"
import { COLORS } from "@/lib/colors"
import { Z } from "@/lib/agent-types"
import { BUTTON_ZOOM_STEP } from "@/lib/fleet/fleet-camera"
import type { CanvasControls } from "./canvas"

/**
 * +, − and fit for the single-session graph (the Fleet map has its own set). A phone has no wheel and no double click, so
 * these are the only way to zoom besides a pinch. On a tall screen they sit on the right edge, vertically centred: clear
 * of the top bar, of the whole bottom stack (control bar, LIMITS, timeline, chat, resource blocks) and of the mid-left
 * node card. On a SHORT screen (a landscape phone, 390 px high) the expanded LIMITS panel reaches up to the middle of the
 * right edge, so there the controls are one row right under the top bar (`.af-single-zoom` in globals.css). A side sheet
 * (Session, Transcript) opens over them, which is right: they zoom the graph behind it.
 */
export function SingleZoomControls({ controlsRef, visible }: { controlsRef: MutableRefObject<CanvasControls | null>; visible: boolean }) {
  if (!visible) return null
  const buttons = [
    ["single-zoom-in", "Zoom in", "+", () => controlsRef.current?.zoomBy(BUTTON_ZOOM_STEP)],
    ["single-zoom-out", "Zoom out", "\u2212", () => controlsRef.current?.zoomBy(1 / BUTTON_ZOOM_STEP)],
    ["single-zoom-fit", "Fit to view", "\u2922", () => controlsRef.current?.fit()],
  ] as const
  return (
    <div
      data-testid="single-zoom-controls"
      className="af-single-zoom absolute flex flex-col gap-1.5"
      style={{ right: 12, zIndex: Z.info }}
    >
      {buttons.map(([testid, label, glyph, onClick]) => (
        <button
          key={testid}
          type="button"
          data-testid={testid}
          aria-label={label}
          title={label}
          onClick={onClick}
          className="font-mono rounded flex items-center justify-center select-none"
          style={{
            width: 40, height: 40, fontSize: 20, lineHeight: 1, touchAction: "manipulation",
            background: "rgba(8,12,24,0.88)", border: `1px solid ${COLORS.holoBase}66`, color: COLORS.textPrimary,
          }}
        >
          {glyph}
        </button>
      ))}
    </div>
  )
}
