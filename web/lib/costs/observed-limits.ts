/**
 * View model of the observed Claude usage limits (PLAN v2 6.5, task P6a). Pure: the host's `limits-update` payload
 * in, plain strings out; the local clock is injected so tests do not depend on the machine's time zone.
 *
 * What is shown and how it is labelled:
 *  - `obs`   a number Claude Code itself reported (statusLine `rate_limits`), recent.
 *  - `stale` the same kind of number, but the last reading is old: shown with `as of HH:MM`, never as current.
 *  - a window whose reset time has passed shows `–` (its percentage described a window that ended).
 *  - no reading at all: no number, and the page keeps estimating. Absent is never shown as 0%.
 * Every row's hover text names the provider and says the figure is observed (not billed, not list-equivalent,
 * not estimated) and where it came from.
 */
import { formatLimitPct } from './format'
import type { LimitsUpdatePayload, ObservedLimitWindow } from './observed-types'

/** Local-time helpers; the component passes `Date`-based ones, tests pass fixed ones. */
export interface LocalClock {
  /** `14:05` */
  hm(ms: number): string
  /** `Nov 24 14:05` */
  dayHm(ms: number): string
  sameDay(a: number, b: number): boolean
}

export type LimitsMode = 'observed' | 'waiting' | 'prompt' | 'unavailable' | 'refused' | 'broken'

export interface ObservedRow {
  key: string
  label: string
  /** `23%`, `4.5‰`, or `–` when unknown / expired. */
  valueText: string
  /** 0..1 for a bar; null when there is no value. */
  fraction: number | null
  tag: 'obs' | 'stale' | 'ended'
  /** `resets in 2h 15m` / `reset at 14:05` / `window ended` */
  resetText: string
  /** Same in words for the hover. */
  title: string
}

export interface ObservedLimitsView {
  mode: LimitsMode
  /** Headline sentence for the section. */
  headline: string
  rows: ObservedRow[]
  /** `as of 14:05`: set when the reading is stale (and never on a fresh one). */
  asOfText: string | null
  /** Short text for the top-bar chip; null when there is nothing worth a chip. */
  chip: { text: string; title: string; tone: 'ok' | 'stale' | 'info' } | null
  notes: string[]
  /** What the buttons may do. */
  canInstall: boolean
  canRemove: boolean
  /** Not configurable from this host: the command to run in VS Code instead. */
  installHint: string | null
  /** N1: the launcher could not find node the last time it ran, and no reading arrived since. Shown in the drawer, the panel and the chip. */
  nodeMissingNote: string | null
  /** N1: a one-click re-install that fixes the wrapper in place: upgrades the legacy command, or re-records node. */
  reinstall: { label: string } | null
}

const PROVIDER = 'Claude Code'
export const INSTALL_COMMAND = 'Agent Flow: Configure Claude statusLine'

export function labelOf(w: ObservedLimitWindow): string {
  return w.kind === 'five_hour' ? '5-hour' : w.kind === 'seven_day' ? 'Weekly' : w.key.replace(/_/g, ' ')
}
function shortLabel(w: ObservedLimitWindow): string {
  return w.kind === 'five_hour' ? '5h' : w.kind === 'seven_day' ? 'wk' : w.key.replace(/_/g, ' ')
}

/** `2h 15m`, `45m`, `3d 4h`, `<1m`. */
export function formatUntil(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '<1m'
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  const m = min % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

function atText(clock: LocalClock, ms: number, now: number): string {
  return clock.sameDay(ms, now) ? clock.hm(ms) : clock.dayHm(ms)
}

function rowOf(w: ObservedLimitWindow, at: number, now: number, clock: LocalClock): ObservedRow {
  const ended = w.state === 'expired'
  const fraction = !ended && w.usedPct !== null ? Math.max(0, w.usedPct) / 100 : null
  const stale = w.state === 'stale'
  const tag: ObservedRow['tag'] = ended ? 'ended' : stale ? 'stale' : 'obs'
  const resetText = w.resetsAt === null ? ''
    : ended ? 'window ended'
    : w.resetsAt - now < 24 * 3_600_000 && w.resetsAt - now > 0 ? `resets in ${formatUntil(w.resetsAt - now)}`
    : `resets ${atText(clock, w.resetsAt, now)}`
  const lines = [
    `${PROVIDER} · ${labelOf(w)} usage limit · observed (reported by Claude Code, not an estimate and not a price)`,
    ended ? 'The window has ended; its last percentage no longer applies.'
      : w.usedPct === null ? 'No percentage in the last reading.'
      : `Used: ${formatLimitPct(fraction as number, 'observed')} of the window, as reported at ${atText(clock, at, now)}${stale ? ' (stale)' : ''}.`,
    ...(w.resetsAt !== null ? [`${ended ? 'Ended' : 'Resets'}: ${atText(clock, w.resetsAt, now)}.`] : []),
    'Source: statusLine rate_limits, saved to ~/.agent-flow/limits/claude.json. Covers the whole account, not just this machine.',
  ]
  return {
    key: w.key, label: labelOf(w), fraction, tag, resetText,
    valueText: fraction === null ? '–' : formatLimitPct(fraction, 'observed'),
    title: lines.join('\n'),
  }
}

const NOT_CONFIGURABLE = `Setting this up edits ~/.claude/settings.json, so it is only offered from the VS Code extension (command "${INSTALL_COMMAND}").`

const LEGACY_NOTE = 'The wrapper is installed with the old command form, which fixes one node path: if node is upgraded or moved, readings stop without a warning. Upgrade it once; your own status line and settings are not changed.'

/** Build the view. `payload` null = the host has not sent a limits message (older host): show nothing actionable. */
export function buildObservedLimitsView(payload: LimitsUpdatePayload | null, now: number, clock: LocalClock): ObservedLimitsView {
  const view = buildBaseView(payload, now, clock)
  return payload ? withInstallHealth(view, payload, now, clock) : view
}

/**
 * N1: the two things a working-looking install can hide. (1) The launcher found no node (marker newer than the last
 * reading): say so instead of letting the numbers just age into `as of HH:MM`. (2) The legacy command: it works today
 * and fails silently once its node path moves; offer the upgrade. The estimate fallback of the panel is untouched.
 */
function withInstallHealth(view: ObservedLimitsView, payload: LimitsUpdatePayload, now: number, clock: LocalClock): ObservedLimitsView {
  const installed = payload.install.state === 'installed'
  const nm = installed && payload.nodeMissing && (!payload.observed || payload.observed.at < payload.nodeMissing.at) ? payload.nodeMissing : null
  const legacy = installed && payload.install.legacy === true
  if (!nm && !legacy) return view
  const out: ObservedLimitsView = { ...view, notes: [...view.notes] }
  if (legacy) out.notes.unshift(LEGACY_NOTE)
  if (nm) {
    const since = atText(clock, nm.at, now)
    const hasRows = view.rows.length > 0
    out.nodeMissingNote = `The wrapper cannot find node (last tried ${since}), so Claude Code's limits are not being updated. ${hasRows ? `The numbers shown are the last reading${view.asOfText ? `, ${view.asOfText}` : ''}. ` : ''}Limits are estimated until node is found again: install node, or run "${INSTALL_COMMAND}" again.`
    out.notes.unshift(out.nodeMissingNote)
    out.headline = hasRows
      ? `The wrapper cannot find node (last tried ${since}). Showing the last reading${view.asOfText ? `, ${view.asOfText}` : ''}; it is not current.`
      : `The wrapper cannot find node (last tried ${since}), so no readings can arrive. Limits stay estimated.`
    out.chip = {
      text: view.mode === 'observed' && view.chip ? `${view.chip.text} · no node` : 'limits: no node',
      title: `The wrapper cannot find node (last tried ${since}), so Claude Code's limits are not being updated. ${view.mode === 'observed' ? 'The figures are the last reading. ' : 'Limits are estimated. '}Open for details.`,
      tone: 'stale',
    }
  }
  if (payload.canConfigure && ((legacy && payload.install.canUpgrade === true) || nm)) out.reinstall = { label: legacy ? 'Upgrade wrapper…' : 'Repair wrapper…' }
  return out
}

function buildBaseView(payload: LimitsUpdatePayload | null, now: number, clock: LocalClock): ObservedLimitsView {
  const base: ObservedLimitsView = {
    mode: 'unavailable', headline: 'Usage limits are estimated from this machine only.', rows: [], asOfText: null, chip: null, notes: [],
    canInstall: false, canRemove: false, installHint: null, nodeMissingNote: null, reinstall: null,
  }
  if (!payload) return base
  const installed = payload.install.state === 'installed'
  const notes: string[] = []
  if (payload.fileError) notes.push(`The saved limits file cannot be used (${payload.fileError}). Limits stay estimated until it is rewritten.`)
  for (const w of payload.install.warnings ?? []) notes.push(w)
  if (installed && (payload.install.shadowedBy?.length ?? 0) > 0) {
    notes.push(`A project statusLine in ${payload.install.shadowedBy!.join(', ')} replaces the wrapper inside that project, so readings may be missing while it is open.`)
  }
  const canRemove = payload.canConfigure && installed
  const hint = payload.canConfigure ? null : NOT_CONFIGURABLE

  if (payload.observed && payload.observed.windows.length > 0) {
    const o = payload.observed
    const rows = o.windows.map(w => rowOf(w, o.at, now, clock))
    const stale = o.stale
    const asOf = stale ? `as of ${atText(clock, o.at, now)}` : null
    const chipParts = o.windows.filter(w => w.kind !== 'other').map((w, i) => `${shortLabel(w)} ${rows.find(r => r.key === w.key)!.valueText}`)
    return {
      ...base, mode: 'observed', rows, asOfText: asOf, notes, canRemove, installHint: hint,
      headline: stale ? `Last reading ${asOf}. It is not current: Claude Code reports limits only while its terminal UI is running.` : 'Usage limits reported by Claude Code.',
      chip: {
        text: `${chipParts.join(' · ')}${asOf ? ` · ${asOf}` : ''}`,
        title: `${PROVIDER} usage limits, observed${asOf ? ` (${asOf}, stale)` : ''}. Open for details.`,
        tone: stale ? 'stale' : 'ok',
      },
    }
  }

  if (installed) {
    return {
      ...base, mode: 'waiting', notes, canRemove, installHint: hint,
      headline: 'Wrapper installed. Waiting for the first reading: it arrives after the next reply in Claude Code\'s terminal UI (not in -p mode).',
      chip: { text: 'limits: waiting', title: 'The statusLine wrapper is installed; no reading yet. Limits stay estimated until one arrives.', tone: 'info' },
    }
  }

  if (payload.install.state === 'refused' || payload.install.state === 'broken') {
    const broken = payload.install.state === 'broken'
    return {
      ...base, mode: broken ? 'broken' : 'refused', notes, canRemove: false, installHint: hint,
      headline: broken ? 'The statusLine wrapper needs repair. Limits stay estimated.' : 'Observing limits is not possible here, so limits stay estimated.',
      chip: { text: 'limits: est.', title: `${payload.install.reason ?? 'Observed limits are not available.'} Limits are estimated.`, tone: 'info' },
    }
  }

  return {
    ...base, mode: 'prompt', notes, canInstall: payload.canConfigure && payload.install.canInstall, canRemove: false, installHint: hint,
    headline: 'Observe your real 5-hour and weekly Claude limits?',
    chip: { text: 'limits: set up', title: 'Claude limits are estimated from this machine only. Click to observe the real values.', tone: 'info' },
  }
}
