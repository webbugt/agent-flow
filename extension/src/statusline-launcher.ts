/**
 * The POSIX launcher of the statusLine wrapper (task N1). `settings.json` used to name one absolute node binary
 * (`"/home/u/.hermes/tools/node-26.12.1-linux-x64/bin/node" ".../statusline-shim.js"`); when that versioned directory
 * went away the status line command failed silently and observed limits stopped without any signal. The command is now
 * `sh "<home>/.claude/agent-flow/statusline-run.sh"`, and this script finds node every time it runs:
 *
 *  1. the node path recorded at install time (`~/.agent-flow/node-path`, one line, mode 0600);
 *  2. `command -v node` (the environment Claude Code runs the status line in);
 *  3. known locations: `~/.hermes/tools/node-*` (highest version), `~/.volta/bin/node`, the nvm default alias
 *     (else the highest installed nvm version), `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
 *
 * It then `exec`s `node statusline-shim.js` (the shim sits next to the launcher), so stdin, stdout, stderr and the exit
 * code are the shim's own, byte for byte. When the node it found differs from the recorded one it rewrites `node-path`
 * (self-heal: the next run takes step 1). With no node at all it prints nothing, exits 0 and leaves
 * `~/.agent-flow/limits/node-missing.json` (`{"v":1,"at":<ms>}`), which the UI shows as "the wrapper cannot find node"
 * instead of a reading that just goes stale. A run that finds node removes that marker.
 *
 * Only shell builtins are used on the hot path. External tools (`date`, `mkdir`, `mv`, `rm`) run through `command -p`,
 * so an empty PATH does not break the marker write. The `umask` is changed in subshells only: node and the user's own
 * status line command keep the umask Claude Code gave them. `AGENT_FLOW_NODE_DIRS` (colon separated) replaces the
 * system directories of step 3; it exists so tests do not depend on what is installed in /usr/bin.
 *
 * Windows does not use this file: the command there keeps the absolute node path.
 */

/** Substring that identifies the launcher command inside `settings.json`. */
export const STATUSLINE_LAUNCHER_MARKER = 'agent-flow/statusline-run.sh'

/** File format of `~/.agent-flow/limits/node-missing.json`. */
export const NODE_MISSING_FILE_VERSION = 1

export function getLauncherScriptContent(): string {
  return `#!/bin/sh
# Agent Flow statusLine launcher v1 — installed by Agent Flow ("Configure Claude statusLine").
# Finds node (recorded path, PATH, known locations), then runs the Agent Flow shim with the same stdin; the shim's
# output and exit code pass through unchanged. Without node it prints nothing, exits 0 and leaves
# ~/.agent-flow/limits/node-missing.json so Agent Flow can say so. "Remove Claude statusLine wrapper" deletes this file.

case $0 in */*) HERE=\${0%/*} ;; *) HERE=. ;; esac
SHIM="$HERE/statusline-shim.js"
AF="\${HOME:-}/.agent-flow"
REC="$AF/node-path"
MARK="$AF/limits/node-missing.json"

# A usable node: a regular, executable file.
ok() { [ -n "$1" ] && [ -f "$1" ] && [ -x "$1" ]; }

# KEY = sortable number of the version inside a directory name ("node-26.12.1-linux-x64", "v22.1.0"); 0 when unreadable.
vkey() {
  KEY=0
  v=\${1#"\${1%%[0-9]*}"}
  v=\${v%%[!0-9.]*}
  a=\${v%%.*}; r=\${v#"$a"}; r=\${r#.}
  b=\${r%%.*}; r=\${r#"$b"}; r=\${r#.}
  c=\${r%%.*}
  case "$a$b$c" in *[!0-9]*) return 0 ;; esac
  a=\${a#"\${a%%[!0]*}"}; b=\${b#"\${b%%[!0]*}"}; c=\${c#"\${c%%[!0]*}"}
  KEY=$(( \${a:-0} * 1000000000000 + \${b:-0} * 1000000 + \${c:-0} ))
}

# consider <node path> <version directory name>: keep the highest version seen so far in BEST.
consider() {
  ok "$1" || return 0
  vkey "$2"
  if [ "$KEY" -gt "$BESTKEY" ]; then BEST=$1; BESTKEY=$KEY; fi
}

find_hermes() {
  BEST=""; BESTKEY=-1
  for d in "$HOME"/.hermes/tools/node-*/bin/node; do
    n=\${d%/bin/node}; n=\${n##*/}
    consider "$d" "$n"
  done
  NODE=$BEST
}

find_nvm() {
  base=\${NVM_DIR:-$HOME/.nvm}
  want=""; hops=0
  if [ -r "$base/alias/default" ]; then
    IFS= read -r want < "$base/alias/default" || :
    while [ "$hops" -lt 4 ] && [ -n "$want" ] && [ -r "$base/alias/$want" ]; do
      case $want in *..*) want=""; break ;; esac
      IFS= read -r want < "$base/alias/$want" || :
      hops=$((hops + 1))
    done
  fi
  case $want in v[0-9]*|[0-9]*) ;; *) want="" ;; esac
  NODE=""
  for pass in 1 2; do
    BEST=""; BESTKEY=-1
    for d in "$base"/versions/node/v*/bin/node; do
      n=\${d%/bin/node}; n=\${n##*/}
      if [ "$pass" = 1 ] && [ -n "$want" ]; then
        case $n in "v\${want#v}"|"v\${want#v}".*) ;; *) continue ;; esac
      fi
      consider "$d" "$n"
    done
    if [ -n "$BEST" ]; then NODE=$BEST; return 0; fi
    [ -n "$want" ] || return 0
  done
}

find_node() {
  NODE=""
  p=$(command -v node 2>/dev/null) || p=""
  case $p in /*) if ok "$p"; then NODE=$p; return 0; fi ;; esac
  find_hermes; [ -n "$NODE" ] && return 0
  if ok "$HOME/.volta/bin/node"; then NODE="$HOME/.volta/bin/node"; return 0; fi
  find_nvm; [ -n "$NODE" ] && return 0
  dirs=\${AGENT_FLOW_NODE_DIRS-/opt/homebrew/bin:/usr/local/bin:/usr/bin}
  while [ -n "$dirs" ]; do
    case $dirs in *:*) dir=\${dirs%%:*}; dirs=\${dirs#*:} ;; *) dir=$dirs; dirs="" ;; esac
    if [ -n "$dir" ] && ok "$dir/node"; then NODE="$dir/node"; return 0; fi
  done
  return 1
}

REC_NODE=""
if [ -r "$REC" ]; then IFS= read -r REC_NODE < "$REC" || :; fi
case $REC_NODE in /*) ;; *) REC_NODE="" ;; esac

if ok "$REC_NODE"; then
  NODE=$REC_NODE
else
  find_node || NODE=""
fi

if [ -n "$NODE" ]; then
  if [ "$NODE" != "$REC_NODE" ]; then
    # Self-heal: remember the node that works, so the next run takes the first branch.
    ( umask 077; command -p mkdir -p "$AF" && printf '%s\\n' "$NODE" > "$REC.$$.tmp" && command -p mv -f "$REC.$$.tmp" "$REC" || command -p rm -f "$REC.$$.tmp" ) 2>/dev/null || :
  fi
  if [ -e "$MARK" ]; then command -p rm -f "$MARK" 2>/dev/null || :; fi
  exec "$NODE" "$SHIM"
fi

# No node anywhere: stay silent for Claude Code, leave a marker for Agent Flow.
( umask 077; command -p mkdir -p "$AF/limits" && printf '{"v":${NODE_MISSING_FILE_VERSION},"at":%s000}\\n' "$(command -p date +%s)" > "$MARK.$$.tmp" && command -p mv -f "$MARK.$$.tmp" "$MARK" || command -p rm -f "$MARK.$$.tmp" ) 2>/dev/null || :
exit 0
`
}
