/**
 * One-time migration of the old client-side settings into the options registry (agentflow.options.v1).
 *
 * The four old localStorage keys, and where each value lands:
 * - `agent-flow:fleet-selection:v1`        -> options.fleetDeselected
 * - `agent-flow:fleet-timeline-visible:v1` -> options.fleetTimelineVisible
 * - `agentFlow.costUnit`                   -> options.costUnit
 * - `agent-viz-sound`                      -> options.soundOn
 *
 * Rules:
 * - Runs once: after a successful save `options.legacyMigrated` is true and later calls change nothing, even if
 *   an old key still holds something (an old build in another tab may keep writing them; that is ignored).
 * - The old keys are READ ONLY here. They are not deleted: removal is a separate step after this migration has
 *   been verified in use (see the C2 report). Leaving them also makes a rollback to an older build lossless.
 * - A missing or garbled old value leaves that option at its default. A value that parses is copied.
 * - If the save fails (quota, private mode) the migrated options still apply in memory and `saved` is false;
 *   the next load tries again.
 *
 * Pure functions on an injected Storage, so they are testable without a DOM.
 */
import { parseUnitOverride } from '../costs/overlay'
import { parseSelection } from './fleet-selection'
import { parseTimelineVisible } from './fleet-timeline-pref'
import {
  MAX_DESELECTED_ID_LENGTH, MAX_DESELECTED_IDS, loadOptions, saveOptions,
  type AgentFlowOptions, type StorageLike,
} from './options-registry'

export const LEGACY_KEYS = {
  fleetSelection: 'agent-flow:fleet-selection:v1',
  fleetTimeline: 'agent-flow:fleet-timeline-visible:v1',
  costUnit: 'agentFlow.costUnit',
  sound: 'agent-viz-sound',
} as const

export type LegacyField = keyof typeof LEGACY_KEYS

export interface MigrationResult {
  options: AgentFlowOptions
  /** True when this call copied the old keys in (false when it was already done, or there is no storage). */
  migrated: boolean
  /** Which old keys held a value that was copied. */
  imported: LegacyField[]
  /** Whether the migrated options were written. False = in memory only, retried on the next load. */
  saved: boolean
}

function read(storage: StorageLike, key: string): string | null {
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

export function migrateLegacySettings(storage: StorageLike | null | undefined): MigrationResult {
  const base = loadOptions(storage)
  if (!storage) return { options: base, migrated: false, imported: [], saved: false }
  if (base.legacyMigrated) return { options: base, migrated: false, imported: [], saved: true }

  const options: AgentFlowOptions = { ...base, legacyMigrated: true }
  const imported: LegacyField[] = []

  const rawSel = read(storage, LEGACY_KEYS.fleetSelection)
  if (rawSel !== null) {
    const ids = [...parseSelection(rawSel)].filter(id => id !== '' && id.length <= MAX_DESELECTED_ID_LENGTH).slice(0, MAX_DESELECTED_IDS)
    options.fleetDeselected = ids
    imported.push('fleetSelection')
  }
  const rawTimeline = read(storage, LEGACY_KEYS.fleetTimeline)
  if (rawTimeline !== null) {
    options.fleetTimelineVisible = parseTimelineVisible(rawTimeline)
    imported.push('fleetTimeline')
  }
  const rawUnit = read(storage, LEGACY_KEYS.costUnit)
  if (rawUnit !== null) {
    const o = parseUnitOverride(rawUnit)
    if (o) {
      options.costUnit = { unit: o.unit, cfg: o.cfgUnit }
      imported.push('costUnit')
    }
  }
  const rawSound = read(storage, LEGACY_KEYS.sound)
  if (rawSound !== null) {
    options.soundOn = rawSound === 'on'
    imported.push('sound')
  }

  const saved = saveOptions(storage, options)
  return { options, migrated: true, imported, saved }
}
