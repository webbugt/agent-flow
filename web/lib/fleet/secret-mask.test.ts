import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { MASK, looksSecret, maskSecrets } from './secret-mask'

const GH = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const SK = 'sk-abcdefghijklmnopqrstuvwxyz012345'

/** Every secret of the fixture must be gone from the masked text. */
function assertMasked(input: string, secrets: string[]): string {
  const out = maskSecrets(input)
  for (const s of secrets) assert.ok(!out.includes(s), `secret "${s}" still in: ${out}`)
  assert.ok(out.includes(MASK) || out.includes('[MASKED'), `nothing masked in: ${out}`)
  return out
}

test('token shapes are masked wherever they sit', () => {
  assertMasked(`curl https://api.github.com/user -H "X-Token: ${GH}"`, [GH])
  assertMasked(`export OPENAI=${SK} && node run.js`, [SK])
  assertMasked('aws s3 ls --profile x AKIAABCDEFGHIJKLMNOP', ['AKIAABCDEFGHIJKLMNOP'])
  assertMasked('echo xoxb-1234567890-abcdefghij', ['xoxb-1234567890-abcdefghij'])
  assertMasked('use eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', ['eyJhbGciOiJIUzI1NiJ9'])
  assertMasked('curl https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXX', ['T000/B000/XXXXXXXXXXXX'])
})

test('Authorization headers: any scheme, any length, quoted or not', () => {
  const out = assertMasked(`curl -H "Authorization: Bearer abc123def456ghi789" https://x.test`, ['abc123def456ghi789'])
  assert.match(out, /Authorization: Bearer \[MASKED\]/, 'the header name and the scheme stay readable')
  assertMasked(`curl -H 'Authorization: Basic dXNlcjpwYXNz' https://x.test`, ['dXNlcjpwYXNz'])
  assertMasked('curl -H "authorization: sh0rt" https://x.test', ['sh0rt'])
  assertMasked('curl -H "Proxy-Authorization: Basic Zm9vOmJhcg==" https://x.test', ['Zm9vOmJhcg=='])
  assertMasked('echo Bearer abcdefghijklmnop1234', ['abcdefghijklmnop1234'])
})

test('credentials in URLs: the password goes, the user and host stay', () => {
  const out = assertMasked('git clone https://alice:hunter2pass@git.example.com/repo.git', ['hunter2pass'])
  assert.match(out, /https:\/\/alice:\[MASKED\]@git\.example\.com\/repo\.git/)
  assertMasked('psql postgres://app:s3cr3t@db:5432/x', ['s3cr3t'])
})

test('flags with a space or = (the gap of the relay redactor): --password VALUE, --token=VALUE, --api-key "a b"', () => {
  const out = assertMasked('tool --user bob --password hunter2 --verbose', ['hunter2'])
  assert.match(out, /--user bob --password \[MASKED\] --verbose/, 'neighbouring flags stay')
  assertMasked('deploy --token=abcdef123', ['abcdef123'])
  assertMasked('deploy -token abcdef123', ['abcdef123'])
  assertMasked('deploy --api-key "my secret value" --x', ['my secret value'])
  assertMasked("deploy --secret 'quoted secret'", ['quoted secret'])
  assertMasked('deploy --client-secret=zzz999zzz', ['zzz999zzz'])
})

test('flags that only look similar are left alone', () => {
  for (const t of ['pnpm test --token-file ./token.txt', 'git log --author=alice', 'node app.js --passthrough x', 'ssh -p 2222 host', 'sudo -u root ls']) {
    assert.equal(maskSecrets(t), t, t)
  }
})

test('name=value assignments: env vars, JSON, config lines', () => {
  assertMasked('GITHUB_TOKEN=abc123 gh pr list', ['abc123'])
  assertMasked('API_KEY="k e y" run', ['k e y'])
  assertMasked('echo \'{"password": "p@ss w0rd", "user": "x"}\' > c.json', ['p@ss w0rd'])
  assertMasked('DB_PASSWORD=pw1 DB_USER=bob ./run', ['pw1'])
  const out = maskSecrets('DB_PASSWORD=pw1 DB_USER=bob ./run')
  assert.match(out, /DB_USER=bob/, 'other assignments stay')
})

test('mysql -pSECRET and curl -u user:pass (tool rules apply only to those tools)', () => {
  assertMasked('mysql -u root -pSuperSecret mydb', ['SuperSecret'])
  assertMasked('curl -u alice:wonderland https://x.test', ['wonderland'])
  assertMasked('curl --user alice:wonderland https://x.test', ['wonderland'])
  assertMasked('wget --http-password=zzz999 https://x.test', ['zzz999'])
  // Same flags, other tools: not touched.
  assert.equal(maskSecrets('docker run -u 1000:1000 img'), 'docker run -u 1000:1000 img')
  assert.equal(maskSecrets('ssh -p2222 host'), 'ssh -p2222 host')
  assert.equal(maskSecrets('curl -u alice https://x.test'), 'curl -u alice https://x.test', 'a user name alone is not a secret')
})

test('PEM private key block, also when the END line is missing', () => {
  const body = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC'
  assertMasked(`echo "-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----" > k.pem`, [body])
  assertMasked(`echo "-----BEGIN PRIVATE KEY-----\n${body}`, [body])
})

test('ordinary commands pass unchanged', () => {
  for (const t of [
    'git status', 'pnpm test', 'git commit -m "fix token handling"', 'ls -la /home/idv/workspace',
    'node --import tsx --test "scripts/**/*.test.ts"', 'git log --oneline -5', 'echo hello > out.txt',
    'cat package.json | grep version', 'git show 0b89835d2f1c4e9a7b6c5d4e3f2a1b0c9d8e7f6a',
  ]) assert.equal(maskSecrets(t), t, t)
})

test('masking is idempotent and looksSecret says whether anything was masked', () => {
  const t = `curl -H "Authorization: Bearer abc123def456ghi789" --password hunter2 https://u:p4ss@x.test ${GH}`
  const once = maskSecrets(t)
  assert.equal(maskSecrets(once), once)
  assert.equal(looksSecret(t), true)
  assert.equal(looksSecret('git status'), false)
})

test('hostile input stays fast (no catastrophic backtracking)', () => {
  const inputs = [
    'a'.repeat(200_000),
    'token'.repeat(40_000),
    `${'password='.repeat(20_000)}x`,
    `${'--token '.repeat(20_000)}`,
    `"${'authorization: '.repeat(10_000)}`,
    `-----BEGIN PRIVATE KEY-----${'x'.repeat(200_000)}`,
    `curl ${'-u a:'.repeat(20_000)}`,
    `${'https://a:'.repeat(20_000)}`,
  ]
  const t0 = Date.now()
  for (const input of inputs) maskSecrets(input)
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`)
})
