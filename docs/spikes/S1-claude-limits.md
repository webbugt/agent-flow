# S1 spike: does Claude Code expose `rate_limits` (statusLine, hooks) or a Fable bucket?

Task: t_34bafcf5 (Costs S1) · Author: omh-researcher · Date: 2026-11-25
Worktree: `/home/idv/workspace/agent-flow-costs`, branch `feature/configurable-costs`

## STATUS: DONE (live capture 2026-11-25, Claude Code 2.1.326). One `get_usage` probe was deliberately NOT run; plan type was not visible.

Part 1 (t_34bafcf5, omh-researcher) had no terminal and wrote the desk research, host-file evidence and helper scripts.
Part 2 (t_a52a9f58, omh-coder) ran the capture: **Run A** (`claude -p ... --output-format stream-json --verbose`, haiku, one prompt)
and **Run B** (interactive TUI in a pty, haiku, one prompt, `/exit`). Two prompts in total, both
"Reply with the single word ok". Samples in sections 2.2, 3.4 and 3.5 are **real, redacted** payloads. Where a claim was not
re-observed it keeps its `[DOC]`/`[SRC]` label. Deviation from the section 6 recipe: both runs added `--setting-sources ""`
so the user's own `~/.claude/settings.json` hooks (agent-flow `hook.js`, which posts to the relay) did not fire; auth is unaffected.
Section 4 (`get_usage`) is still `[SRC]` only: not run, not allowed by any orchestrator comment.

Evidence labels: **[DOC]** vendor documentation fetched today · **[SRC]** source file read on this host today ·
**[OBS-file]** observed by reading a file on this host (no process run) · **[OBS-live]** observed from a real `claude 2.1.326` run
on this host today · **[UNOBSERVED]** not captured · **[INFER]** inference.

## 1. Answers, with confidence

| Question | Answer now | Basis | Still needed |
|---|---|---|---|
| (a) Does the `statusLine` stdin JSON contain `rate_limits.five_hour` / `rate_limits.seven_day`? | **YES, observed.** `rate_limits.five_hour` and `.seven_day`, each `{used_percentage: number 0-100, resets_at: epoch seconds}`. **Absent in the first statusLine call** of a session (before any API response); present from the next call. **Interactive TUI only: the statusLine never fired in `-p` mode.** | [OBS-live] + [DOC] | none |
| (a2) Any Fable / per-model key in `statusLine`? | **NO, observed.** No key or value mentions fable, opus, sonnet or any per-model window. Only `model.id` / `model.display_name` (the model in use). | [OBS-live] (2 samples) | none |
| (b) Do hook payloads contain `rate_limits`? | **NO, observed** for `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` (the 4 that fired in both runs). `PreToolUse`/`PostToolUse`/`Notification`/`SubagentStop` did not fire (no tool use, no subagent): **not observed**, [DOC] lists none. | [OBS-live] + [DOC] | optional: tool-using run |
| (c) Any other limits channel? | **YES, new finding:** in `-p --output-format stream-json`, a `{"type":"rate_limit_event"}` line carries `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization,resetsAt,status}` (utilization is a **0-1 fraction**, `resetsAt` epoch seconds). Also no Fable/per-model window. Not documented on the statusline page. | [OBS-live] | none |
| Is Fable observable? | **Not through `statusLine`, hooks or the stream-json `rate_limit_event`** (all observed, none mention it). The only evidence of a Fable bucket is the undocumented `get_usage` channel (section 4, fixture-only, **not run**), plus a TUI banner (section 3.6). Webbugt's decision 4 needs to rule on that channel. | [OBS-live] + [SRC] | live `get_usage` answer, only if allowed |

## 2. `statusLine` (documented schema)

Source: https://code.claude.com/docs/en/statusline.md (fetched 2026-11-25; the extractor returned an abridged
page, so only the quoted fragments below are confirmed).

### 2.1 What the page says about limits [DOC]

- The status line is a shell command; **JSON arrives on stdin**; stdout is shown.
- The page's own example "Rate limit usage" reads exactly these paths:
  - `rate_limits.five_hour.used_percentage`
  - `rate_limits.seven_day.used_percentage`
  - gateway-only: `rate_limits.spend_limit.used_percentage`, `.used_usd`, `.limit_usd`, `.period`
    (the field table says these "can be absent" and need Claude Code v2.1.284+ on both Claude Code and the gateway).
- The example reads every level defensively (`data.rate_limits?.five_hour?.used_percentage`, Python
  `rate.get('five_hour', {})`), i.e. **`rate_limits` and each window can be absent**. P6a must treat them as optional.
- The prompt-cache section states: "Timestamps are Unix epoch seconds, the same unit as `rate_limits.*.resets_at`".
  So **`resets_at` is epoch seconds (number)** [DOC]. `used_percentage` is a percentage, example code prints it
  with `:.0f`, so it is a number, probably 0-100 [INFER until a sample].
- Other fields the page documents that matter for costing: `model.id`, `model.display_name`, `session_id`,
  `transcript_path`, `version`, `cost.total_cost_usd` ("computed client-side at list price ... may differ from your
  actual bill"), `context_window.*`, `exceeds_200k_tokens`, `fast_mode`.

### 2.2 REAL statusLine sample [OBS-live]

Claude Code 2.1.326, interactive TUI, `--model haiku`, key order as emitted. Redacted: `session_id`/`prompt_id` -> `<uuid>`,
`transcript_path` -> `<transcript_path>`, scratch paths -> `<scratch>`. No email, org or account id was present in the payload.
Everything else is verbatim. Two calls were captured in the run (one at startup, one after the reply).

**Call 1 (startup, before any API response): NO `rate_limits`, no `prompt_id`, no `prompt_cache`, `current_usage: null`**

```json
{"session_id":"<uuid>","transcript_path":"<transcript_path>","cwd":"<scratch>/work","scratchpad_dir":"<scratchpad_dir>",
 "effort":{"level":"medium"},"model":{"id":"claude-haiku-5-5","display_name":"Haiku 5.5"},
 "workspace":{"current_dir":"<scratch>/work","project_dir":"<scratch>/work","added_dirs":[]},
 "version":"2.1.326","output_style":{"name":"default"},
 "cost":{"total_cost_usd":0,"total_duration_ms":879,"total_api_duration_ms":0,"total_lines_added":0,"total_lines_removed":0},
 "context_window":{"total_input_tokens":0,"total_output_tokens":0,"context_window_size":1000000,"current_usage":null,"used_percentage":null,"remaining_percentage":null},
 "exceeds_200k_tokens":false,"fast_mode":false,"thinking":{"enabled":true}}
```

**Call 2 (after the reply): `rate_limits` present**

```json
{"session_id":"<uuid>","transcript_path":"<transcript_path>","cwd":"<scratch>/work","scratchpad_dir":"<scratchpad_dir>","prompt_id":"<uuid>",
 "effort":{"level":"medium"},"session_name":"Single word reply",
 "model":{"id":"claude-haiku-5-5","display_name":"Haiku 5.5"},
 "workspace":{"current_dir":"<scratch>/work","project_dir":"<scratch>/work","added_dirs":[]},
 "version":"2.1.326","output_style":{"name":"default"},
 "cost":{"total_cost_usd":0.00249547,"total_duration_ms":8791,"total_api_duration_ms":2106,"total_lines_added":0,"total_lines_removed":0},
 "context_window":{"total_input_tokens":37762,"total_output_tokens":4,"context_window_size":1000000,
   "current_usage":{"input_tokens":2,"output_tokens":4,"cache_creation_input_tokens":10483,"cache_read_input_tokens":27277},
   "used_percentage":4,"remaining_percentage":96},
 "exceeds_200k_tokens":false,
 "prompt_cache":{"warm":true,"caching_observed":true,"ttl":"1h","expires_at":1795613131,"requests":1,"misses":0,"expected_rebuilds":0,
   "hit_ratio":0.7223399184365235,"cache_write_tokens":10483,"miss_recache_tokens":0,"last_miss_at":null,"last_miss_cause":null,
   "miss_causes":{},"recache_tokens_if_cold":37762},
 "fast_mode":false,"thinking":{"enabled":true},
 "rate_limits":{"five_hour":{"used_percentage":9,"resets_at":1795626000},"seven_day":{"used_percentage":8,"resets_at":1796097600}}}
```

Facts read off the samples:
- `rate_limits.<window>.used_percentage` is a **number in 0-100** (integer in this sample); `resets_at` is **epoch seconds** (number). Both windows were present together.
- `rate_limits` sits **last** in the object and is **absent in call 1**. Consumers must treat a missing `rate_limits` as "unknown", never 0.
- The `spend_limit` sub-object ([DOC], gateway only) was **not present** (subscription login, no gateway).
- `cost.total_cost_usd` is the client-side list-price figure (0.0025 for this one trivial haiku turn; the TUI used a 1M-token context window).
- `rate_limits` looks account-wide, not per-session [INFER]: 9 %/8 % after a ~38k-token haiku turn, matching the stream-json `rate_limit_event` seen a minute earlier (8 %/8 %, section 3.4b).

Key tree of both calls merged (types only; produced by `keytree.js`): `session_id, transcript_path, cwd, scratchpad_dir, prompt_id, effort.level,
session_name, model.{id,display_name}, workspace.{current_dir,project_dir,added_dirs[]}, version, output_style.name,
cost.{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added,total_lines_removed},
context_window.{total_input_tokens,total_output_tokens,context_window_size,current_usage(null|{input_tokens,output_tokens,cache_creation_input_tokens,cache_read_input_tokens}),used_percentage(null|number),remaining_percentage(null|number)},
exceeds_200k_tokens, prompt_cache.{warm,caching_observed,ttl,expires_at,requests,misses,expected_rebuilds,hit_ratio,cache_write_tokens,miss_recache_tokens,last_miss_at,last_miss_cause,miss_causes,recache_tokens_if_cold},
fast_mode, thinking.enabled, rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}`.
No key contains `fable`, `opus`, `sonnet`, `model_limits` or any per-model window.

**statusLine in `-p` mode: did NOT fire** in Run A (0 `statusline-*.json` files; hooks did fire). It fired only in the TUI (Run B): once at startup and once after the single reply (2 calls total; frequency beyond that was not measured).

### 2.3 Fable / per-model key [DOC + OBS-live]

No model-specific window (`seven_day_fable`, `seven_day_opus`, ...) appears in the extracted page, and **none appears in the
two live payloads of 2.2 (observed, `grep -i fable|opus|sonnet` over every captured statusLine and hook file returned nothing)**.
Caveat: the capture used a haiku session; a session on Opus or Fable was not run (cheapest-model rule), so a model-conditional
key cannot be fully excluded [INFER: unlikely, `rate_limits` is account-level]. The v2 plan already cites third-party issue requests for a Fable bucket
(`PLAN-configurable-costs-v2.md` section 6.3).

## 3. Hook payloads

### 3.1 Documentation [DOC]

https://code.claude.com/docs/en/hooks.md (fetched 2026-11-25). Events listed there include `SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `StopFailure`, `SessionEnd`, `Notification` and more.
A search of the extracted text (about 107 KB) for `rate_limit`, `five_hour`, `seven_day`, `resets_at`, `fable`
found **0 matches**. This is weak evidence: the extractor is lossy (a search for `session_id` in the same text also
found 0 matches although every hook payload has it), so it does **not** prove absence.

### 3.2 Host evidence: how agent-flow receives hooks today [SRC / OBS-file]

- `/home/idv/.claude/settings.json` registers the agent-flow command hook for exactly 9 events:
  `SessionStart, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Notification, Stop, SessionEnd`.
  Command shape: `"node" "/home/idv/.claude/agent-flow/hook.js"`. **`UserPromptSubmit` is not registered.**
- The same file has **no `statusLine` key** (search for `statusLine` returned 0 matches today). So the chained
  wrapper (plan P6a) has nothing to chain on this host right now; the "refuse to install if it cannot chain safely"
  rule is only exercised by a fixture here.
- `/home/idv/.claude/agent-flow/hook.js` (v3) forwards the **entire raw stdin body unmodified** to the extension
  (`req.write(input)`), after reading only `cwd`. So whatever fields Claude Code puts in a hook payload reach the
  extension. If hooks carried `rate_limits`, the extension would already receive it; whether `extension/src` reads
  it is a separate code question that was not inspected.

### 3.3 Answer

(b) hooks contain `rate_limits`: **NO.** Observed on `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd` in both runs (8 payloads; none has `rate_limits`,
none mentions fable/opus/sonnet). `PreToolUse`, `PostToolUse`, `Notification`, `SubagentStop` never fired (the prompt used no tool and no subagent), so they are
**not observed**; [DOC] lists no limits field for them either. Also `Stop` carries no usage/cost/token fields, so token counts cannot come from hooks.

### 3.4 Real hook samples [OBS-live]

Redaction as in 2.2 (`<uuid>`, `<transcript_path>`, `<scratch>`). `prompt` text and `last_assistant_message` are the trivial test strings.

`UserPromptSubmit` (TUI; `-p` run is identical minus `scratchpad_dir`, and `permission_mode` was `default` instead of `auto`):

```json
{"session_id":"<uuid>","transcript_path":"<transcript_path>","cwd":"<scratch>/work","scratchpad_dir":"<scratchpad_dir>",
 "prompt_id":"<uuid>","permission_mode":"auto","hook_event_name":"UserPromptSubmit","prompt":"Reply with the single word ok"}
```

`Stop` (TUI):

```json
{"session_id":"<uuid>","transcript_path":"<transcript_path>","cwd":"<scratch>/work","scratchpad_dir":"<scratchpad_dir>",
 "prompt_id":"<uuid>","permission_mode":"auto","effort":{"level":"medium"},"hook_event_name":"Stop","stop_hook_active":false,
 "last_assistant_message":"ok","background_tasks":[],"session_crons":[]}
```

`SessionStart` (TUI): `{session_id, transcript_path, cwd, scratchpad_dir, hook_event_name:"SessionStart", source:"startup", model:"claude-haiku-5-5"}`
(in `-p` mode: no `model`, no `scratchpad_dir`). `SessionEnd` (TUI): `{session_id, transcript_path, cwd, scratchpad_dir, prompt_id, hook_event_name:"SessionEnd", reason:"prompt_input_exit"}`
(`-p` mode: `reason:"other"`).

Key tree of all hook payloads merged (types only): `background_tasks[], cwd, effort.level, hook_event_name, last_assistant_message, model, permission_mode, prompt, prompt_id,
reason, scratchpad_dir, session_crons[], session_id, source, stop_hook_active, transcript_path`. **No `rate_limits`, no `model` on Stop/UserPromptSubmit, no cost or token keys.**

### 3.4b stream-json (`-p`) has a `rate_limit_event` [OBS-live]

Run A emitted 6 lines: `system/hook_started`, `system/hook_response`, `system/init`, `assistant`, **`rate_limit_event`**, then `result`. Event types seen:
`system`, `assistant`, `rate_limit_event`, `result`; the only one mentioning rate limits is `rate_limit_event` (plus the `rate_limit_info` key). The event, redacted (`uuid`/`session_id` -> `<uuid>`):

```json
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1795626000,"rateLimitType":"five_hour",
 "overageStatus":"rejected","overageDisabledReason":"out_of_credits","isUsingOverage":false,
 "unifiedWindows":{"five_hour":{"utilization":0.08,"resetsAt":1795626000,"status":"allowed"},
                   "seven_day":{"utilization":0.08,"resetsAt":1796097600,"status":"allowed"}}},
 "uuid":"<uuid>","session_id":"<uuid>"}
```

- `utilization` is a **0-1 fraction** (0.08 = 8 %), unlike the statusLine's 0-100 `used_percentage`. `resetsAt` is epoch seconds and **equals** the statusLine `resets_at` values of 2.2 (1795626000 / 1796097600).
- `rateLimitType:"five_hour"` names the window the event is about; only `five_hour` and `seven_day` exist under `unifiedWindows`. **No per-model / Fable window.**
- The stream `init` line also carries `claude_code_version:"2.1.326"`, `apiKeySource:"none"` (OAuth login), `credential_expires_at` (a timestamp string: **not recorded here**), and the `modelUsage.<model>.{costUSD,costBasis:"list",provider:"firstParty",...}` map on the `result` line. No plan/subscription key appears anywhere in the stream (key tree checked).
- This channel works **without a statusLine and without a TTY**, so it is the only observed limits source in non-interactive/automation use. It is **undocumented** on the pages fetched in part 1 [INFER from the fetch; not re-checked], so treat it like any other versioned CLI output, not a contract.

### 3.5 Hooks fire in `-p` mode; user-level hooks would too

All four events fired in Run A (`-p`). With the user's real `~/.claude/settings.json` active, the agent-flow `hook.js` would also receive these, as before.

### 3.6 TUI banner mentioning Fable [OBS-live, UI text only]

At TUI startup (Run B), Claude Code printed: "Fable 5.2 is here for your longest and toughest coding tasks. It draws down usage faster than Opus 5.5. Switch with /model."
This shows the Fable model exists on this account and has its own usage-drain rate; it is **not** a limit value and not a payload key.

## 4. A different channel that DOES expose a Fable bucket: Claude Code `get_usage` control request

Found while looking for host evidence, in the Hermes provider plugin on this host (read-only):
`/home/idv/.hermes/profiles/omh-researcher/plugins/claude-subscription-directsdk-experimental/`
(`directsdk_setup.py:289-333`, `__init__.py:27-78`, `tests/test_directsdk_account_usage.py`). [SRC]

How it works [SRC]:
1. Spawn `claude -p --input-format stream-json --output-format stream-json --verbose --tools "" --setting-sources "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --disable-slash-commands --no-session-persistence` with `ANTHROPIC_BASE_URL` pointed at a local gate that refuses inference (zero inference).
2. Write one stdin line: `{"type":"control_request","request_id":"hermes-usage","request":{"subtype":"get_usage","skip_behaviors":true}}`.
3. Read the `control_response` with the same `request_id`. The CLI uses **its own login**; the plugin never reads or sends the token (the plugin's tests assert this).

Answer shape the plugin parses [SRC; the sample values are the plugin's **test fixture**, not a measured payload]:

```jsonc
{ "type": "control_response", "response": { "subtype": "success", "request_id": "hermes-usage",
  "response": {
    "subscription_type": "max",            // plan type: visible here, null when no login
    "rate_limits_available": true,
    "rate_limits": { "limits": [
      { "kind": "session",      "percent": 45, "resets_at": "2026-10-01T07:09:00Z" },
      { "kind": "weekly_all",    "percent": 23, "resets_at": "2026-10-02T06:59:00Z" },
      { "kind": "weekly_model",  "percent": 17, "resets_at": "2026-10-02T06:59:00Z",
        "scope": { "model": { "display_name": "Fable" } } }      // <- Fable weekly bucket
    ] },
    "session": {}, "behaviors": null } } }
```

Older answers use top-level windows `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet` with `utilization` and `resets_at`, plus `extra_usage`
(`is_enabled, used_credits, monthly_limit, currency`) [SRC, fixture]. The plugin's comment calls it "the `/api/oauth/usage` shape" and notes
"Measured on 2.1.302: with nonessential traffic off the CLI answers `rate_limits: null`" [SRC] (so at least one live measurement exists).

Implications for the plan [INFER]:
- This channel would make Fable **observable and exact** (not estimate-only), and would give the plan type. It needs a spawned `claude` process per query (about 1 s-8 s timeout) and returns data only while `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is unset.
- It is **undocumented** (not on the statusline or hooks pages; behaviour and shape can change per version). It is a control-protocol message through the CLI, **not** a direct call to the HTTP endpoint, and no token is read. Whether that falls under Webbugt's decision 4 ("undocumented usage endpoint is OUT") is **a decision for Webbugt/orchestrator**. This spike did **not** use it and no code uses it.
- Until ruled otherwise, P6a stays on the documented `statusLine` path and the Fable row stays estimate-only (decision 1).

## 5. Host facts relevant to the capture

| Fact | Value | Label |
|---|---|---|
| Installed `claude --version` (`/home/idv/.local/bin/claude`) | `2.1.326 (Claude Code)` | [OBS-live] |
| Claude Code version recorded in a Hermes-spawned session file on this host (session started 2026-11-23, entrypoint `hermes-agent`) | `2.1.325` (file `/home/idv/.claude/sessions/4084586.json`) | [OBS-file]; older than today's install |
| A different Claude Code build is also running on this host (VS Code extension) | `2.1.332` (path `.../anthropic.claude-code-2.1.332-linux-x64/...`, seen in `ps`) | [OBS-live]; not the CLI used here |
| Plugin comment measuring an older CLI | `2.1.302` | [SRC] |
| `~/.claude/settings.json` hooks | 9 events, all `hook.js`; no `statusLine` | [OBS-file] |
| Plan type | **Not visible** in statusLine, hooks, stream-json (key tree checked) or the TUI start screen (grep for Pro/Max/Team/Enterprise: 0 hits). `max` in section 4 is only a plugin **test fixture**. `apiKeySource:"none"`, `overageDisabledReason:"out_of_credits"` only say: OAuth login, no extra-usage credits. | [OBS-live]: not available without `get_usage` or credentials |
| Credentials | `~/.claude/.credentials.json` exists; **not read** | policy |

## 6. Capture procedure for the follow-up card (needs a terminal)

Helpers are in `docs/spikes/s1-capture/` (`capture-statusline.js`, `capture-hook.js`, `keytree.js`). **Copy them to a scratch dir and run
there**; `out/` is git-ignored but raw payloads hold `session_id` and `transcript_path`. Do not edit `~/.claude/settings.json`, do not read
`.credentials.json`, no HTTP calls to Anthropic, at most one trivial prompt on the cheapest model.

```bash
S=$HOME/.hermes/cache/scratch/s1-capture; mkdir -p $S/bin $S/work
cp <worktree>/docs/spikes/s1-capture/*.js $S/bin/
NODE=$(command -v node)
# $S/settings.json: statusLine {type:command, command:"$NODE $S/bin/capture-statusline.js"} and command hooks
# "$NODE $S/bin/capture-hook.js" for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Notification, Stop, SubagentStop, SessionEnd.
claude --version                                   # record exact output
cd $S/work
# Run A: non-interactive. Does statusLine fire in -p mode? Do hooks fire? Is there a rate_limit event in the stream?
claude -p "Reply with the single word ok" --model haiku --settings $S/settings.json \
  --output-format stream-json --verbose > $S/out/stream.jsonl 2> $S/out/stream.err
# Run B: interactive TUI in a pty (statusLine normally only renders there): send the one prompt, wait for the reply
# and for statusline-*.json, then /exit. Answer the trust-folder prompt for $S/work only.
node $S/bin/keytree.js $S/out/statusline-*.json     # key tree, no values
node $S/bin/keytree.js $S/out/hook-Stop-*.json $S/out/hook-UserPromptSubmit-*.json
node $S/bin/keytree.js $S/out/stream.jsonl          # look for any *rate_limit* event type
```

Record, redacted (`<uuid>`, `<transcript_path>`, `<redacted>`): version; key tree; one full sample per hook event; the last statusline sample;
and whether `rate_limits` appears in the first statusline call (an earlier research note says it is absent before the first API response and only on Pro/Max-type plans; the first half is now **confirmed live**, see 2.2; the plan-type condition was not tested: only this one login was available).

Optional, only if the orchestrator confirms Webbugt allows reading it for a **spike**, never for product code: send the `get_usage` line from section 4 to a `claude -p --input-format stream-json` process and record the answer shape and `subscription_type`. Default: skip it.

## 7. Capture results (filled 2026-11-25; originally the UNOBSERVED table)

Both runs used `--setting-sources ""` (see STATUS). The helper scripts ran unchanged. Run B used `/home/idv/.hermes/profiles/omh-coder/cache/scratch/s1-capture/bin/run_tui.py` (a pty driver kept outside the repo; it answered no trust prompt, none appeared).

| Cell | Result |
|---|---|
| `claude --version` today | **`2.1.326 (Claude Code)`** |
| statusLine fires in `-p` mode (Y/N) | **N.** 0 statusLine files in Run A although all 4 hooks fired. Fires in the interactive TUI (2 calls in Run B). |
| statusLine `rate_limits.five_hour.{used_percentage,resets_at}` present, units, example | **Present from the 2nd call.** `used_percentage` number 0-100 (`9`), `resets_at` epoch seconds (`1795626000`). **Absent in the FIRST call** (startup, before any API response). |
| statusLine `rate_limits.seven_day.*` present | **Yes, same as above** (`8`, `1796097600`). |
| Any per-model / Fable key in statusLine | **No.** Key tree has no fable/opus/sonnet/per-model key; value grep over both files empty. (Haiku session only.) |
| `rate_limits` in `Stop` payload | **No** (TUI and `-p`). |
| `rate_limits` in `UserPromptSubmit` payload | **No** (TUI and `-p`). |
| `rate_limits` in the other hook events | `SessionStart`, `SessionEnd`: **No.** `PreToolUse`, `PostToolUse`, `Notification`, `SubagentStop`: **not fired, not observed**. |
| Any `rate_limit*` event in stream-json | **Yes: `{"type":"rate_limit_event"}`**, with `rate_limit_info.unifiedWindows.{five_hour,seven_day}.{utilization 0-1,resetsAt,status}` (section 3.4b). No Fable/per-model window in it. |
| Plan type visible | **No** (section 5). |
| `get_usage` control request | **Not run** (no orchestrator comment allowed it; task default is skip). Section 4 stays `[SRC]`/fixture-only. |
| Leftover processes | None from this capture (both runs exited; `ps` shows only unrelated VS Code and Hermes `claude` processes). |
| Cost of the capture | 2 prompts on haiku (`claude-haiku-5-5`); Run B ~38k context tokens, list-price `total_cost_usd` 0.0025 (Run A cost not recorded). |

## 8. What P6a can rely on today

- **Can read (observed on 2.1.326):** `statusLine` stdin `rate_limits.five_hour` and `rate_limits.seven_day` (`used_percentage` 0-100, `resets_at` epoch seconds), plus `model.id`, `session_id`, `version`, `cost.total_cost_usd`. **Interactive TUI only**, and **absent in the first call** of a session, so treat missing as "unknown", never as 0, and expect the first value only after the first API response.
- **Also observed (undocumented):** stream-json `rate_limit_event` in `-p` runs (utilization is a 0-1 fraction there). Not usable by the statusLine wrapper; relevant only if agent-flow ever ingests stream-json.
- **Cannot read:** a Fable (or any per-model) bucket, a plan type, or any limit from hooks. Hook payloads (4 of 8 events observed) carry no `rate_limits` and no token/cost fields.
- **Design consequence:** P6a-A11 stands: **hooks do not carry `rate_limits`, so the chained statusLine wrapper is required** and must tolerate (1) no `rate_limits` on call 1, (2) no statusLine at all for `-p`/headless sessions, (3) this host currently having no `statusLine` to chain. Fable stays estimate-only under decision 1 unless Webbugt allows the `get_usage` channel (a scope change needing an explicit decision; it would also reveal the plan type).
