#!/usr/bin/env node
// S1 spike helper: statusLine command that records the raw stdin JSON Claude Code sends.
// Writes ../out/statusline-<epoch-ms>.json (mode 0600) next to this script and prints "cap".
// Never touches ~/.claude. Payloads may hold session_id/transcript_path: redact before sharing.
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'out');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, `statusline-${Date.now()}.json`), input, { mode: 0o600 });
  } catch { /* capture must never break the status line */ }
  process.stdout.write('cap');
});
