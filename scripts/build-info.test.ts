import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'

const { resolveBuildInfo } = createRequire(__filename)('./build-info.js') as {
  resolveBuildInfo: (opts?: {
    env?: Record<string, string | undefined>
    cwd?: string
    git?: (args: string[], cwd: string) => string
  }) => { branch: string; commit: string }
}

const COMMIT = '0568094abcdef0123456789abcdef0123456789a'
const fakeGit = (args: string[]) => {
  if (args.join(' ') === 'rev-parse --abbrev-ref HEAD') return 'feature/fleet-polish\n'
  if (args.join(' ') === 'rev-parse HEAD') return COMMIT + '\n'
  throw new Error('unexpected git call: ' + args.join(' '))
}

test('reads branch and commit from git', () => {
  assert.deepEqual(resolveBuildInfo({ env: {}, git: fakeGit }), { branch: 'feature/fleet-polish', commit: COMMIT })
})

test('environment override wins, per field', () => {
  const env = { AGENT_FLOW_BUILD_BRANCH: 'release/x' }
  assert.deepEqual(resolveBuildInfo({ env, git: fakeGit }), { branch: 'release/x', commit: COMMIT })
  const both = { AGENT_FLOW_BUILD_BRANCH: 'b', AGENT_FLOW_BUILD_COMMIT: 'c0ffee' }
  assert.deepEqual(resolveBuildInfo({ env: both, git: () => { throw new Error('git must not run') } }), { branch: 'b', commit: 'c0ffee' })
})

test('falls back to "unknown" when git fails or the override is blank', () => {
  const failing = () => { throw new Error('not a git repository') }
  assert.deepEqual(resolveBuildInfo({ env: {}, git: failing }), { branch: 'unknown', commit: 'unknown' })
  assert.deepEqual(
    resolveBuildInfo({ env: { AGENT_FLOW_BUILD_BRANCH: '  ', AGENT_FLOW_BUILD_COMMIT: '' }, git: failing }),
    { branch: 'unknown', commit: 'unknown' },
  )
})

test('strips control characters and caps the length', () => {
  const r = resolveBuildInfo({ env: { AGENT_FLOW_BUILD_BRANCH: 'a\r\nb\u0000c', AGENT_FLOW_BUILD_COMMIT: 'x'.repeat(500) }, git: fakeGit })
  assert.equal(r.branch, 'abc')
  assert.equal(r.commit.length, 200)
})

test('the real repository resolves to a branch and a 40-hex commit', () => {
  const r = resolveBuildInfo({ env: {} })
  assert.match(r.commit, /^[0-9a-f]{40}$/)
  assert.notEqual(r.branch, 'unknown')
})
