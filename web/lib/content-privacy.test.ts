import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  DEFAULT_ANONYMIZE,
  anonymizeMessage,
  anonymizeResult,
  anonymizeTaskTitle,
  anonymizeToolInput,
  commandName,
  createAnonymizePolicy,
  describePolicy,
  isAnonymized,
  parseOverrides,
  warnUnknownProfiles,
} from './content-privacy'

function policy(value?: string, overrides?: Record<string, boolean>) {
  const warnings: string[] = []
  return { p: createAnonymizePolicy({ value, overrides, warn: m => warnings.push(m) }), warnings }
}

test('the default is full content for every profile (one constant flips it)', () => {
  assert.equal(DEFAULT_ANONYMIZE, 'none')
  for (const v of [undefined, '', '  ']) {
    const { p } = policy(v)
    assert.equal(isAnonymized(p, 'hestia'), false)
    assert.equal(isAnonymized(p, 'default'), false)
  }
})

test('all anonymizes every profile, none anonymizes none', () => {
  const all = policy('all').p
  const none = policy('none').p
  for (const name of ['hestia', 'sophia', 'default', 'omh-coder']) {
    assert.equal(isAnonymized(all, name), true)
    assert.equal(isAnonymized(none, name), false)
  }
  assert.equal(isAnonymized(policy(' ALL ').p, 'x'), true, 'case and spaces are ignored')
})

test('a list anonymizes only the listed profiles; the rest follow the default', () => {
  const { p, warnings } = policy('hestia, Sophia')
  assert.equal(isAnonymized(p, 'hestia'), true)
  assert.equal(isAnonymized(p, 'sophia'), true)
  assert.equal(isAnonymized(p, 'taxis'), false, 'not listed: follows the default (full content)')
  assert.deepEqual(warnings, [])
})

test('an unknown profile name falls back to the default, logs a warning and does not crash', () => {
  const { p } = policy('hestia,ghost')
  const warnings: string[] = []
  const unknown = warnUnknownProfiles(p, ['hestia', 'taxis', 'default'], m => warnings.push(m))
  assert.deepEqual(unknown, ['ghost'])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unknown Hermes profile "ghost"/)
  assert.match(warnings[0], /full content/)
  // Looking up a profile that does not exist is fine and follows the default.
  assert.equal(isAnonymized(p, 'ghost-2'), false)
  assert.equal(isAnonymized(p, ''), false)
  assert.equal(isAnonymized(p, 'hestia'), true)
  // Known names produce no warning.
  assert.deepEqual(warnUnknownProfiles(policy('hestia').p, ['hestia'], m => warnings.push(m)), [])
  assert.equal(warnings.length, 1)
})

test('mixed or odd values are handled without throwing', () => {
  const a = policy('all,hestia')
  assert.equal(isAnonymized(a.p, 'taxis'), true)
  assert.equal(a.warnings.length, 1)
  const b = policy('none,hestia')
  assert.equal(isAnonymized(b.p, 'hestia'), true)
  assert.equal(isAnonymized(b.p, 'taxis'), false)
  assert.equal(b.warnings.length, 1)
  assert.doesNotThrow(() => policy(',,,'))
  assert.equal(isAnonymized(policy(',,,').p, 'x'), false)
})

test('per-profile overrides win over the global setting', () => {
  const none = policy('none', { hestia: true }).p
  assert.equal(isAnonymized(none, 'hestia'), true)
  assert.equal(isAnonymized(none, 'sophia'), false)
  const all = policy('all', { Sophia: false }).p
  assert.equal(isAnonymized(all, 'sophia'), false)
  assert.equal(isAnonymized(all, 'hestia'), true)
  assert.match(describePolicy(all), /overrides: sophia=off/)
  // Unknown override names are reported too.
  const warnings: string[] = []
  assert.deepEqual(warnUnknownProfiles(all, ['hestia'], m => warnings.push(m)), ['sophia'])
})

test('overrides parse from name=on,name=off and bad entries are skipped with a warning', () => {
  const warnings: string[] = []
  assert.deepEqual(parseOverrides('hestia=on, sophia=off,bad,x=maybe', m => warnings.push(m)), { hestia: true, sophia: false })
  assert.equal(warnings.length, 2)
  assert.deepEqual(parseOverrides(undefined), {})
})

test('structure-only views carry names, paths and sizes but none of the text', () => {
  const secret = 'rm -rf /home/idv/very-secret-project --token=abc123'
  const bash = anonymizeToolInput('terminal', { command: secret })
  assert.equal(bash.args, `rm · ${secret.length} chars`)
  assert.deepEqual(bash.inputData, { command: bash.args })
  assert.ok(!JSON.stringify(bash).includes('very-secret'))

  const edit = anonymizeToolInput('patch', { path: '/repo/a.ts', old_string: 'a\nb', new_string: 'a\nb\nc\nd' })
  assert.deepEqual(edit.inputData, { file_path: '/repo/a.ts', old_string: '(2 lines removed)', new_string: '(4 lines added)' })

  const write = anonymizeToolInput('write_file', { path: '/repo/b.ts', content: 'x\ny\nz' })
  assert.deepEqual(write.inputData, { file_path: '/repo/b.ts', content: '(3 lines, 5 chars)' })

  const unknown = anonymizeToolInput('kanban_comment', { task_id: 't_1', body: 'secret body', n: 3 })
  assert.deepEqual(unknown.inputData, { task_id: '(3 chars)', body: '(11 chars)', n: 3 })
  assert.ok(!JSON.stringify(unknown).includes('secret body'))

  assert.equal(anonymizeResult('line1\nline2'), '(2 lines, 11 chars)')
  assert.equal(anonymizeMessage('user', 120, { user: 'Webbugt', platform: 'matrix' }), 'user message from Webbugt via matrix · 120 chars')
  assert.equal(anonymizeMessage('assistant', 1), 'assistant message · 1 char')
  assert.equal(anonymizeTaskTitle('t_1', 'Hidden title'), 't_1 (title hidden, 12 chars)')
})

test('commandName skips env assignments and paths, and never returns odd text', () => {
  assert.equal(commandName('FOO=bar /usr/bin/git status'), 'git')
  assert.equal(commandName('  pnpm test'), 'pnpm')
  assert.equal(commandName('$(curl evil)'), 'command')
  assert.equal(commandName(''), 'command')
})
