#!/usr/bin/env node
/**
 * vscode:uninstall script — runs when the extension is uninstalled.
 * Removes Agent Flow hooks from ALL known Claude Code settings files,
 * then deletes the entire ~/.claude/agent-flow/ directory.
 *
 * Sources for workspace discovery (checked in order, deduplicated):
 * 1. workspaces.json manifest — persists across crashes/restarts
 * 2. Discovery files ({hash}-{pid}.json) — fallback for older versions
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOOK_COMMAND_MARKER = 'agent-flow/hook.js';
// Legacy Agent Flow HTTP hooks used the bare hook server origin. Other tools'
// loopback hooks (with a path) must be left alone. Mirrors src/hook-entries.ts.
const LEGACY_HOOK_URL_RE = /^http:\/\/127\.0\.0\.1:\d+\/?$/;
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow');
const MANIFEST_PATH = path.join(DISCOVERY_DIR, 'workspaces.json');
// Chained statusLine wrapper (src/statusline-installer.ts). The wrapper script lives in DISCOVERY_DIR, which is
// deleted below, so the user's own statusLine must be put back first or Claude Code would call a missing file.
const STATUSLINE_MARKER = 'agent-flow/statusline-shim.js';
const AF_HOME = path.join(os.homedir(), '.agent-flow');
const STATUSLINE_RECORD = path.join(AF_HOME, 'statusline-original.json');
const LIMITS_FILE = path.join(AF_HOME, 'limits', 'claude.json');
const LIMITS_HISTORY_FILE = path.join(AF_HOME, 'limits', 'claude-history.json');

// A settings.json that is a symlink (stow, chezmoi, home-manager) is written THROUGH: tmp + rename next to the real
// target, so the link stays a link. A link that cannot be followed is left alone (null).
function writeTarget(file) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) { return fs.realpathSync(file); }
  } catch { return null; }
  return file;
}

function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function deepEqual(a, b) {
  if (a === b) { return true; }
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') { return false; }
  if (Array.isArray(a) !== Array.isArray(b)) { return false; }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
}

// ─── Restore the user's statusLine ──────────────────────────────────────────

function restoreStatusLine(linkPath) {
  try {
    const settingsPath = writeTarget(linkPath);
    if (!settingsPath || !fs.existsSync(settingsPath)) { return; }
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    if (!isPlainObject(settings)) { return; }
    const sl = settings.statusLine;
    if (!isPlainObject(sl) || typeof sl.command !== 'string' || !sl.command.replace(/\\/g, '/').includes(STATUSLINE_MARKER)) { return; }

    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(STATUSLINE_RECORD, 'utf-8')); } catch { /* no record */ }
    const recOk = isPlainObject(rec) && rec.v === 1 && typeof rec.hadStatusLine === 'boolean';
    if (recOk && rec.hadStatusLine && isPlainObject(rec.original) && deepEqual(sl, rec.installed)) {
      settings.statusLine = rec.original; // exact restore, the key keeps its position
    } else if (recOk && rec.hadStatusLine && isPlainObject(rec.original) && typeof rec.original.command === 'string') {
      settings.statusLine = { ...sl, command: rec.original.command }; // edited since: keep the edits, drop only our wrapper
    } else {
      delete settings.statusLine; // there was none, or the original is unknown: a call to a deleted script would only error
    }

    if (Object.keys(settings).length === 0 && recOk && rec.createdSettings === true && settingsPath === linkPath) {
      fs.unlinkSync(settingsPath);
      return;
    }
    const m = /^[ \t]+(?=")/m.exec(raw);
    const tmpPath = `${settingsPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(settings, null, m ? m[0] : 2) + (raw.endsWith('\n') || raw === '' ? '\n' : ''), { mode: fs.statSync(settingsPath).mode & 0o777 });
    fs.renameSync(tmpPath, settingsPath);
  } catch { /* best effort */ }
}

function removeStatusLineFiles() {
  for (const f of [STATUSLINE_RECORD, LIMITS_FILE, LIMITS_HISTORY_FILE]) { try { fs.unlinkSync(f); } catch { /* not there */ } }
  try { fs.rmdirSync(path.dirname(LIMITS_FILE)); } catch { /* not empty or not there */ }
  try { fs.unlinkSync(path.join(os.homedir(), '.claude', 'settings.json.agent-flow.bak')); } catch { /* not there */ }
}

// ─── Remove hooks from a settings file ─────────────────────────────────────

function removeHooksFromFile(linkPath) {
  try {
    const settingsPath = writeTarget(linkPath);
    if (!settingsPath || !fs.existsSync(settingsPath)) { return; }
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const hooks = settings.hooks;
    if (!hooks || typeof hooks !== 'object') { return; }

    let changed = false;
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) { continue; }
      const filtered = entries.filter(entry => {
        return !entry.hooks?.some(h =>
          h.command?.replace(/\\/g, '/').includes(HOOK_COMMAND_MARKER) ||
          (typeof h.url === 'string' && LEGACY_HOOK_URL_RE.test(h.url)),
        );
      });
      if (filtered.length !== entries.length) {
        changed = true;
        if (filtered.length === 0) {
          delete hooks[event];
        } else {
          hooks[event] = filtered;
        }
      }
    }

    if (!changed) { return; }

    if (Object.keys(hooks).length === 0) { delete settings.hooks; }

    if (Object.keys(settings).length === 0 && settingsPath === linkPath) {
      fs.unlinkSync(settingsPath);
    } else {
      const tmpPath = `${settingsPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n', { mode: fs.statSync(settingsPath).mode & 0o777 });
      fs.renameSync(tmpPath, settingsPath);
    }
  } catch { /* best effort */ }
}

// ─── Collect all known workspace paths ──────────────────────────────────────

function collectWorkspaces() {
  const workspaces = new Set();

  // Source 1: workspaces.json manifest
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      const data = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
      if (Array.isArray(data)) {
        for (const w of data) { workspaces.add(w); }
      }
    }
  } catch { /* skip */ }

  // Source 2: discovery files (fallback — covers versions before the manifest existed)
  try {
    if (fs.existsSync(DISCOVERY_DIR)) {
      const files = fs.readdirSync(DISCOVERY_DIR).filter(f => f.endsWith('.json') && f !== 'workspaces.json');
      for (const file of files) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(DISCOVERY_DIR, file), 'utf-8'));
          if (d.workspace) { workspaces.add(d.workspace); }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return workspaces;
}

// ─── Main ───────────────────────────────────────────────────────────────────

// 0. Put the user's own statusLine back (the wrapper script is deleted in step 3)
restoreStatusLine(path.join(os.homedir(), '.claude', 'settings.json'));
removeStatusLineFiles();

// 1. Global settings
removeHooksFromFile(path.join(os.homedir(), '.claude', 'settings.json'));

// 2. All known project-level settings
for (const workspace of collectWorkspaces()) {
  removeHooksFromFile(path.join(workspace, '.claude', 'settings.local.json'));
}

// 3. Delete entire agent-flow directory (manifest, discovery files, hook script)
try { fs.rmSync(DISCOVERY_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
