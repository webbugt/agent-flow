import { ToolCallNode } from '@/lib/agent-types'
import { COLORS, withAlpha } from '@/lib/colors'
import { TOOL_DRAW } from '@/lib/canvas-constants'
import { toolChip, type ChipIcon } from '@/lib/fleet/tool-chip'
import { measureTextCached } from './render-cache'

/** Chip geometry, world units. */
export const CHIP = {
  height: 18,
  iconSize: 10,
  padX: 6,
  gap: 4,
  fontSize: 9,
  radius: 9,
} as const

/** Icons are drawn as vector paths, so they look the same on every machine (no emoji font needed). */
export function drawChipIcon(ctx: CanvasRenderingContext2D, icon: ChipIcon, cx: number, cy: number, size: number): void {
  const h = size / 2
  ctx.save()
  ctx.lineWidth = 1.2
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  switch (icon) {
    case 'read': // a page with text lines
      ctx.rect(cx - h * 0.7, cy - h, h * 1.4, size)
      ctx.moveTo(cx - h * 0.35, cy - h * 0.3); ctx.lineTo(cx + h * 0.35, cy - h * 0.3)
      ctx.moveTo(cx - h * 0.35, cy + h * 0.25); ctx.lineTo(cx + h * 0.35, cy + h * 0.25)
      break
    case 'edit': // a pencil
      ctx.moveTo(cx - h, cy + h); ctx.lineTo(cx - h * 0.85, cy + h * 0.35); ctx.lineTo(cx + h * 0.6, cy - h * 0.9)
      ctx.lineTo(cx + h, cy - h * 0.5); ctx.lineTo(cx - h * 0.35, cy + h * 0.85); ctx.closePath()
      break
    case 'write': // a page with a plus
      ctx.rect(cx - h * 0.7, cy - h, h * 1.4, size)
      ctx.moveTo(cx - h * 0.35, cy); ctx.lineTo(cx + h * 0.35, cy)
      ctx.moveTo(cx, cy - h * 0.35); ctx.lineTo(cx, cy + h * 0.35)
      break
    case 'bash': // a prompt: > _
      ctx.moveTo(cx - h, cy - h * 0.6); ctx.lineTo(cx - h * 0.2, cy); ctx.lineTo(cx - h, cy + h * 0.6)
      ctx.moveTo(cx + h * 0.1, cy + h * 0.65); ctx.lineTo(cx + h, cy + h * 0.65)
      break
    case 'search': // a magnifier
      ctx.arc(cx - h * 0.15, cy - h * 0.15, h * 0.65, 0, Math.PI * 2)
      ctx.moveTo(cx + h * 0.35, cy + h * 0.35); ctx.lineTo(cx + h, cy + h)
      break
    case 'web': // a globe
      ctx.arc(cx, cy, h, 0, Math.PI * 2)
      ctx.moveTo(cx - h, cy); ctx.lineTo(cx + h, cy)
      ctx.moveTo(cx + h * 0.45, cy); ctx.ellipse(cx, cy, h * 0.45, h, 0, 0, Math.PI * 2)
      break
    case 'memory': // a stack (database)
      ctx.ellipse(cx, cy - h * 0.55, h * 0.8, h * 0.4, 0, 0, Math.PI * 2)
      ctx.moveTo(cx - h * 0.8, cy - h * 0.55); ctx.lineTo(cx - h * 0.8, cy + h * 0.55)
      ctx.moveTo(cx + h * 0.8, cy - h * 0.55); ctx.lineTo(cx + h * 0.8, cy + h * 0.55)
      ctx.moveTo(cx - h * 0.8, cy + h * 0.55); ctx.ellipse(cx, cy + h * 0.55, h * 0.8, h * 0.4, 0, Math.PI, 0, true)
      break
    case 'task': // a fork: one line splits in two
      ctx.moveTo(cx, cy + h); ctx.lineTo(cx, cy)
      ctx.lineTo(cx - h * 0.7, cy - h * 0.8)
      ctx.moveTo(cx, cy); ctx.lineTo(cx + h * 0.7, cy - h * 0.8)
      break
    case 'plan': // a checklist
      ctx.moveTo(cx - h, cy - h * 0.55); ctx.lineTo(cx - h * 0.7, cy - h * 0.25); ctx.lineTo(cx - h * 0.3, cy - h * 0.8)
      ctx.moveTo(cx + h * 0.1, cy - h * 0.5); ctx.lineTo(cx + h, cy - h * 0.5)
      ctx.moveTo(cx - h, cy + h * 0.5); ctx.lineTo(cx + h, cy + h * 0.5)
      break
    case 'kanban': // three columns
      ctx.rect(cx - h, cy - h * 0.8, h * 0.55, h * 1.6)
      ctx.rect(cx - h * 0.28, cy - h * 0.8, h * 0.55, h * 1.1)
      ctx.rect(cx + h * 0.45, cy - h * 0.8, h * 0.55, h * 1.35)
      break
    default: // a ring with a dot
      ctx.arc(cx, cy, h * 0.7, 0, Math.PI * 2)
      ctx.moveTo(cx + h * 0.15, cy); ctx.arc(cx, cy, h * 0.15, 0, Math.PI * 2)
  }
  ctx.stroke()
  ctx.restore()
}

/**
 * Screensaver mode: every tool call is one short chip, icon + verb ("Bash", "Read", "Memory write").
 * The arguments and output never reach the canvas here. Same positions, states and fading as the
 * verbose cards (`drawToolCalls`), so the animation is the same.
 *
 * `minTextPx`: as in the verbose cards, the verb is left out when it would be smaller than this on the
 * screen (fleet map zoomed out); the chip and its icon stay.
 */
export function drawToolChips(
  ctx: CanvasRenderingContext2D,
  toolCalls: Map<string, ToolCallNode>,
  time: number,
  selectedToolCallId?: string | null,
  minTextPx = 0,
) {
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const zoom = ctx.getTransform().a / dpr
  const textLegible = minTextPx <= 0 || !(zoom > 0) || CHIP.fontSize * zoom >= minTextPx
  for (const [id, tool] of toolCalls) {
    const isRunning = tool.state === 'running'
    const isError = tool.state === 'error'
    const pulse = isRunning ? Math.sin(time * 4) * 0.2 + 0.8 : isError ? Math.sin(time * 6) * 0.15 + 0.85 : 0.5
    const { verb, icon } = toolChip(tool.toolName)

    ctx.save()
    ctx.globalAlpha = tool.opacity
    ctx.font = `${CHIP.fontSize}px monospace`
    const textW = textLegible ? measureTextCached(ctx, verb) : 0
    const w = CHIP.padX * 2 + CHIP.iconSize + (textLegible ? CHIP.gap + textW : 0)
    const h = CHIP.height
    const x = tool.x - w / 2
    const y = tool.y - h / 2
    const isSelected = id === selectedToolCallId

    if (isError) {
      ctx.shadowColor = COLORS.error
      ctx.shadowBlur = TOOL_DRAW.errorGlowBase + Math.sin(time * 6) * TOOL_DRAW.errorGlowPulse
    }
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, CHIP.radius)
    ctx.fillStyle = isError
      ? withAlpha(COLORS.toolCardErrorBase, 0.8 * pulse)
      : isSelected ? withAlpha(COLORS.toolCardSelectedBase, 0.15 * pulse) : withAlpha(COLORS.toolCardBase, 0.7 * pulse)
    ctx.fill()
    ctx.strokeStyle = isError ? COLORS.error + '90' : isSelected ? COLORS.holoBase + 'aa' : isRunning ? COLORS.tool + '60' : COLORS.return + '40'
    ctx.lineWidth = isError ? 2 : 1
    ctx.stroke()
    ctx.shadowBlur = 0

    if (isRunning) {
      ctx.beginPath()
      ctx.arc(tool.x, tool.y, Math.max(w, h) / 2 + TOOL_DRAW.spinRingPadding, time * TOOL_DRAW.spinSpeed, time * TOOL_DRAW.spinSpeed + TOOL_DRAW.spinArc)
      ctx.strokeStyle = COLORS.tool + '50'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }

    const color = isRunning ? COLORS.tool : isError ? COLORS.error : COLORS.return
    ctx.strokeStyle = color
    drawChipIcon(ctx, icon, x + CHIP.padX + CHIP.iconSize / 2, tool.y, CHIP.iconSize)
    if (textLegible) {
      ctx.fillStyle = color
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(verb, x + CHIP.padX + CHIP.iconSize + CHIP.gap, tool.y)
    }
    ctx.restore()
  }
}
