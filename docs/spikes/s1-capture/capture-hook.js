#!/usr/bin/env node
// S1 spike helper: command hook that records the raw stdin JSON Claude Code sends.
// Writes ../out/hook-<hook_event_name>-<epoch-ms>.json (mode 0600); no stdout, exit 0.
// Never touches ~/.claude. Payloads may hold session_id/transcript_path: redact before sharing.
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let name = 'unknown';
  try {
    const ev = JSON.parse(input).hook_event_name;
    if (typeof ev === 'string' && /^[A-Za-z]+$/.test(ev)) name = ev;
  } catch { /* keep "unknown" */ }
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `hook-${name}-${Date.now()}.json`), input, { mode: 0o600 });
  } catch { /* swallow */ }
  process.exit(0);
});
