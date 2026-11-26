/**
 * The "head" of a shell command: the program it runs (`git`, `pnpm`, `hermes`), and nothing else. This is the
 * only part of a bash command that a block shows on the Fleet map (binding decision 3); the full text is
 * shown in the inspector, masked (secret-mask.ts).
 *
 * Head extraction skips what is not the program:
 *   - leading `VAR=value` assignments, `sudo`/`env`/`time`/`nohup`/`nice`/`command`/`exec` and their options
 *   - a leading `cd <dir> &&`, `export X=1;`, `source f &&`, `set -e;` segment (only when something follows it)
 *   - `bash -c '...'`, `sh -lc "..."`: the head of the inner command
 *   - comment lines and blank lines of a multi-line command
 * and stops at the first pipe, `&&`, `;`: `cat a | grep b` has the head `cat`.
 *
 * Safety: the head is accepted only if it is a plain program name (letters, digits, `. _ + -`, at most 40
 * characters, the base name of a path) and masking leaves it unchanged. Anything else is `command`, so a
 * quoted string, a variable, a subshell or a secret that sits in the first word never becomes a block label.
 * Hermes' `execute_code` arrives as the same Bash tool (hermes-logs.ts maps both), so its Python source is
 * indistinguishable here; its first word can only become a head by passing the same rules.
 */
import { maskSecrets } from './secret-mask'

export const FALLBACK_HEAD = 'command'
export const MAX_HEAD_LENGTH = 40
/** Only this much of a command is looked at, so a huge heredoc costs nothing. */
export const SCAN_CHARS = 4000
const MAX_WORDS = 64
const MAX_DEPTH = 3

const HEAD_RE = /^[A-Za-z0-9._+][A-Za-z0-9._+-]{0,39}$/
export const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/
export const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
/** A variable, a command substitution, a subshell or a glob in a word: not a program name. */
const NOT_A_NAME_RE = /[$`(){}<>*?!]/

/** Words that run the next command: skipped, with the options that take a value. */
export const WRAPPERS = new Map<string, readonly string[]>([
  ['sudo', ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-D', '-R']],
  ['doas', ['-u', '-C']],
  ['env', ['-u', '-C', '-S']],
  ['time', ['-f', '-o']],
  ['nohup', []],
  ['nice', ['-n']],
  ['command', []],
  ['builtin', []],
  ['exec', ['-a']],
])

/** Words that prepare the shell; skipped only when `&&`, `||` or `;` leads on to the real command. */
const PREPARE = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'source', '.', 'set', 'umask', 'ulimit', 'alias', 'unalias'])

export interface Word {
  text: string
  /** An unquoted `&&`, `||`, `;`, `|` or `&`. */
  op: boolean
  /** Offsets of the word in the line it was split from (`line.slice(start, end)` is the word as typed, quotes included). */
  start: number
  end: number
}

/** Split a command line into words and operators; quotes group, a backslash escapes. Not a shell parser. */
export function words(line: string): Word[] {
  const out: Word[] = []
  let cur = ''
  let has = false
  let start = 0
  let quote: '"' | "'" | null = null
  const push = (end: number) => {
    if (has) out.push({ text: cur, op: false, start, end })
    cur = ''
    has = false
  }
  const begin = (i: number) => {
    if (!has) start = i
    has = true
  }
  for (let i = 0; i < line.length && out.length < MAX_WORDS; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i]
      else cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; begin(i); continue }
    if (c === '\\' && i + 1 < line.length) { begin(i); cur += line[++i]; continue }
    if (c === ' ' || c === '\t') { push(i); continue }
    if (c === ';' || c === '|' || c === '&') {
      push(i)
      const two = line.slice(i, i + 2)
      if (two === '&&' || two === '||') { out.push({ text: two, op: true, start: i, end: i + 2 }); i++ } else out.push({ text: c, op: true, start: i, end: i + 1 })
      continue
    }
    begin(i)
    cur += c
  }
  push(line.length)
  return out
}

/** `/usr/bin/git` -> `git`; a word that is no plain program name -> null. */
function programName(word: string): string | null {
  if (NOT_A_NAME_RE.test(word)) return null
  const base = word.replace(/^.*\//, '')
  if (!HEAD_RE.test(base) || !/[A-Za-z0-9]/.test(base)) return null
  // A secret in the first word (a token typed as a command) must not become a label.
  if (maskSecrets(base) !== base) return null
  return base
}

function headOfLine(line: string, depth: number): string | null {
  const ws = words(line)
  let i = 0
  while (i < ws.length) {
    const w = ws[i]
    if (w.op) { i++; continue }
    const t = w.text
    if (ASSIGN_RE.test(t)) { i++; continue }
    const wrapper = WRAPPERS.get(t)
    if (wrapper) {
      i++
      while (i < ws.length && !ws[i].op && ws[i].text.startsWith('-')) {
        i += wrapper.includes(ws[i].text) ? 2 : 1
      }
      continue
    }
    if (PREPARE.has(t)) {
      // Skip to the operator that leads on to the real command; without one the word itself is the command.
      let j = i + 1
      while (j < ws.length && !(ws[j].op && (ws[j].text === '&&' || ws[j].text === '||' || ws[j].text === ';'))) j++
      if (j < ws.length - 1) { i = j + 1; continue }
      return programName(t)
    }
    if (SHELLS.has(t)) {
      const next = ws[i + 1]
      const inner = ws[i + 2]
      if (next && !next.op && /^-[a-z]*c[a-z]*$/.test(next.text) && inner && !inner.op && depth < MAX_DEPTH) {
        const found = headOfText(inner.text, depth + 1)
        if (found !== null) return found
      }
      return programName(t)
    }
    return programName(t)
  }
  return null
}

function headOfText(text: string, depth: number): string | null {
  for (const raw of text.slice(0, SCAN_CHARS).split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    // First real line has no usable head (a quote, a subshell): do not guess from later lines.
    return headOfLine(line, depth)
  }
  return null
}

/** The command text of a Bash `tool_call_start` payload: the full command when there is one, else the args. */
export function bashCommandOf(payload: Record<string, unknown>): string | null {
  const input = payload.inputData
  const fromInput = input && typeof input === 'object' && !Array.isArray(input) && typeof (input as Record<string, unknown>).command === 'string'
    ? ((input as Record<string, unknown>).command as string)
    : null
  const text = fromInput !== null && fromInput.trim() !== '' ? fromInput : typeof payload.args === 'string' ? payload.args : null
  return text !== null && text.trim() !== '' ? text : null
}

/**
 * The length at which the Claude hook path cuts a Bash command (`ARGS_MAX` in extension/src/constants.ts; the extension is
 * not importable from the web app, so it is copied here). The transcript path and Hermes deliver the full command.
 */
export const HOOK_ARGS_MAX = 80

/**
 * True when the command text of this payload may be the cut hook text: there is no full command (`inputData.command`) and the
 * `args` text is as long as the hook cut leaves it. Such a text can end in the middle of a word (`request-review` as
 * `request_re`, a `--board` not yet seen), so nothing may be decided on its last word, and the full delivery of the same
 * call replaces whatever it produced.
 */
export function bashCommandCut(payload: Record<string, unknown>): boolean {
  const input = payload.inputData
  const command = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).command : undefined
  if (typeof command === 'string' && command.trim() !== '') return false
  return typeof payload.args === 'string' && payload.args.length >= HOOK_ARGS_MAX
}

/** The program a shell command runs, or `command` when there is no plain program name to show. */
export function commandHead(command: string): string {
  if (typeof command !== 'string') return FALLBACK_HEAD
  return headOfText(command, 0) ?? FALLBACK_HEAD
}
