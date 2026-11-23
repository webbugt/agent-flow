/**
 * Build identity (git branch + commit) for build:web and app/build.js.
 *
 * Plain CommonJS so the build scripts and next.config.mjs can load it without
 * a transpile step. Values come from git in the repository root, or from the
 * AGENT_FLOW_BUILD_BRANCH / AGENT_FLOW_BUILD_COMMIT environment variables
 * (which win; use them when building outside a git checkout, e.g. in CI from a
 * tarball). Anything that cannot be determined is the string 'unknown'.
 */
'use strict'

const { execFileSync } = require('child_process')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const UNKNOWN = 'unknown'
const MAX_LEN = 200

function runGit(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10000,
  })
}

/** Trim, drop control characters and cap the length; empty means "not set". */
function clean(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_LEN)
}

/**
 * @param {{ env?: Record<string, string | undefined>, cwd?: string, git?: (args: string[], cwd: string) => string }} [opts]
 * @returns {{ branch: string, commit: string }}
 */
function resolveBuildInfo(opts = {}) {
  const env = opts.env || process.env
  const cwd = opts.cwd || ROOT
  const git = opts.git || runGit

  const fromGit = args => {
    try { return clean(git(args, cwd)) } catch { return '' }
  }

  return {
    branch: clean(env.AGENT_FLOW_BUILD_BRANCH) || fromGit(['rev-parse', '--abbrev-ref', 'HEAD']) || UNKNOWN,
    commit: clean(env.AGENT_FLOW_BUILD_COMMIT) || fromGit(['rev-parse', 'HEAD']) || UNKNOWN,
  }
}

module.exports = { resolveBuildInfo, UNKNOWN }
