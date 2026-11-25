#!/usr/bin/env node
// S1 spike helper: print the merged KEY TREE (path: type, never values) of JSON or JSONL files.
// Usage: node keytree.js <file> [<file> ...]
// Arrays are shown as path[] and their elements are merged. Values are never printed, so the
// output is safe to paste (it still names keys; review before posting).
'use strict';
const fs = require('fs');

const seen = new Map();
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
function walk(v, p) {
  const t = typeOf(v);
  if (p) {
    const set = seen.get(p) || new Set();
    set.add(t);
    seen.set(p, set);
  }
  if (t === 'array') v.forEach((e) => walk(e, `${p}[]`));
  else if (t === 'object') for (const k of Object.keys(v)) walk(v[k], p ? `${p}.${k}` : k);
}

for (const file of process.argv.slice(2)) {
  const text = fs.readFileSync(file, 'utf8');
  const docs = file.endsWith('.jsonl') ? text.split('\n').filter((l) => l.trim().startsWith('{')) : [text];
  for (const d of docs) {
    try { walk(JSON.parse(d), ''); } catch (e) { console.error(`skip ${file}: not JSON`); }
  }
}
for (const [p, types] of [...seen.entries()].sort()) console.log(`${p}: ${[...types].sort().join('|')}`);
