/**
 * The costs example in the README ("## Configurable costs") must be the same document as docs/examples/costs.example.json,
 * and that document must pass the authoritative validator with no errors and no warnings. A doc example that the
 * validator rejects (or that drifts from its copy) is a worse bug than no example.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { validateConfigText } from './validate'

const root = path.resolve(__dirname, '..', '..', '..')
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8')
const exampleText = fs.readFileSync(path.join(root, 'docs', 'examples', 'costs.example.json'), 'utf8')

/** The first ```json fence after the "## Configurable costs" heading (and before the next "## " heading). */
function readmeExample(): string {
  const start = readme.search(/^## Configurable costs\s*$/m)
  assert.ok(start >= 0, 'README.md has no "## Configurable costs" heading')
  const after = readme.slice(start + 1)
  const next = after.search(/^## /m)
  const section = next >= 0 ? after.slice(0, next) : after
  const m = /^```json\r?\n([\s\S]*?)\r?\n```/m.exec(section)
  assert.ok(m, 'no ```json block under "## Configurable costs"')
  return m[1]
}

test('README example equals docs/examples/costs.example.json', () => {
  assert.deepEqual(JSON.parse(readmeExample()), JSON.parse(exampleText))
  assert.equal(readmeExample().trim(), exampleText.trim(), 'same values but different text: keep the two copies identical')
})

test('the example passes validateConfigText with no errors and no warnings', () => {
  const r = validateConfigText(exampleText)
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(r.ok, true)
})

test('the README example passes validateConfigText with no errors and no warnings', () => {
  const r = validateConfigText(readmeExample())
  assert.deepEqual(r.errors, [])
  assert.deepEqual(r.warnings, [])
  assert.equal(r.ok, true)
})
