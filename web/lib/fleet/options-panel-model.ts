/**
 * Pure helpers of the options panel (components/agent-visualizer/options-panel.tsx): the wording of each row and
 * the parsing of what the user types, so both are testable without a DOM. The registry stays the authority:
 * a value that passes here is checked again by `applyOptionsPatch` before it is stored.
 */
import {
  BLOCK_VIEWS, DEFAULT_FADE_SECONDS, DEFAULT_LINGER_SECONDS, MAX_FADE_SECONDS, MAX_LINGER_SECONDS, RESOURCE_KINDS,
  type OptionsPatch, type ResourceKind,
} from './options-registry'

export const KIND_LABELS: Readonly<Record<ResourceKind, string>> = {
  kanban: 'Kanban boards',
  memory: 'Memory containers',
  bash: 'Bash commands',
  subsystem: 'Hermes subsystems',
}

export type SecondsInput = { ok: true; value: number } | { ok: false; error: string }

/** Parse a "seconds" field. Accepts "20", "7.5", " 0 "; rejects empty, text, negatives, and values above `max`. */
export function parseSecondsInput(text: string, max: number): SecondsInput {
  const t = text.trim().replace(',', '.')
  if (t === '') return { ok: false, error: 'Enter a number of seconds.' }
  if (!/^\d+(\.\d+)?$/.test(t)) return { ok: false, error: 'Use a plain number, for example 20 or 7.5.' }
  const n = Number(t)
  if (!Number.isFinite(n)) return { ok: false, error: 'Use a plain number, for example 20 or 7.5.' }
  if (n > max) return { ok: false, error: `At most ${max} seconds.` }
  return { ok: true, value: n }
}

export const parseLingerInput = (text: string): SecondsInput => parseSecondsInput(text, MAX_LINGER_SECONDS)
export const parseFadeInput = (text: string): SecondsInput => parseSecondsInput(text, MAX_FADE_SECONDS)

/** Short hint under a linger field: what the current value means. */
export function lingerHint(seconds: number): string {
  if (seconds === 0) return 'hidden immediately (a pinned block stays)'
  return `fully visible ${seconds} s after the last use`
}

export function fadeHint(seconds: number): string {
  return seconds === 0 ? 'hard cut at the end of the linger time' : `then fades out over ${seconds} s`
}

/** The patch that puts every resource-block setting back to its default (the other options stay as they are). */
export function resourceBlockDefaultsPatch(): OptionsPatch {
  const lingerSeconds: Partial<Record<ResourceKind, number>> = {}
  const show: Record<string, Record<string, boolean>> = {}
  for (const k of RESOURCE_KINDS) lingerSeconds[k] = DEFAULT_LINGER_SECONDS[k]
  for (const v of BLOCK_VIEWS) {
    show[v] = {}
    for (const k of RESOURCE_KINDS) show[v][k] = true
  }
  return { lingerSeconds, fadeSeconds: DEFAULT_FADE_SECONDS, show }
}

export function hiddenAgentsText(count: number): string {
  if (count === 0) return 'No agents or lanes are hidden.'
  return count === 1 ? '1 agent or lane is hidden in the fleet.' : `${count} agents or lanes are hidden in the fleet.`
}
