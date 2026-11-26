import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { commandHead, FALLBACK_HEAD } from './command-head'

const cases: Array<[command: string, head: string]> = [
  ['git status', 'git'],
  ['pnpm test', 'pnpm'],
  ['hermes kanban boards list', 'hermes'],
  ['gh pr list --state open', 'gh'],
  ['  git   log --oneline', 'git'],
  // path forms: only the base name
  ['/usr/bin/git status', 'git'],
  ['./scripts/run.sh --fast', 'run.sh'],
  ['~/bin/tool x', 'tool'],
  // assignments and wrappers
  ['FOO=1 BAR=2 pnpm build', 'pnpm'],
  ['NODE_ENV=production node app.js', 'node'],
  ['sudo systemctl status x', 'systemctl'],
  ['sudo -u deploy git pull', 'git'],
  ['env -u HOME FOO=1 pnpm test', 'pnpm'],
  ['time pnpm test', 'pnpm'],
  ['nohup node server.js &', 'node'],
  ['nice -n 10 make', 'make'],
  ['command -v git', 'git'],
  // leading preparation segments
  ['cd /home/idv/workspace/x && git status', 'git'],
  ['cd web; pnpm test', 'pnpm'],
  ['export A=1 && node x.js', 'node'],
  ['source .env && pnpm dev', 'pnpm'],
  ['set -e; pnpm install', 'pnpm'],
  // pipes and lists: the first command
  ['cat package.json | grep version', 'cat'],
  ['git status && git diff', 'git'],
  ['ls -la || true', 'ls'],
  // shells: the inner command
  ["bash -c 'git status'", 'git'],
  ['sh -lc "cd x && pnpm test"', 'pnpm'],
  ['bash script.sh', 'bash'],
  ['bash', 'bash'],
  // multi-line
  ['# build it\n\npnpm build\npnpm test', 'pnpm'],
  ['\n\n  git log\n', 'git'],
  ['cat <<EOF\nhello\nEOF', 'cat'],
  // a lone preparation word is itself the command
  ['cd', 'cd'],
  ['cd /tmp', 'cd'],
]

for (const [command, head] of cases) {
  test(`head of ${JSON.stringify(command)} is ${head}`, () => assert.equal(commandHead(command), head))
}

test('no usable head -> "command" (never a quoted string, a variable, a subshell or a flag)', () => {
  for (const c of ['', '   ', '# only a comment', '"quoted program" x', '$(whoami)', '$HOME/bin/x', '(cd x && ls)', '--flag', '`ls`', '!!', '..', '.', '{ ls; }']) {
    assert.equal(commandHead(c), FALLBACK_HEAD, JSON.stringify(c))
  }
  assert.equal(commandHead(undefined as unknown as string), FALLBACK_HEAD)
  assert.equal(commandHead(42 as unknown as string), FALLBACK_HEAD)
})

test('a secret in the first word never becomes the head', () => {
  const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
  assert.equal(commandHead(`${GH} --flag`), FALLBACK_HEAD)
  assert.equal(commandHead('sk-abcdefghijklmnopqrstuvwxyz012345'), FALLBACK_HEAD)
  assert.equal(commandHead('AKIAABCDEFGHIJKLMNOP'), FALLBACK_HEAD)
})

test('the head holds only the program name: arguments and tokens in the args are not in it', () => {
  const cmd = 'curl -H "Authorization: Bearer abc123def456ghi789" --password hunter2 https://u:p4ss@x.test'
  assert.equal(commandHead(cmd), 'curl')
})

test('head names longer than 40 characters are not accepted', () => {
  assert.equal(commandHead(`${'a'.repeat(41)} x`), FALLBACK_HEAD)
  assert.equal(commandHead(`${'a'.repeat(40)} x`), 'a'.repeat(40))
})

test('a huge command is cut and stays fast', () => {
  const big = `git ${'x '.repeat(500_000)}`
  const t0 = Date.now()
  assert.equal(commandHead(big), 'git')
  assert.equal(commandHead(`${'\n'.repeat(500_000)}git status`), FALLBACK_HEAD, 'only the first 4000 characters are looked at')
  assert.ok(Date.now() - t0 < 500)
})

test('bash -c nests only a few levels deep', () => {
  assert.equal(commandHead("bash -c \"bash -c 'bash -c \\\"bash -c git\\\"'\""), 'bash')
})
