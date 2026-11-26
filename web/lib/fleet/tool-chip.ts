/**
 * Screensaver mode: a tool call is drawn as a short chip (icon + verb) instead of the verbose
 * `Tool: args` card. This is the pure part: which verb and which icon a tool name gets.
 * The full text stays in the simulation state and in the detail panel; nothing here shortens data.
 */

export type ChipIcon = 'read' | 'edit' | 'write' | 'bash' | 'search' | 'web' | 'memory' | 'task' | 'plan' | 'kanban' | 'generic'

export interface ToolChip {
  verb: string
  icon: ChipIcon
}

/** Longest verb a chip shows (characters). */
export const CHIP_VERB_MAX = 16

/** Verb for tool names the app does not know: `browser_snapshot` -> "Browser snapshot", capped. */
function humanize(name: string): string {
  // MCP tool names look like mcp__server__tool: the tool part is the verb
  const tail = name.includes('__') ? name.split('__').filter(Boolean).pop() ?? name : name
  const words = tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_\-.]+/).filter(Boolean)
  if (words.length === 0) return 'Tool'
  const text = words.join(' ').toLowerCase()
  const cased = text.charAt(0).toUpperCase() + text.slice(1)
  return cased.length > CHIP_VERB_MAX ? cased.slice(0, CHIP_VERB_MAX - 1).trimEnd() + '\u2026' : cased
}

const EXACT: Record<string, ToolChip> = {
  read: { verb: 'Read', icon: 'read' },
  read_file: { verb: 'Read', icon: 'read' },
  view: { verb: 'Read', icon: 'read' },
  notebookread: { verb: 'Read', icon: 'read' },
  edit: { verb: 'Edit', icon: 'edit' },
  multiedit: { verb: 'Edit', icon: 'edit' },
  notebookedit: { verb: 'Edit', icon: 'edit' },
  patch: { verb: 'Edit', icon: 'edit' },
  apply_patch: { verb: 'Edit', icon: 'edit' },
  write: { verb: 'Write', icon: 'write' },
  write_file: { verb: 'Write', icon: 'write' },
  bash: { verb: 'Bash', icon: 'bash' },
  bashoutput: { verb: 'Bash', icon: 'bash' },
  killshell: { verb: 'Bash', icon: 'bash' },
  terminal: { verb: 'Bash', icon: 'bash' },
  execute_code: { verb: 'Bash', icon: 'bash' },
  exec_command: { verb: 'Bash', icon: 'bash' },
  shell: { verb: 'Bash', icon: 'bash' },
  grep: { verb: 'Search', icon: 'search' },
  glob: { verb: 'Search', icon: 'search' },
  search_files: { verb: 'Search', icon: 'search' },
  toolsearch: { verb: 'Search', icon: 'search' },
  websearch: { verb: 'Web search', icon: 'web' },
  web_search: { verb: 'Web search', icon: 'web' },
  webfetch: { verb: 'Fetch', icon: 'web' },
  web_extract: { verb: 'Fetch', icon: 'web' },
  task: { verb: 'Delegate', icon: 'task' },
  agent: { verb: 'Delegate', icon: 'task' },
  delegate_task: { verb: 'Delegate', icon: 'task' },
  todowrite: { verb: 'Plan', icon: 'plan' },
  todo_list: { verb: 'Plan', icon: 'plan' },
  update_plan: { verb: 'Plan', icon: 'plan' },
  omh_todo: { verb: 'Plan', icon: 'plan' },
}

/** Memory tools that only read; every other memory tool is a write. */
const MEMORY_READ_OPS: ReadonlySet<string> = new Set(['search', 'profile', 'recall', 'read', 'get', 'list', 'query'])

/**
 * The chip for a tool name. Names come from Claude Code (`Bash`, `Read`), Codex (`exec_command`),
 * Hermes (`terminal`, `read_file`, `patch`, `supermemory_store`, `kanban_show`) and MCP servers.
 */
export function toolChip(toolName: string): ToolChip {
  const name = (toolName || '').trim()
  const lower = name.toLowerCase()
  const exact = EXACT[lower]
  if (exact) return exact
  if (lower.startsWith('browser_') || lower === 'browser_exec') return { verb: 'Browser', icon: 'web' }
  if (lower.startsWith('kanban_')) return { verb: 'Kanban', icon: 'kanban' }
  if (lower.includes('memory')) {
    const op = lower.replace(/^.*memory[_-]?/, '')
    // whole words only: "forget" contains "get" but deletes
    const isRead = op.split(/[_-]/).some(w => MEMORY_READ_OPS.has(w))
    return { verb: isRead ? 'Memory read' : 'Memory write', icon: 'memory' }
  }
  return { verb: humanize(name), icon: 'generic' }
}
