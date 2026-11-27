/**
 * Regression tests for the C4 masker gaps (MASK-A). Every secret below is a fake fixture (FAKE_123 and friends).
 * The older shapes (Authorization headers, URL credentials, api keys) stay covered by secret-mask.test.ts.
 */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MASK, looksSecret, maskSecrets } from './secret-mask'

function assertMasked(input: string, secrets: string[]): string {
  const out = maskSecrets(input)
  for (const s of secrets) assert.ok(!out.includes(s), `secret fixture "${s}" still in: ${out}`)
  assert.ok(out.includes(MASK), `nothing masked in: ${out}`)
  assert.equal(maskSecrets(out), out, 'masking must be idempotent')
  return out
}

function assertUnchanged(inputs: string[]): void {
  for (const t of inputs) assert.equal(maskSecrets(t), t, t)
}

test('gap 1: uppercase env assignments named *PASS*, *PASSWORD*, *SECRET*, *TOKEN*, *KEY* are masked', () => {
  let out = assertMasked('DB_PASS=FAKE_123 ./run.sh', ['FAKE_123'])
  assert.match(out, /^DB_PASS=\[MASKED\] \.\/run\.sh$/, 'name and command stay readable')
  assertMasked('docker run -e MYSQL_ROOT_PASSWORD=FAKE_123 mysql:8', ['FAKE_123'])
  assertMasked('export APP_SECRET=FAKE_123 && node x.js', ['FAKE_123'])
  assertMasked('SERVICE_TOKEN=FAKE_123 curl https://x.test', ['FAKE_123'])
  assertMasked('STRIPE_API_KEY=FAKE_123 node pay.js', ['FAKE_123'])
  assertMasked('SSH_KEY=FAKE_123 run', ['FAKE_123'])
  assertMasked('PASS=FAKE_123 run', ['FAKE_123'])
  assertMasked('REDIS_PASS="FAKE 123" run', ['FAKE 123'])
  assertMasked("KEY='FAKE_123' run", ['FAKE_123'])
  out = assertMasked('DB_PASS=FAKE_123 DB_USER=bob DB_HOST=db ./run', ['FAKE_123'])
  assert.match(out, /DB_USER=bob DB_HOST=db/, 'other assignments stay')
  assertMasked('docker run --env=DB_PASS=FAKE_123 img', ['FAKE_123'])
})

test('gap 1: env names that only contain the letters, and ordinary assignments, are left alone', () => {
  assertUnchanged([
    'MAX_KEYS=5 ./run',
    'KEYBOARD=us ./run',
    'PASSENGER=bob ./run',
    'PATH=/usr/bin:/bin ./run',
    'NODE_ENV=production pnpm build',
    'HOME=/home/idv ls',
  ])
})

test('gap 2: docker login -p VALUE, --password VALUE and --password=VALUE', () => {
  let out = assertMasked('docker login -u bob -p FAKE_123 registry.example.com', ['FAKE_123'])
  assert.match(out, /docker login -u bob -p \[MASKED\] registry\.example\.com/, 'user and registry stay')
  assertMasked('docker login registry.example.com -u bob -p FAKE_123', ['FAKE_123'])
  assertMasked('docker login -p "FAKE 123" -u bob', ['FAKE 123'])
  assertMasked('docker login -pFAKE_123 -u bob', ['FAKE_123'])
  assertMasked('docker login --username bob --password FAKE_123 registry.example.com', ['FAKE_123'])
  assertMasked('docker login --username bob --password=FAKE_123 registry.example.com', ['FAKE_123'])
  assertMasked('sudo docker --config /tmp/c login -u bob -p FAKE_123', ['FAKE_123'])
  assertMasked('podman login -u bob -p FAKE_123 quay.example.com', ['FAKE_123'])
  out = assertMasked('docker login -u bob -p FAKE_123 && docker run -p 8080:80 img', ['FAKE_123'])
  assert.match(out, /docker run -p 8080:80 img/, 'a later docker run -p (a port) is not touched')
  assertUnchanged([
    'docker run -p 8080:80 img',
    'docker login -u bob registry.example.com',
    'echo FAKE_123 | docker login -u bob --password-stdin registry.example.com',
  ])
})

test('gap 3: sshpass -p VALUE', () => {
  let out = assertMasked('sshpass -p FAKE_123 ssh bob@host.example.com uptime', ['FAKE_123'])
  assert.match(out, /sshpass -p \[MASKED\] ssh bob@host\.example\.com uptime/, 'the ssh part stays')
  assertMasked("sshpass -p 'FAKE 123' scp f bob@host:/tmp", ['FAKE 123'])
  assertMasked('sshpass -pFAKE_123 ssh bob@host', ['FAKE_123'])
  assertMasked('sshpass -v -p FAKE_123 ssh bob@host', ['FAKE_123'])
  out = assertMasked('sshpass -p FAKE_123 ssh -p 2222 bob@host', ['FAKE_123'])
  assert.match(out, /ssh -p 2222 bob@host/, 'the ssh port is not a secret')
  assertUnchanged(['sshpass -e ssh -p 2222 bob@host', 'sshpass -f /root/pw ssh -p 2222 bob@host', 'ssh -p 2222 bob@host'])
})

test('gap 4: redis-cli -a VALUE and --pass VALUE', () => {
  let out = assertMasked('redis-cli -h cache.example.com -a FAKE_123 ping', ['FAKE_123'])
  assert.match(out, /redis-cli -h cache\.example\.com -a \[MASKED\] ping/, 'host and command stay')
  assertMasked('redis-cli -a FAKE_123 --no-auth-warning ping', ['FAKE_123'])
  assertMasked('redis-cli -a "FAKE 123" ping', ['FAKE 123'])
  assertMasked('redis-cli --pass FAKE_123 ping', ['FAKE_123'])
  assertMasked('redis-cli --pass=FAKE_123 ping', ['FAKE_123'])
  assertMasked('redis-cli --user bob --pass FAKE_123 ping', ['FAKE_123'])
  assertMasked('redis-cli -u redis://:FAKE_123@cache.example.com:6379 ping', ['FAKE_123'])
  assertUnchanged(['redis-cli -h cache.example.com -p 6379 ping', 'redis-cli --scan --pattern "user:*"', 'tar -a x.tgz'])
})

test('gap 5: a token cut off at the truncation point is masked by its prefix alone', () => {
  const cut = [
    ['curl -H "X-Token: ghp_FAKE12', 'ghp_FAKE12'],
    ['export T=gho_FA', 'gho_FA'],
    ['git clone https://x.test --token github_pat_FAKE12', 'github_pat_FAKE12'],
    ['OPENAI=sk-FAKE1', 'sk-FAKE1'],
    ['echo sk-', 'sk-'],
    ['echo ghp_', 'ghp_'],
    ['slack xoxb-1234', 'xoxb-1234'],
    ['slack xoxp', 'xoxp'],
    ['aws configure set aws_access_key_id AKIAFAKE', 'AKIAFAKE'],
    ['echo sk-FAKE1…', 'sk-FAKE1'],
    ['echo ghp_FAKE12...', 'ghp_FAKE12'],
    ['echo ghp_FAKE12   ', 'ghp_FAKE12'],
  ] as const
  for (const [input, secret] of cut) {
    const out = assertMasked(input, [secret])
    assert.ok(out.length < input.length + 20, 'nothing else is changed')
  }
  const out = maskSecrets('echo hello && curl -H "X: ghp_FAKE12')
  assert.match(out, /^echo hello && curl -H "X: \[MASKED\]$/, 'text before the cut stays')
})

test('gap 5: prefix-like words that are not at the cut are not masked', () => {
  assertUnchanged([
    'git commit -m "task-list and desk-top"',
    'echo risk-free xoxo',
    'echo mask-me then more',
    'pnpm add scikit-learn',
    'grep -r "sk-" src/ --include=*.ts',
  ])
})

test('rework: any whitespace run, a tab, or a backslash line continuation before -p / -a is masked', () => {
  const forms: Array<[string, string]> = [
    ['double space', '  '],
    ['many spaces', '     '],
    ['tab', '\t'],
    ['tab and space', ' \t '],
    ['backslash newline indent', ' \\\n  '],
    ['backslash CRLF tab', ' \\\r\n\t'],
    ['bare newline', '\n'],
  ]
  for (const [name, gap] of forms) {
    let out = assertMasked(`docker login -u bob${gap}-p FAKE_123 registry.example.com`, ['FAKE_123'])
    assert.match(out, /registry\.example\.com$/, `docker ${name}: the registry stays`)
    assertMasked(`docker login -u bob${gap}-p "FAKE 123" registry.example.com`, ['FAKE 123'])
    assertMasked(`sshpass${gap}-p FAKE_123 ssh bob@host.example.com uptime`, ['FAKE_123'])
    assertMasked(`sshpass -v${gap}-p FAKE_123 ssh bob@host.example.com`, ['FAKE_123'])
    out = assertMasked(`redis-cli -h cache.example.com${gap}-a FAKE_123 ping`, ['FAKE_123'])
    assert.match(out, / ping$/, `redis ${name}: the command stays`)
    assertMasked(`redis-cli${gap}-a FAKE_123 ping`, ['FAKE_123'])
  }
})

test('rework: sshpass keeps the ssh port after its password, and docker run / redis -p stay, in every whitespace form', () => {
  for (const gap of ['  ', '\t', ' \\\n  ']) {
    const out = assertMasked(`sshpass${gap}-p FAKE_123${gap}ssh${gap}-p 2222 bob@host`, ['FAKE_123'])
    assert.ok(out.includes('-p 2222'), `ssh port stays: ${out}`)
  }
  assertUnchanged([
    'sshpass  -e ssh  -p 2222 bob@host',
    'docker  run  -p 8080:80 img',
    'docker run \\\n  -p 8080:80 img',
    'redis-cli  -h cache.example.com  -p 6379 ping',
  ])
})

test('rework: REDISCLI_AUTH and MYSQL_PWD are masked; SSH_AUTH_SOCK, PWD, OLDPWD and AUTHOR are not', () => {
  let out = assertMasked('REDISCLI_AUTH=FAKE_123 redis-cli ping', ['FAKE_123'])
  assert.match(out, /^REDISCLI_AUTH=\[MASKED\] redis-cli ping$/)
  out = assertMasked('MYSQL_PWD=FAKE_123 mysql -u root db', ['FAKE_123'])
  assert.match(out, /^MYSQL_PWD=\[MASKED\] mysql -u root db$/)
  assertMasked('export MYSQL_PWD="FAKE 123" && mysqldump db', ['FAKE 123'])
  assertMasked('docker run -e REDISCLI_AUTH=FAKE_123 redis', ['FAKE_123'])
  assertUnchanged([
    'SSH_AUTH_SOCK=/tmp/ssh-XXXX/agent.1 ssh host',
    'export SSH_AUTH_SOCK=/run/user/1000/keyring/ssh',
    'PWD=/home/idv ls',
    'OLDPWD=/tmp ls',
    'AUTHOR=bob git log',
  ])
})

test('looksSecret sees every new form (so a command head containing one is rejected)', () => {
  for (const t of [
    'DB_PASS=FAKE_123 run',
    'docker login -u bob -p FAKE_123',
    'sshpass -p FAKE_123 ssh host',
    'redis-cli -a FAKE_123 ping',
    'echo ghp_FAKE12',
  ]) assert.equal(looksSecret(t), true, t)
})

test('new rules stay linear on hostile input', () => {
  const inputs = [
    `${'docker '.repeat(40_000)}`,
    `docker login ${'-p '.repeat(40_000)}`,
    `${'sshpass '.repeat(40_000)}`,
    `${'redis-cli '.repeat(40_000)}`,
    `docker ${'a'.repeat(200_000)}`,
    `${'A_'.repeat(100_000)}KEY`,
    `${'KEY_'.repeat(50_000)}=`,
    `${'ghp_'.repeat(50_000)} `,
    `${'sk-'.repeat(50_000)}`,
    `ghp_${' '.repeat(200_000)}x`,
    `${'xox '.repeat(50_000)}`,
    `docker login -u bob${' '.repeat(200_000)}x`,
    `sshpass${' \\\n'.repeat(100_000)}x`,
    `redis-cli${'\t'.repeat(200_000)}-b`,
    `docker login ${'a  '.repeat(60_000)}`,
  ]
  const t0 = Date.now()
  for (const input of inputs) maskSecrets(input)
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`)
})

test('MASK-B2: a backslash line continuation between the flag and its value does not leak the value', () => {
  const gaps = [' \\\n  ', ' \\\r\n\t', ' \\\n  \\\n    ', '  \\\n']
  for (const gap of gaps) {
    const label = JSON.stringify(gap)
    let out = assertMasked(`docker login -u bob -p${gap}FAKE_123 registry.example.com`, ['FAKE_123'])
    assert.match(out, /registry\.example\.com$/, `docker -p ${label}: the registry stays`)
    assertMasked(`docker login -u bob -p${gap}"FAKE 123" registry.example.com`, ['FAKE 123'])
    assertMasked(`sshpass -p${gap}FAKE_123 ssh bob@host.example.com uptime`, ['FAKE_123'])
    out = assertMasked(`redis-cli -h cache.example.com -a${gap}FAKE_123 ping`, ['FAKE_123'])
    assert.match(out, / ping$/, `redis -a ${label}: the command stays`)
    assertMasked(`redis-cli --pass${gap}FAKE_123 ping`, ['FAKE_123'])
    assertMasked(`app --password${gap}FAKE_123 --verbose`, ['FAKE_123'])
    assertMasked(`app --token${gap}FAKE_123 run`, ['FAKE_123'])
    assertMasked(`curl -u${gap}bob:FAKE_123 https://x.test`, ['FAKE_123'])
  }
})

test('MASK-B2: a lone backslash is never taken as the value, and the ssh port after the password stays', () => {
  const out = assertMasked('sshpass -p \\\n  FAKE_123 \\\n  ssh -p 2222 bob@host', ['FAKE_123'])
  assert.ok(out.includes('ssh -p 2222'), `ssh port stays: ${out}`)
  assert.equal(maskSecrets('app --password \\'), 'app --password \\', 'a trailing lone backslash is left alone')
  assertUnchanged(['docker run \\\n  -p 8080:80 img', 'redis-cli -h cache \\\n  -p 6379 ping'])
})

test('MASK-B2 (low): redis-cli -a is masked behind more than 16 earlier tokens', () => {
  const filler = Array.from({ length: 30 }, (_, i) => `--opt${i}`).join(' ')
  assertMasked(`redis-cli ${filler} -a FAKE_123 ping`, ['FAKE_123'])
})

test('MASK-B3: a line continuation right behind the flag (no space) does not leak the value', () => {
  const nl = '\\\n'
  const gaps = [nl, `${nl}  `, `${nl}${nl}  `, '\\\r\n\t']
  for (const gap of gaps) {
    const label = JSON.stringify(gap)
    // Short flags, attached continuation: bash joins `-p\<nl>SECRET` into `-pSECRET`.
    const out = assertMasked(`docker login -u bob -p${gap}FAKE_123 registry.example.com`, ['FAKE_123'])
    assert.match(out, /registry\.example\.com$/, `docker -p ${label}: the registry stays`)
    assertMasked(`sshpass -p${gap}FAKE_123 ssh bob@host.example.com uptime`, ['FAKE_123'])
    assertMasked(`redis-cli -h cache.example.com -a${gap}FAKE_123 ping`, ['FAKE_123'])
    assertMasked(`mysql -u root -p${gap}FAKE_123 db`, ['FAKE_123'])
    assertMasked(`curl -u${gap}bob:FAKE_123 https://x.test`, ['FAKE_123'])
    // Long flags, attached continuation.
    assertMasked(`cmd --password${gap}FAKE_123 --verbose`, ['FAKE_123'])
    assertMasked(`cmd --pass${gap}FAKE_123 --verbose`, ['FAKE_123'])
    assertMasked(`redis-cli --pass${gap}FAKE_123 ping`, ['FAKE_123'])
    assertMasked(`cmd --token${gap}FAKE_123 run`, ['FAKE_123'])
    // `=` followed by a continuation.
    assertMasked(`cmd --password=${gap}FAKE_123 --verbose`, ['FAKE_123'])
    assertMasked(`docker login -u bob -p=${gap}FAKE_123 registry.example.com`, ['FAKE_123'])
    // name=value forms.
    assertMasked(`PASSWORD=${gap}FAKE_123 run`, ['FAKE_123'])
    assertMasked(`export MYSQL_ROOT_PASSWORD=${gap}FAKE_123`, ['FAKE_123'])
    assertMasked(`api_key=${gap}FAKE_123 run`, ['FAKE_123'])
  }
})

test('MASK-B3: the continuation forms stay idempotent and leave ports and a lone trailing backslash alone', () => {
  const nl = '\\\n'
  for (const c of [`docker login -p${nl}FAKE_123 r`, `sshpass -p${nl} FAKE_123 ssh h`, `cmd --password=${nl}FAKE_123`, `mysql -p${nl}FAKE_123 db`]) {
    const once = maskSecrets(c)
    assert.equal(maskSecrets(once), once, `idempotent: ${JSON.stringify(c)}`)
  }
  assertUnchanged([`docker run -p${nl} 8080:80 img`, `redis-cli -h cache -p${nl}6379 ping`, 'docker login -u bob -p\\', 'app --password\\', 'app --password=\\'])
})

test('MASK-B3: continuation runs behind a flag stay linear on hostile input', () => {
  const nl = '\\\n'
  const t0 = Date.now()
  for (const input of [
    `cmd --password${nl}`.repeat(100_000),
    nl.repeat(200_000),
    `docker login -p${nl}`.repeat(30_000),
    `mysql -p${nl}`.repeat(30_000),
    `PASSWORD=${nl}`.repeat(50_000),
    `curl -u${nl}`.repeat(50_000),
    `redis-cli -a${' \\\n'.repeat(100_000)}`,
  ]) maskSecrets(input)
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`)
})
