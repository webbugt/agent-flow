# CLAUDE.md

Agent Flow: real-time visualization of Claude Code, Codex and Hermes agent orchestration. A pnpm monorepo: VS Code extension, Next.js web app (single-session canvas and Fleet map), and a standalone relay app (`npx agent-flow-app`). License Apache-2.0. See README.md for features and relay options.

## Commands

Package manager is pnpm (CI uses pnpm 10, Node 22). Install with `pnpm install --frozen-lockfile`.

- `pnpm test`: root tests (`scripts/**`, `app/src/**`) then web tests (`web/hooks/**`, `web/lib/**`). Node test runner through `tsx`.
- `pnpm --dir extension test`: extension tests (`extension/test/**/*.test.ts`).
- `pnpm --filter agent-flow run lint`: extension typecheck (`tsc --noEmit`). Despite the name it is not a linter.
- `pnpm --dir web exec tsc --noEmit`: web typecheck.
- `pnpm run dev`: relay (port 3001) plus web dev server. `pnpm run dev:demo`: web only, demo data.
- `pnpm run build:web`, `build:extension`, `build:webview`, `build:all`, `build:app`: builds. Builds record git branch and commit (see README "Which build is running").
- `pnpm run shot`, `shot:diff`, `shot:smoke`: screenshot scripts (`scripts/shot*.ts`).

CI (`.github/workflows/ci.yml`) runs: `pnpm test`, extension tests, extension typecheck, web typecheck. A change is ready only when all four pass.

There is no ESLint, Prettier or `tsc` script at the repo root. Do not invent or run them.

## Layout

- `extension/`: VS Code extension and hook server (`extension/src`, tests in `extension/test`). Costs config in `costs-config.ts`, schema `costs.schema.json`.
- `web/`: Next.js app. `web/lib/fleet/` holds the Fleet model (edge life, kanban and supermemory sources, selection and timeline prefs). `web/hooks/` holds simulation hooks. `web/lib/content-privacy.ts` holds the anonymizing default.
- `scripts/`: relay and tooling (`hermes-transcript.ts`, relay build, shots).
- `app/`: standalone relay app (`app/build.js`, `app/src`).

## Conventions

- TypeScript throughout. Match the style of the neighbouring file; do not reformat code you are not changing.
- Tests sit next to the code (`*.test.ts`) in `web/lib`, `web/hooks`, `scripts`, `app/src`; extension tests are in `extension/test`. Add or update a test with each behaviour change.
- Keep logic pure and testable (see `web/lib/fleet/fleet-edge-life.ts`); keep exports and existing tests green when generalizing.
- Client settings live in localStorage under namespaced keys. Do not add new keys; the planned options registry owns them (key `agentflow.options.v1`).
- Docs: user-facing changes go in README.md and `extension/CHANGELOG.md` (Unreleased).

## Testing

- Run the commands under "Commands" yourself and read the output. Do not report a test as passing unless you ran it.
- Quote the real command and the tail of the real output in handoffs.
- Existing Fleet v2 tests (edge life, kanban-source, fleet-model) must keep passing.

## Resource blocks (planned feature, branch feature/resource-blocks)

Kinds: `kanban`, `memory`, `bash`, `subsystem`. A block is relevant while `now - lastUsedAt < linger(kind) + fade`. Opacity 1 during linger, then linear fade.

- Linger defaults: kanban 90 s, memory 60 s, bash 20 s, subsystem 45 s. Fade 15 s after linger. `0` hides immediately. Pin keeps a block visible.
- Linger, fade and per-kind show/hide (single and fleet views separately) are configurable in an options panel that also holds the other client-side settings.
- Bash blocks show the command head only (`git`, `pnpm`, `hermes`). Inspection shows the full command. Known secret patterns (tokens, passwords, Authorization headers, credentials in URLs, API keys) are masked even in inspection.
- Memory blocks show the container tag only. Never show memory content. `personal-*` projects are visible only to the owner.
- Kanban blocks show board slug, status counts and event kinds only. Never task bodies, comments or results. Keep `taskTitle`, `taskId` and assignee out of block data.
- Do not show or log message text from gateway inbound lines.

## Safety

- Do not restart or stop any service (relay on port 3001, proxy on port 3301, dashboards) unless the task explicitly allows it.
- Do not push to any remote. Do not merge to main.
- Do not run `git worktree remove` or delete branches.
- Work only in the worktree named on your task. Do not edit other worktrees.
- No global installs. Do not commit secrets, tokens or machine-private paths.
- Hermes `state.db` and Kanban databases are read-only inputs: SELECT only.

## Do not

- Do not invent commands, scripts or tools that are not in a `package.json` or CI.
- Do not add CLAUDE.md or other instruction files to feature branches; they live on `docs/claude-md`.
- Do not copy eVisitBB or FF5 specific rules, i18n, API or mobile guidance into this repo.
- Do not change hardcoded behaviour in `fleet-edge-life.ts` without keeping its current exports and tests.
