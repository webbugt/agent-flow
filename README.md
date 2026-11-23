# Agent Flow

Real-time visualization of Claude Code and Codex agent orchestration. Watch your agents think, branch, and coordinate as they work. [Demo video here](https://www.youtube.com/watch?v=Ud6eDrFN-TA). 

![Agent Flow visualization](https://res.cloudinary.com/dxlvclh9c/image/upload/v1773924941/screenshot_e7yox3.png)

## Why Agent Flow?

I built Agent Flow while developing [Antics](https://antics.gg), a game creation platform driven by AI agents. Debugging agent behavior was painful, so we made it visual. Now we're sharing it.

Claude Code is powerful, but its execution is a black box — you see the final result, not the journey. Agent Flow makes the invisible visible:

- **Understand agent behavior** — See how Claude breaks down problems, which tools it reaches for, and how subagents coordinate
- **Debug tool call chains** — When something goes wrong, trace the exact sequence of decisions and tool calls that led there
- **See where time is spent** — Identify slow tool calls, unnecessary branching, or redundant work at a glance
- **Learn by watching** — Build intuition for how to write better prompts by observing how Claude interprets and executes them

Running many sessions at once? Agent Flow pairs with [Ravenry](https://patoles.github.io/ravenry/): Agent Flow shows what one session is doing inside, Ravenry puts all your Claude Code and Codex sessions on one board, shows which one needs you, and lets you answer from your phone.

## Features

- **Live agent visualization**: Watch agent execution as an interactive node graph with real-time tool calls, branching, and return flows
- **Claude Code + Codex**: Auto-detects sessions from both runtimes concurrently and shows them side-by-side, or restrict to one via the `agentVisualizer.runtime` setting
- **Claude Code hooks**: Lightweight HTTP hook server receives events directly from Claude Code for zero-latency streaming
- **Codex rollout tailing**: Reads `~/.codex/sessions/**/rollout-*.jsonl` (respects `CODEX_HOME`) and surfaces tool calls, reasoning, and authoritative token counts from Codex's own event stream
- **Multi-session support**: Track multiple concurrent agent sessions with tabs
- **Interactive canvas**: Pan, zoom, click agents and tool calls to inspect details
- **Timeline & transcript panels**: Review the full execution timeline, file attention heatmap, and message transcript
- **JSONL log file support**: Point at any JSONL event log to replay or watch agent activity

## Getting Started

### Quick Start (no VS Code required)

```bash
npx agent-flow-app
```

This starts the visualizer in your browser. Start a Claude Code session in another terminal — events will stream in real-time.

Options:
- `--port <number>` — change the server port (default: 3001)
- `--no-open` — don't open the browser automatically
- `--verbose` — show detailed event logs
- `--anonymize-content[=<all|none|profile,profile>]` — show structure only instead of content (see below). A bare flag means `all`.
- `--show-content` — same as `--anonymize-content=none`

#### Live Hermes feed: full text, and anonymizing it per profile

For Hermes profiles the relay reads each session's messages from the profile's `state.db` (**read-only**: opened with `readOnly` and `PRAGMA query_only`, SELECT only, nothing is ever written to Hermes) and shows the full user and assistant text, the full Bash command, edit diffs (old and new text), write contents and tool results. If `state.db` or the session can't be read, the feed falls back to what `agent.log` offers (tool name and duration only). Strings that look like secrets (API keys, tokens, `Bearer …`, `password=…`, URL credentials, private keys) are redacted from everything shown, whatever the setting below.

Only item counts and one huge-text guard are capped (memory protection): `MAX_EVENT_LOG`, `MAX_CONVERSATION_MESSAGES` and `MAX_BUBBLES` in `web/hooks/simulation/types.ts`, the relay's `MAX_EVENT_BUFFER`, `MAX_MARKERS_PER_INSTANCE` (300 timeline markers per agent in the Fleet tab, `web/lib/fleet/fleet-model.ts`), `BACKLOG_MAX_ROWS` (300, the rows replayed on a session's first read) and `BATCH_MAX_ROWS` (500, the rows per later read) in `scripts/hermes-transcript.ts`, and `AGENT_FLOW_MAX_TEXT_CHARS` (default 200000 characters per text field, `0` = off).

To show **structure only** for some or all profiles — command name and length instead of the command, file path and line counts instead of a diff, role / sender / platform and length instead of a message body, size instead of a tool result, and task id and length instead of a Kanban task title in the Fleet tab — set, when the relay starts:

| Setting | Meaning |
|---|---|
| `AGENT_FLOW_ANONYMIZE_CONTENT=all` | anonymize every profile |
| `AGENT_FLOW_ANONYMIZE_CONTENT=none` | full content for every profile |
| `AGENT_FLOW_ANONYMIZE_CONTENT=hestia,sophia` | anonymize only the listed Hermes profiles |
| `--anonymize-content=<value>` / `--show-content` | same values as flags; a flag wins over the environment variable |
| `AGENT_FLOW_ANONYMIZE_OVERRIDES=hestia=on,sophia=off` | per-profile override, wins over everything above (relay option `anonymizeOverrides` does the same in code) |

Profiles the setting does not name follow the default, which is **`none`** (full content) — one constant, `DEFAULT_ANONYMIZE` in `web/lib/content-privacy.ts`. A name that is not a Hermes profile on this machine is ignored with a warning in the relay log; the relay still starts. The live feed, the session detail and the Fleet tab all follow the same per-profile setting, and anonymizing happens in the relay, so the hidden text never reaches the browser.

The Fleet tab reads Hermes Kanban boards and Supermemory namespaces (read-only) from `GET /api/fleet`. The endpoint is loopback-only by default: requests with a non-loopback `Host` or proxy headers (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`) get `403`. To serve it through a reverse proxy or to other machines, set `AGENT_FLOW_FLEET_ALLOW_REMOTE=1` — this exposes board names, task titles and namespace names to anyone who can reach the port, so only use it on a trusted network. The response never contains filesystem paths: the Kanban database path is dropped and scrubbed from board error messages.

#### Which build is running

Every build records the git branch and commit it was built from (`git rev-parse --abbrev-ref HEAD` / `git rev-parse HEAD` in the repository root; `AGENT_FLOW_BUILD_BRANCH` and `AGENT_FLOW_BUILD_COMMIT` override them, e.g. when building from a tarball; unknown values are `unknown`). `pnpm run build:app` bakes them into `app/dist/app.js`, and `pnpm run build:web` into the Next.js page. They show up in:

- the page: `<meta name="build-branch" content="…">` and `<meta name="build-commit" content="…">` in the HTML head;
- the relay: `GET /health` returns `{"status":"ok","branch":"…","commit":"…"}`. It has the same loopback `Host` check as every other route (a foreign `Host` gets `403`).

```bash
curl -s http://127.0.0.1:3001/health
curl -s http://127.0.0.1:3001/ | grep -o '<meta name="build-[a-z]*" content="[^"]*">'
```

### Standalone Web App (from source)

```bash
git clone https://github.com/patoles/agent-flow.git
cd agent-flow
pnpm i
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start the web app + event relay
```

Open http://localhost:3000 and start a Claude Code session in another terminal — events will stream to the browser in real-time.

### VS Code Extension

1. Install the extension
2. Open the Command Palette (`Cmd+Shift+P`) and run **Agent Flow: Open Agent Flow**
3. Start a Claude Code or Codex session in your workspace — Agent Flow will auto-detect it

Agent Flow automatically configures Claude Code hooks the first time you open the panel. To manually reconfigure, run **Agent Flow: Configure Claude Code Hooks** from the Command Palette.

### Runtime selection

By default Agent Flow watches both Claude Code (`~/.claude/projects/`) and Codex (`~/.codex/sessions/`) concurrently in all three entry points (VS Code extension, `pnpm run dev`, `npx agent-flow-app`). Sessions are shown side-by-side and tagged by runtime. If you only use one, the other is a harmless no-op — no visible effect, no user action needed.

To restrict to one runtime:

- **VS Code extension:** set `agentVisualizer.runtime` to `"auto"` / `"claude"` / `"codex"` in your settings
- **`pnpm run dev` and `npx agent-flow-app`:** set the `AGENT_FLOW_RUNTIME` environment variable to `claude` or `codex` (defaults to watching both)

For non-default Codex installs, set the `CODEX_HOME` environment variable.

### JSONL Event Log

You can also point Agent Flow at a JSONL event log file:

1. Set `agentVisualizer.eventLogPath` in your VS Code settings to the path of a `.jsonl` file
2. Agent Flow will tail the file and visualize events as they arrive

## Commands

| Command | Description |
|---------|-------------|
| `Agent Flow: Open Agent Flow` | Open the visualizer panel |
| `Agent Flow: Open Agent Flow to Side` | Open in a side editor column |
| `Agent Flow: Connect to Running Agent` | Manually connect to an agent session |
| `Agent Flow: Configure Claude Code Hooks` | Set up Claude Code hooks for live streaming |

## Keyboard Shortcut

| Shortcut | Action |
|----------|--------|
| `Cmd+Alt+A` (Mac) / `Ctrl+Alt+A` (Win/Linux) | Open Agent Flow |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `agentVisualizer.runtime` | `"auto"` | Which agent runtime(s) to watch: `"auto"` (both), `"claude"`, or `"codex"` |
| `agentVisualizer.devServerPort` | `0` | Development server port (0 = production mode) |
| `agentVisualizer.eventLogPath` | `""` | Path to a JSONL event log file to watch |
| `agentVisualizer.autoOpen` | `false` | Auto-open when an agent session starts |

## Requirements

- [Node.js](https://nodejs.org/) 20+ (LTS recommended)
- [pnpm](https://pnpm.io/)
- Claude Code CLI
- For the VS Code extension: a VSCode-compatible IDE 1.85+ (e.g. [VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.sh/), [Windsurf](https://windsurf.com/))

## Development

```bash
pnpm i              # install dependencies for all packages
pnpm run setup      # configure Claude Code hooks (one-time)
pnpm run dev        # start dev server + event relay
```

`pnpm run dev` starts both the Next.js dev server and an event relay that receives Claude Code events and streams them to the browser via SSE.

Other scripts:

| Script | Description |
|--------|-------------|
| `pnpm run dev:demo` | Start with demo/mock data |
| `pnpm run dev:relay` | Run the event relay server standalone |
| `pnpm run dev:extension` | Watch-build the extension |
| `pnpm run build:all` | Production build (webview + extension) |
| `pnpm run build:web` | Build the Next.js web app |
| `pnpm run build:extension` | Build the extension |
| `pnpm run build:webview` | Build the webview assets |

## Star History

[![Star History Chart](https://api.star-history.com/chart?repos=patoles/agent-flow&type=date&legend=bottom-right)](https://www.star-history.com/?repos=patoles%2Fagent-flow&type=date&legend=bottom-right)


## Author

Created by [Simon Patole](https://github.com/patoles), for [Antics](https://antics.gg). Also by me: [Ravenry](https://patoles.github.io/ravenry/), one board for all your agent sessions.

Want an MCP server for your product, or Claude Code set up for your team? [Work with me](https://simonpatole.com).

## Privacy & Telemetry

Agent Flow ships **opt-out** anonymous usage telemetry, enabled by default only
in the published `npx agent-flow-app` binary. `pnpm run dev` and the VS Code
extension emit nothing. Only aggregate events are sent — session count,
duration, event count, OS/arch, Agent Flow version, distinct model IDs
observed, which runtimes were watched, and error class names. Prompts, file
paths, tool calls, user info, and environment variables are never sent.

- **Turn off:** `export AGENT_FLOW_TELEMETRY=false` or `export DO_NOT_TRACK=1`
  (disabled installs write zero state to disk — no `~/.agent-flow/` directory)
- **Inspect the payload:** `cat ~/.agent-flow/telemetry/events.jsonl`
- **Full schema + exact fields:** see the v0.8.1 entry in
  [extension/CHANGELOG.md](extension/CHANGELOG.md) or the `serialize()` function
  in [scripts/telemetry.ts](scripts/telemetry.ts)
- **Reset your anonymous identity:** delete `~/.agent-flow/installation-id` —
  a fresh random UUIDv4 will be generated on next run


## License

Apache 2.0 — see [LICENSE](LICENSE) for details.

The name "Agent Flow" and associated logos are trademarks of Simon Patole. See [TRADEMARK.md](TRADEMARK.md) for usage guidelines.
