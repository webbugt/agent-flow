/**
 * The Claude Code statusLine shim (PLAN v2 section 8, task P6a).
 *
 * Claude Code runs the user's `statusLine` command for every refresh and writes a JSON document to its stdin
 * (S1: docs/spikes/S1-claude-limits.md: `rate_limits.five_hour` / `seven_day` appear from the second call on,
 * TUI only). Hooks do not carry `rate_limits`, so this wrapper is the only documented way to observe them.
 *
 * The installed script (`~/.claude/agent-flow/statusline-shim.js`) does exactly two things:
 *  1. TEE: copy only `rate_limits` windows, `session_id`, `model.id` and a timestamp to
 *     `~/.agent-flow/limits/claude.json` (mode 0600, atomic). Nothing else from the payload is kept: no prompt,
 *     transcript path, cwd, cost or credentials. Anything unexpected is dropped, not stored.
 *  2. CHAIN: run the user's original status line command (kept verbatim in `~/.agent-flow/statusline-original.json`)
 *     with the same stdin, environment and working directory; its stdout and stderr are inherited (so they reach
 *     Claude Code byte for byte) and the shim exits with its exit code.
 *
 * Every failure on the tee path is swallowed: the user's status line must never break because of Agent Flow.
 * The script is plain CommonJS with only `fs`, `path`, `os` (and `child_process` when there is something to chain),
 * so it starts as fast as a bare `node` and works without the extension running.
 *
 * This module only holds constants and the script text; installing it is statusline-installer.ts.
 */

/** Substring that identifies our wrapper inside `settings.json` (like HOOK_COMMAND_MARKER for the hooks). */
export const STATUSLINE_SHIM_MARKER = 'agent-flow/statusline-shim.js'

/** File format of `~/.agent-flow/limits/claude.json`. */
export const LIMITS_FILE_VERSION = 1

/** The only keys the limits file may contain at the top level (a test asserts this set). */
export const LIMITS_FILE_KEYS = ['v', 'at', 'session_id', 'model', 'rate_limits'] as const

/** Script text of `statusline-shim.js`. */
export function getShimScriptContent(): string {
  return `#!/usr/bin/env node
// Agent Flow statusLine shim v1 — installed by the Agent Flow VS Code extension (command "Configure Claude statusLine").
// Tees Claude Code's rate limits (5-hour, weekly) to ~/.agent-flow/limits/claude.json, then runs your original
// status line command unchanged. Remove it with "Remove Claude statusLine wrapper"; that restores your settings.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const AF = path.join(os.homedir(), '.agent-flow');
const LIMITS_DIR = path.join(AF, 'limits');
const LIMITS_FILE = path.join(LIMITS_DIR, 'claude.json');
const ORIGINAL_FILE = path.join(AF, 'statusline-original.json');

const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('error', () => {});
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks);
  try { tee(raw); } catch (e) { /* never break the status line */ }
  chain(raw);
});

function num(v) { return typeof v === 'number' && isFinite(v) ? v : undefined; }

// Whitelist: window names are short snake_case keys, values are numbers only.
function windows(rl) {
  const out = {};
  if (!rl || typeof rl !== 'object' || Array.isArray(rl)) return out;
  for (const key of Object.keys(rl)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue;
    const w = rl[key];
    if (!w || typeof w !== 'object' || Array.isArray(w)) continue;
    const entry = {};
    const used = num(w.used_percentage);
    const resets = num(w.resets_at);
    if (used !== undefined) entry.used_percentage = used;
    if (resets !== undefined) entry.resets_at = resets;
    if (Object.keys(entry).length > 0) out[key] = entry;
  }
  return out;
}

function tee(raw) {
  const data = JSON.parse(raw.toString('utf8'));
  if (!data || typeof data !== 'object') return;
  const rl = windows(data.rate_limits);
  // No rate_limits (the first call of a session has none): keep the last observation instead of overwriting it.
  if (Object.keys(rl).length === 0) return;
  const rec = { v: ${LIMITS_FILE_VERSION}, at: Date.now() };
  if (typeof data.session_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(data.session_id)) rec.session_id = data.session_id;
  const mid = data.model && typeof data.model === 'object' ? data.model.id : undefined;
  if (typeof mid === 'string' && /^[A-Za-z0-9._:\\/-]{1,128}$/.test(mid)) rec.model = { id: mid };
  rec.rate_limits = rl;
  fs.mkdirSync(LIMITS_DIR, { recursive: true, mode: 0o700 });
  const tmp = LIMITS_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(rec) + '\\n', { mode: 0o600, flag: 'w' });
  try { fs.chmodSync(tmp, 0o600); } catch (e) {}
  fs.renameSync(tmp, LIMITS_FILE);
}

function chain(raw) {
  let command;
  try {
    const rec = JSON.parse(fs.readFileSync(ORIGINAL_FILE, 'utf8'));
    if (rec && rec.hadStatusLine === true && rec.original && rec.original.type === 'command' && typeof rec.original.command === 'string') {
      command = rec.original.command;
    }
  } catch (e) { /* no record: nothing to chain */ }
  if (!command || command.trim() === '') process.exit(0);
  const child = require('child_process').spawn(command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
  child.on('error', () => process.exit(0));
  child.stdin.on('error', () => {});
  child.stdin.end(raw);
  child.on('close', (code, signal) => {
    if (typeof code === 'number') process.exit(code);
    const n = signal && os.constants.signals[signal];
    process.exit(n ? 128 + n : 1);
  });
}
`
}
