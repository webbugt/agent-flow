/**
 * End to end for the C4 masker gaps: the inspection of a bash block shows the full command, masked; the block itself
 * carries only the head. Fake fixtures only.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MASK } from './secret-mask'
import { BashUseTracker, type BashEventLike } from './bash-blocks'
import { inspectResource } from './fleet-inspect'

const T0 = Date.UTC(2026, 10, 27, 12, 0, 0)
const session = { id: 'hermes-taxis', label: 'Taxis' }
const bashEvent = (command: string, agoSec: number, args = command.slice(0, 80)): BashEventLike => ({
  time: 0,
  type: 'tool_call_start',
  payload: { agent: 'Taxis · Plan', tool: 'Bash', args, ...(command ? { inputData: { command } } : {}), at: T0 - agoSec * 1000 },
})

test('inspection of a bash block masks docker/sshpass/redis forms; the block holds only the head', () => {
  const cases: Array<[head: string, command: string]> = [
    ['sshpass', 'sshpass -p FAKE_123 ssh bob@host.example.com uptime'],
    ['docker', 'docker login -u bob -p FAKE_123 registry.example.com'],
    ['redis-cli', 'redis-cli -h cache.example.com -a FAKE_123 ping'],
  ]
  const nodes = new BashUseTracker().update([session], () => cases.map(([, c], i) => bashEvent(c, 10 + i)), T0)
  for (const [head, command] of cases) {
    const node = nodes.find(n => n.head === head)
    assert.ok(node, `a block for ${head}`)
    assert.ok(!JSON.stringify(node).includes('FAKE_123'), `${head}: node must not hold the secret`)
    const insp = inspectResource(`bash:${head}`, undefined, undefined, undefined, nodes)!
    assert.ok(!JSON.stringify(insp).includes('FAKE_123'), `${head}: inspection must not hold the secret`)
    const detail = insp.items[0].detail!
    assert.ok(detail.includes(MASK), `${head}: masked marker shown`)
    assert.ok(detail.startsWith(command.split(' FAKE_123')[0]), `${head}: the rest of the command is still shown`)
  }
})

test('inspection masks a token cut off by the 80 character args form (no full command in the payload)', () => {
  const full = `curl -sS https://api.example.com/v1/items/list -H "X-Api-Version: 3" -H "X-Token: ghp_FAKE12345678"`
  const args = full.slice(0, full.indexOf('ghp_') + 9)
  assert.ok(args.endsWith('ghp_FAKE1'), 'fixture ends in a cut prefix')
  const nodes = new BashUseTracker().update([session], () => [bashEvent('', 5, args)], T0)
  const insp = inspectResource('bash:curl', undefined, undefined, undefined, nodes)!
  assert.ok(!JSON.stringify(insp).includes('ghp_'), 'the cut prefix is gone from the inspection')
  assert.ok(insp.items[0].detail!.endsWith(MASK))
})

test('an env-prefixed command keeps its secret out of the node and the inspection', () => {
  const nodes = new BashUseTracker().update([session], () => [bashEvent('MYSQL_ROOT_PASSWORD=FAKE_123 docker compose up -d', 5)], T0)
  assert.ok(nodes.length >= 1)
  assert.ok(!JSON.stringify(nodes).includes('FAKE_123'))
  const insp = inspectResource(`bash:${nodes[0].head}`, undefined, undefined, undefined, nodes)!
  assert.ok(!JSON.stringify(insp).includes('FAKE_123'))
  assert.match(insp.items[0].detail!, /MYSQL_ROOT_PASSWORD=\[MASKED\] docker compose up -d/)
})

test('inspection masks -p / -a behind a double space and a backslash line continuation', () => {
  const cases: Array<[head: string, command: string]> = [
    ['docker', 'docker login -u bob \\\n  -p FAKE_123 registry.example.com'],
    ['sshpass', 'sshpass  -p FAKE_123 ssh -p 2222 bob@host.example.com uptime'],
    ['redis-cli', 'redis-cli -h cache.example.com  -a FAKE_123 ping'],
  ]
  const nodes = new BashUseTracker().update([session], () => cases.map(([, c], i) => bashEvent(c, 10 + i, c)), T0)
  for (const [head, command] of cases) {
    const node = nodes.find(n => n.head === head)
    assert.ok(node, `a block for ${head}`)
    assert.ok(!JSON.stringify(node).includes('FAKE_123'), `${head}: node must not hold the secret`)
    const insp = inspectResource(`bash:${head}`, undefined, undefined, undefined, nodes)!
    assert.ok(!JSON.stringify(insp).includes('FAKE_123'), `${head}: inspection must not hold the secret`)
    const detail = insp.items[0].detail!
    assert.ok(detail.includes(MASK), `${head}: masked marker shown`)
    assert.equal(detail, command.replace('FAKE_123', MASK), `${head}: only the secret changed`)
  }
})

test('inspection masks the value behind a backslash continuation after -p / -a / --password', () => {
  const cases: Array<[head: string, command: string]> = [
    ['docker', 'docker login -u bob -p \\\n  FAKE_123 registry.example.com'],
    ['sshpass', 'sshpass -p \\\n  \\\n  FAKE_123 ssh -p 2222 bob@host.example.com uptime'],
    ['redis-cli', 'redis-cli -h cache.example.com -a \\\n  FAKE_123 ping'],
    ['mytool', 'mytool run --password \\\n  FAKE_123 --verbose'],
  ]
  const nodes = new BashUseTracker().update([session], () => cases.map(([, c], i) => bashEvent(c, 10 + i, c)), T0)
  for (const [head, command] of cases) {
    const node = nodes.find(n => n.head === head)
    assert.ok(node, `a block for ${head}`)
    assert.ok(!JSON.stringify(node).includes('FAKE_123'), `${head}: node must not hold the secret`)
    const insp = inspectResource(`bash:${head}`, undefined, undefined, undefined, nodes)!
    assert.ok(!JSON.stringify(insp).includes('FAKE_123'), `${head}: inspection must not hold the secret`)
    const detail = insp.items[0].detail!
    assert.equal(detail, command.replace('FAKE_123', MASK), `${head}: only the secret changed`)
  }
})
