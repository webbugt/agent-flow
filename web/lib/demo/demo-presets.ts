/**
 * Choices the demo control panel offers. Invented names only (profiles of the demo fleet, board slugs, container
 * tags): nothing here is read from, or has to match, a live installation.
 */
import type { ResourceKind } from './demo-state'

/** Profile names offered in the picker (a free name can be typed as well). */
export const DEMO_PROFILE_PRESETS: readonly string[] = ['taxis', 'sophia', 'hestia', 'omh-coder', 'omh-reviewer', 'omh-writer']

/** Tools the panel can fire (name only; the arguments get a default per tool, see demo-state.defaultArgs). */
export const DEMO_TOOL_PRESETS: readonly string[] = ['Read', 'Edit', 'Bash', 'Grep', 'WebSearch']

export const RESOURCE_KIND_LABELS: Readonly<Record<ResourceKind, string>> = {
  kanban: 'Kanban board',
  memory: 'Supermemory',
  bash: 'Bash command',
  subsystem: 'Subsystem',
}

/** The value the resource form starts with, per kind. */
export const RESOURCE_DEFAULT_KEYS: Readonly<Record<ResourceKind, string>> = {
  kanban: 'demo-board',
  memory: 'demo_memory',
  bash: 'git',
  subsystem: 'cron',
}

/** What the key of each kind is called in the form. */
export const RESOURCE_KEY_LABELS: Readonly<Record<ResourceKind, string>> = {
  kanban: 'board slug',
  memory: 'container tag',
  bash: 'command head',
  subsystem: 'subsystem',
}
