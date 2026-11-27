/**
 * Secret masking for text that the Fleet map shows in the browser (the full bash command in a block's inspector).
 *
 * Binding decision 3: known secret patterns (tokens, passwords, Authorization headers, credentials in URLs, API
 * keys) are masked even in the inspection that shows the full command. This is the browser-side rule; it does
 * not rely on the relay having redacted the text first (the Claude Code path has no redaction at all, T0 spike
 * 2d.1), and it also closes the gaps of the relay's redactSecrets that the spike found: `--password VALUE`
 * with a space, `curl -u user:pass`, `mysql -pSECRET`.
 *
 * Pure text in, text out; no DOM, no Node. Every pattern is linear (no nested quantifiers, bounded names), so a
 * hostile 1 MB command cannot stall the page. Over-masking is accepted (a `max_tokens=4000` is masked too); a
 * missed secret is not. This is a pattern list, not a guarantee: a secret in an unknown shape passes. The head of
 * a command (the only part the block itself shows) never goes through here as text: command-head.ts accepts a
 * head only if masking leaves it unchanged.
 */

export const MASK = '[MASKED]'

/** Names that say the value after a flag is a secret. */
const NAME_FLAG =
  '(?:api[_-]?key|apikey|secret|token|passwd|password|passphrase|pass|credential|private[_-]?key|access[_-]?key|client[_-]?secret|auth)'
/** Same for name=value, without the short words that are also ordinary names (author=, passthrough=). */
const NAME_KV =
  '(?:api[_-]?key|apikey|secret|token|passwd|password|passphrase|credential|private[_-]?key|access[_-]?key|client[_-]?secret)'

/**
 * The separator between a flag and its value: whitespace with any number of `\` line continuations in it
 * (`-p \<newline>  SECRET`), or `=`. Without the continuations VALUE would take the lone `\` as the value.
 */
const SEP = '(?:\\s+(?:\\\\\\r?\\n\\s*)*|=)'
/** Not a value: a lone `\` (a continuation with nothing behind it), so the regex cannot settle for it. */
const NOT_BARE_BACKSLASH = '(?!\\\\(?:\\s|$))'

/** A value: a double-quoted string, a single-quoted string, or a run without spaces and shell separators. */
const VALUE = `"[^"]*"|'[^']*'|[^\\s"';|&)]+`

/**
 * The `_`-separated name parts that mark an uppercase environment variable as a secret, plus two exact names whose
 * parts are too common alone (`AUTH` is in SSH_AUTH_SOCK, `PWD` is the working directory).
 */
const ENV_SECRET_PART = '(?:PASSWORD|PASSWD|PASS|SECRET|TOKEN|KEY|REDISCLI_AUTH|MYSQL_PWD)'

/**
 * Known token prefixes with whatever tail is left of them (see the truncation rule in RULES). The tail classes are the
 * ones of the full-token rules, without the minimum length.
 */
const TRUNCATED_TOKEN = [
  '(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]*',
  'github_pat_[A-Za-z0-9_]*',
  'sk-[A-Za-z0-9_-]*',
  'xox(?:[abprs](?:-[A-Za-z0-9-]*)?)?',
  'AKIA[0-9A-Z]*',
].join('|')

type Replacer = string | ((...m: string[]) => string)

const RULES: Array<[RegExp, Replacer]> = [
  // PEM private keys, whole block (or to the end when the END line is missing).
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[MASKED PRIVATE KEY]'],
  // Well-known token shapes.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\bAKIA[0-9A-Z]{16}\b/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, MASK],
  [/\bsyt_[A-Za-z0-9_]{16,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{30,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{30,}/g, MASK],
  // A token cut off by truncation (hook args, the command cap): the prefix alone is enough, whatever is left of the
  // tail, even nothing. Only at the end of the text or right before an ellipsis, so ordinary words that start like a
  // prefix (`risk-free`, `task-list`) and a prefix in the middle of a command are not touched.
  [new RegExp(`\\b(?:${TRUNCATED_TOKEN})(?=\\s*$|\u2026|\\.{3})`, 'g'), MASK],
  // Telegram bot token: <8-10 digit bot id>:<35 chars>.
  [/(?<![0-9])[0-9]{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g, MASK],
  // Slack and Discord webhook URLs carry the secret in the path.
  [/https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g, 'https://hooks.slack.com/[MASKED]'],
  [/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+/g, 'https://discord.com/api/webhooks/[MASKED]'],
  // JWTs.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // Authorization headers, whatever the scheme and however short the token: `Authorization: Bearer x`, `-H "Authorization: x"`.
  [
    /\b((?:proxy-)?authorization)(["']?\s*[:=]\s*["']?)(?:(Bearer|Basic|Token|Digest|Negotiate)\s+)?[^\s"']+/gi,
    (_m, name, sep, scheme) => `${name}${sep}${scheme ? `${scheme} ` : ''}${MASK}`,
  ],
  // A bare `Bearer <token>` / `Basic <token>` elsewhere (a `-H` value without the header name, a log line).
  [/\b(Bearer|Basic)\s+(?!\[MASKED)[A-Za-z0-9._~+/=-]{12,}/g, (_m, scheme) => `${scheme} ${MASK}`],
  // Credentials inside a URL: scheme://user:password@host
  // The user may be empty (`redis://:password@host`).
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)(?!\[MASKED)[^\s@/]+(@)/gi, (_m, head, at) => `${head}${MASK}${at}`],
  // Flags that take a secret: `--password hunter2`, `--token=abc`, `-token abc`, `--api-key "a b"`. The name must end
  // at the flag's end, so `--token-file path` is not touched by this rule.
  [
    new RegExp(`(\\s--?${NAME_FLAG}s?)(${SEP})(?!\\[MASKED)${NOT_BARE_BACKSLASH}(${VALUE})`, 'gi'),
    (_m, flag, sep) => `${flag}${sep}${MASK}`,
  ],
  // name=value and "name": "value" for names that say they are secret (GITHUB_TOKEN=..., "api_key": "...").
  // Only the keyword and a short suffix are matched, never an unbounded run of name characters.
  [
    new RegExp(`(${NAME_KV}[A-Za-z0-9_-]{0,20})(["']?\\s*[:=]\\s*)(?!\\[MASKED|["']?\\[MASKED)(${VALUE}|[^\\s,}]+)`, 'gi'),
    (_m, name, sep) => `${name}${sep}${MASK}`,
  ],
  // Uppercase environment names that say they hold a secret: DB_PASS=..., MYSQL_ROOT_PASSWORD=..., SSH_KEY=...
  // The keyword must be a whole `_`-separated part of the name (MAX_KEYS, KEYBOARD, PASSENGER stay) and the name
  // is bounded, so this stays linear.
  [
    new RegExp(
      `(?<![A-Za-z0-9_])((?:[A-Z0-9]{1,20}_){0,5}${ENV_SECRET_PART}(?:_[A-Z0-9]{1,20}){0,3})(=)(?!\\[MASKED|["']\\[MASKED)(${VALUE})`,
      'g',
    ),
    (_m, name, sep) => `${name}${sep}${MASK}`,
  ],
]

/**
 * Tool-specific rules, applied only when the command names the tool. They would over-mask for every command
 * (`-p` is a port for ssh, `-u` a user for sudo), so they look at the command first.
 */
const TOOL_RULES: Array<[test: RegExp, RegExp, Replacer]> = [
  // mysql / mariadb: the password sits right behind -p, no space: `mysql -u root -pSecret db`.
  [/\b(?:mysql|mysqldump|mysqladmin|mariadb)\b/, /(\s-p)(?=\S)(?!\[MASKED)[^\s]+/g, (_m, flag) => `${flag}${MASK}`],
  // curl / wget / httpie: `-u user:pass`, `--user user:pass`, `--proxy-user user:pass`.
  [
    /\b(?:curl|wget|http|https|xh)\b/,
    /(\s(?:-u|--user|--proxy-user|--http-user|--http-password))((?:\s+(?:\\\r?\n\s*)*|=))(?!\[MASKED)(?!\\(?:\s|$))("[^"]*"|'[^']*'|[^\s"']+)/g,
    (_m, flag, sep, value) => (/:/.test(value) || /password/i.test(flag) ? `${flag}${sep}${MASK}` : `${flag}${sep}${value}`),
  ],
  // docker / podman / nerdctl / buildah / skopeo login: `-p VALUE`, `-pVALUE`, `-p=VALUE` (--password is a flag rule).
  // Between `login` and `-p` only plain tokens, never a shell separator, so a later `docker run -p 8080:80` is safe.
  [
    /\b(?:docker|podman|nerdctl|buildah|skopeo)\b/,
    shortFlagRule('\\b(?:docker|podman|nerdctl|buildah|skopeo)\\b(?:\\s+[^\\s;|&]+){0,6}?\\s+login\\b(?:\\s+[^\\s;|&]+){0,10}?', '-p'),
    maskAfterFlag,
  ],
  // sshpass -p VALUE. Only sshpass's own options (and a `\` line continuation) may sit before -p, so
  // `sshpass -e ssh -p 2222 host` keeps its port.
  [/\bsshpass\b/, shortFlagRule('\\bsshpass\\b(?:\\s+(?:-[evVh]+|-[fdP]\\s*[^\\s;|&]+|\\\\(?=\\s)))*?', '-p'), maskAfterFlag],
  // redis-cli / valkey-cli -a VALUE (--pass is a flag rule).
  [
    /\b(?:redis-cli|valkey-cli)\b/,
    shortFlagRule('\\b(?:redis-cli|valkey-cli)\\b(?:\\s+[^\\s;|&]+){0,64}?', '-a'),
    maskAfterFlag,
  ],
]

/**
 * `<tool prefix> <flag> VALUE`, `<flag>=VALUE` or `<flag>VALUE` (the form getopt/pflag accept). The whitespace before
 * the flag is a run (`\s+`: double space, tab, `\` + newline + indent). Group 1 is everything up to and with the
 * flag; the value is replaced. A value that starts with `-` is not taken (`-p -x` is another flag).
 */
function shortFlagRule(prefix: string, flag: string): RegExp {
  return new RegExp(`(${prefix}\\s+${flag})(?:(${SEP})(?!\\[MASKED)${NOT_BARE_BACKSLASH}(${VALUE})|(?=[^\\s=-])(?!\\[MASKED)[^\\s;|&]+)`, 'g')
}

function maskAfterFlag(_m: string, head: string, sep?: string): string {
  return `${head}${sep ?? ''}${MASK}`
}

/** Mask secrets in `text`. Idempotent: masking masked text changes nothing. */
export function maskSecrets(text: string): string {
  let out = text
  for (const [re, replacement] of RULES) out = out.replace(re, replacement as string)
  for (const [test, re, replacement] of TOOL_RULES) {
    if (test.test(out)) out = out.replace(re, replacement as string)
  }
  return out
}

/** True when masking would change `text`: it holds something that looks like a secret. */
export function looksSecret(text: string): boolean {
  return maskSecrets(text) !== text
}
