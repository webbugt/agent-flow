# Screenshot harness

Every task that changes the UI proves it with screenshots taken by this harness
(`scripts/shot.ts`), not by hand. It starts the **built** app on a scratch port with an isolated
`HOME` and synthetic fixture sessions, drives headless `/usr/bin/google-chrome` over the DevTools
protocol, writes PNGs and kills everything it started.

No new dependency: Chrome is driven by a small CDP client on Node's global `WebSocket`
(Node >= 22; checked on v26). `puppeteer-core` is not installed in this repo and is not needed.

## Quick start

```sh
pnpm shot:smoke                      # cost overlay, desktop + phone -> docs/screenshots/smoke/
pnpm shot --task-id t_xxxxxxxx --plan builtin:h0
pnpm shot --task-id t_xxxxxxxx --name cost-tooltip --key '$' --hover pill:first --wait 300
pnpm shot:diff dirA dirB             # pixel diff of two runs (determinism check, default max 0.1 %)
```

Output: `docs/screenshots/<task-id>/<NN>-<slug>-<desktop|phone>[-hover].png`, one path per line at the
end of the run. `pnpm shot` rebuilds `app/dist` first (`pnpm run build:app`); pass `--no-build` to
reuse an existing build. Folder `smoke/` is scratch (do not commit it); task folders are committed.

| | desktop | phone |
|---|---|---|
| viewport | 1440x900 | 390x844 (mobile emulation, touch) |
| device scale | 2 (PNG is 2880x1800) | 2 (780x1688) |

## What it does, step by step

1. Refuses ports 3001 (relay) and 3301 (proxy); without `--port` it picks a free one.
2. Creates a temp dir under `$TMPDIR`; `HOME` and `AGENT_FLOW_HERMES_ROOT` point into it, telemetry is off.
   Nothing in the real `~/.claude`, `~/.hermes` or `~/.agent-flow` is read or written.
3. Writes fixture data (below), starts `node app/dist/app.js --port N --no-open`, waits for `/health`
   (the line `app up on ... (build <branch> @ <commit>)` shows which build was shot).
4. Hermes fixtures: the log watcher only reads **appended** lines, so the harness appends them after the app is up.
5. Opens `http://127.0.0.1:N/?shot=1` in a fresh Chrome tab per screenshot, waits for the top bar and for the
   agent count to stop changing, freezes the simulation and waits for the camera to settle.
6. Selects the default session tab (see `--session`), runs the shot's steps, waits 250 ms, captures.
7. Cleanup on every exit path (success, error, Ctrl-C): SIGTERM then SIGKILL to the app and Chrome process
   groups, temp dir removed (`--keep-temp` keeps it), and it prints `cleanup done, port N closed` after
   checking the port is free.

## `?shot=1` (screenshot mode)

Only with `?shot=1` in the URL (see `web/lib/shot-mode.ts`, covered by `web/lib/shot-mode.test.ts`;
without it nothing changes): `Math.random` is seeded, the canvas uses a fixed clock (no pulsing, drifting
or fading), the camera snaps to its fit instead of easing, and `window.__AF_TEST__` is installed:

| member | meaning |
|---|---|
| `ready` | true once the page is frozen |
| `agentNames()` | agent names on the canvas |
| `agentRect(name)` | viewport rect of an agent node; `first` = first agent |
| `pillRect(name)` | viewport rect of an agent's cost pill (cost overlay on); `first` = first agent that has a pill |
| `freeze()` / `settled()` | pause the simulation / camera has stopped moving |
| `setPanel(name)` | open `files`, `transcript`, `cost` or `session` |

Test ids on the page: `top-bar`, `cost-toggle`, `fleet-toggle`. The ids named in plan section 7.3
(`cost-tooltip`, `fable-estimate-tooltip`, `est-icon`, `limits-panel`, ...) belong to elements that do not
exist yet; each UI task adds its own and uses them with `--hover '[data-testid=...]'`.

## Steps (one-shot flags or JSON plan)

One-shot flags run in the order given: `--key <c>` (press a key; `$` toggles the cost overlay),
`--click <t>`, `--hover <t>` (mouse, desktop), `--tap <t>` (touch, phone only), `--wait <ms>`,
`--wait-for <css>`. A plan step `{ "config": "C-eur" }` rewrites the scratch `~/.agent-flow/costs.json` to a C-* fixture while the page stays open (hot reload; `C-default` deletes the file). Built-in plan `builtin:hotreload` is the costs P3 pair. A target `<t>` is one of:

- a CSS selector (`[data-testid="cost-toggle"]`)
- `agent:first` or `agent:<name>`: an agent node
- `pill:first` or `pill:<name>`: a cost pill on the canvas
- `text:<label>`: first visible button/tab whose text contains the label (scrolled into view first)
- `x,y`: viewport coordinates in CSS pixels

A plan file is `{ "shots": [ { "name": "slug", "viewports": ["desktop"], "steps": [ {"key":"$"}, {"hover":"pill:first"}, {"wait":300} ] } ] }`
(`--plan file.json`). Step objects have exactly one key: `key`, `click`, `hover`, `tap`, `wait`, `waitFor`, `eval`, `config`.
Files are numbered in plan order across viewports; `--start-index` continues a numbering. Names get `-hover`
appended when the steps contain a hover.

Built-in plans: `builtin:overlay` (what `pnpm shot:smoke` runs) and `builtin:h0` (the harness self-test of
task H0: overlay off/on, agent hover, agent tap on the phone, pill hover and the Fable, Copilot and local sessions).

## Options

`--task-id` (required) · `--plan` · `--viewports desktop,phone` · `--scenario costs|all|claude|hermes` ·
`--session <label|none>` · `--port` · `--limits L-1..L-4` · `--config C-default|C-eur|C-invalid|C-custom-price|C-local-energy` ·
`--out` · `--start-index` · `--no-build` · `--keep-temp` · `-v`. `pnpm shot --help` prints the list.

`--session`: the page shows one session at a time, and which one it shows depends on which events arrive
last, so unselected runs are not repeatable. The harness therefore clicks a session tab first: by default
`Fixture F-A` (Claude fixtures) or the first Hermes title. Pass `--session "Copilot Demo"` for another, or
`none` to keep what the page chose.

`--limits` and `--config` write the L-n / C-name fixtures to `~/.agent-flow/limits/claude.json` and
`~/.agent-flow/costs.json` of the scratch HOME. The app does not read them until the limits and config tasks land.

## Fixtures (`scripts/shot-fixtures/index.ts`)

All synthetic: invented profile names, session ids, titles and prompts; no tokens, hostnames or real text
(`scripts/shot.test.ts` greps them for key/token/e-mail/home-path patterns).

| id | what | scenario `costs` |
|---|---|---|
| F-A | Claude Code transcript, Sonnet 5.5, API billing, cache reads and writes | yes (tab `Fixture F-A`) |
| F-B | Hermes profile `sub-demo`, provider `claude-subscription-directsdk-experimental`, Opus 5.5 | yes (`Sub Demo`) |
| F-C | Haiku 5.5, calls at 90K and 120K prompt tokens | `all` only |
| F-D | Fable 5.2 transcript (the "Fable used" session) | yes (`Fixture F-D`) |
| F-E | Hermes `copilot-demo`, provider `copilot`: haiku-5.5, gemini-3.8-flash (cache), gpt-6.1-sol | yes (`Copilot Demo`) |
| F-F | Hermes `local-demo`, provider `ollama` with latency | yes (`Local Demo`) |
| F-G | Hermes `unknown-demo`, model `acme-xyz-9` (unpriced) | `all`, `hermes` |
| F-H | Claude transcript with no usage (context-size estimate path) | `all` only |
| L-1..L-4 | limits file variants | with `--limits` |
| C-* | cost config variants | with `--config` |

**Watcher behaviour (H0-A7, `scripts/hermes-logs.ts` `discover`).** A Hermes profile's `agent.log` is read from
its **end** the moment the watcher first sees it; lines already in the file are not replayed. `state.db`'s
`sessions` table is read at discovery and gives idle nodes with no usage. So usage reaches the UI only via lines
appended after the relay started (the harness does that). Claude Code transcripts are the opposite: existing
content is pre-scanned when the session file is first attached, so they are written before the app starts.

## Determinism (H0-A5)

Two runs of the same plan are compared with `pnpm shot:diff <dirA> <dirB>`; the limit is 0.1 % of pixels.
Remaining differences are the live clock text in the playback bar. Cost values come from fixed token counts and
do not change between runs.

## Rules for task screenshots

1. Use this harness, not hand-made captures. Save under `docs/screenshots/<task-id>/`.
2. Attach every file to the kanban card: `hermes kanban attach <task_id> <file>`.
3. Look at every PNG (vision) and write what you saw next to the acceptance item it proves.
4. Never include real prompts, ids or credentials. The fixtures are synthetic; for a real-data screenshot
   (deploy task) redact first.

## Troubleshooting

- `Chrome not found`: set `AGENT_FLOW_SHOT_CHROME`. If Chrome refuses to start as root or in a container,
  set `AGENT_FLOW_SHOT_NO_SANDBOX=1`.
- `timed out ... the top bar`: run with `-v` to see the app and page console; the error also prints page state.
- Port in use: omit `--port`.
