/**
 * P2-A5 reconcile helper (read-only): prices every `provider=copilot` Hermes agent.log API line at the
 * built-in Copilot sheet and prints per-day list-equivalent USD next to the daily billing CSV.
 *
 *   cd <worktree> && node --import tsx docs/spikes/p2-copilot-reconcile.ts [csv] [hermes-root]
 *
 * Output is aggregate only (day, calls, tokens, USD): no session ids, no message text, no response ids.
 * The comparison is QUALITATIVE: the CSV holds GitHub's day totals for the whole account, the logs only
 * Hermes-routed calls, and the two use different day boundaries (log lines are host-local time).
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { parseHermesLogLine } from '../../scripts/hermes-logs'
import { defaultConfig } from '../../web/lib/costs/validate'
import { priceUsage } from '../../web/lib/costs/price'

const csvFile = process.argv[2] ?? '/home/idv/workspace/copilot_costs_daily_2026-11-06.csv'
const root = process.argv[3] ?? path.join(os.homedir(), '.hermes')

function logFiles(): string[] {
  const dirs = [path.join(root, 'logs')]
  const profiles = path.join(root, 'profiles')
  if (fs.existsSync(profiles)) for (const p of fs.readdirSync(profiles)) dirs.push(path.join(profiles, p, 'logs'))
  const out: string[] = []
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    for (const f of fs.readdirSync(d)) if (/^agent\.log(\.\d+)?$/.test(f)) out.push(path.join(d, f))
  }
  return out
}

interface Day { calls: number; unpriced: number; inferred: number; usd: number; inTok: number; outTok: number; models: Map<string, number> }
const days = new Map<string, Day>()
const cfg = defaultConfig()

for (const file of logFiles()) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('provider=copilot')) continue
    const parsed = parseHermesLogLine(line)
    if (!parsed || parsed.event.kind !== 'api' || parsed.event.provider !== 'copilot') continue
    const ev = parsed.event
    const day = line.slice(0, 10)
    const at = `${day}T${line.slice(11, 19)}`
    const newInput = Math.max(0, ev.inputTokens - ev.cacheReadTokens - ev.cacheWriteTokens)
    const r = priceUsage(cfg, {
      provider: 'copilot', model: ev.model, at,
      promptTokens: Math.max(ev.inputTokens, ev.cacheReadTokens + ev.cacheWriteTokens),
      usage: { inputTokens: newInput, outputTokens: ev.outputTokens, cacheReadTokens: ev.cacheReadTokens, cacheWrite5mTokens: ev.cacheWriteTokens, cacheWrite1hTokens: 0 },
    })
    const d = days.get(day) ?? { calls: 0, unpriced: 0, inferred: 0, usd: 0, inTok: 0, outTok: 0, models: new Map() }
    d.calls++
    d.inTok += ev.inputTokens
    d.outTok += ev.outputTokens
    if (r.kind === 'unpriced') d.unpriced++
    if (r.inferredCacheWriteTokens > 0) d.inferred++
    d.usd += r.amount
    d.models.set(ev.model, (d.models.get(ev.model) ?? 0) + 1)
    days.set(day, d)
  }
}

const csv = new Map<string, { official: number; ledger: number; calls: number }>()
if (fs.existsSync(csvFile)) {
  for (const row of fs.readFileSync(csvFile, 'utf8').trim().split('\n').slice(1)) {
    const [day, official, ledger, , calls] = row.split(',')
    csv.set(day, { official: Number(official), ledger: Number(ledger), calls: Number(calls) })
  }
}

console.log('day        | log calls | unpriced | inferred-write | list-equiv USD | CSV official | CSV hermes_ledger | CSV calls')
console.log('-----------|-----------|----------|----------------|----------------|--------------|-------------------|----------')
for (const day of [...days.keys()].sort()) {
  const d = days.get(day)!
  const c = csv.get(day)
  console.log([
    day, String(d.calls).padStart(9), String(d.unpriced).padStart(8), String(d.inferred).padStart(14), d.usd.toFixed(2).padStart(14),
    c ? c.official.toFixed(2).padStart(12) : '           -', c ? c.ledger.toFixed(2).padStart(17) : '                -', c ? String(c.calls).padStart(9) : '        -',
  ].join(' | '))
}
