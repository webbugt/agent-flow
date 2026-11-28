# Demo page (`/demo`)

The visualiser on synthetic events and resources, with a control panel. It has its own data: it never reads or writes
live sessions, the relay or the event stream.

## Open it

- Built app: `pnpm build:app && node app/dist/app.js --port 3100 --no-open`, then open `http://127.0.0.1:3100/demo`
  (the app server answers `/demo` with the same page as `/`; the bundle mounts the demo view by path).
  Use a scratch port: the live relay is on 3001.
- Dev (one command): `pnpm dev:demo`, then `http://127.0.0.1:3590/demo`. It starts only the Next dev server on port 3590
  (no relay) with `NEXT_PUBLIC_DEMO=0`, the same value `pnpm dev` uses. The demo never reads the bridge, so no relay is needed.

The page makes no `/events` or `/api/fleet` request (the Network tab shows only the page, CSS and JS).

## Shared browser storage

`/demo` is served from the same origin as the live app, so it shares that origin's `localStorage` (the Options store):
Fleet and panel layout, palette and the anchor-mode toggle carry over in both directions. The selected tab is not saved.
Demo sessions, events and resources are in memory only and are lost on reload.

## Panel

| Section | What it does |
|---|---|
| Mode | Resource-anchor mode on/off (the same option as the top bar's *Anchors*). |
| Session | One tab per profile name (`<profile> · demo`, colour from the profile palette). *Start session* adds an agent node to the profile's tab. |
| Events | For the chosen node: tool call, tool return (ok / error), permission wait, dispatch / return a subagent, done. *Subagent return*: on a subagent it returns that subagent; on a session node it returns the newest active subagent; disabled when there is none. Event times are seconds since the session started. |
| Resources | Add a Kanban board, Supermemory container, Bash command head or subsystem (`cron`, `gateway`); the chosen node uses it once. *Use* moves the chosen node's use to another resource; × removes it. |
| Reset | Clears sessions, events and resources. |

Resources carry names only (board slug, container tag, command head, subsystem), never task or memory text.

## Code

- `web/lib/demo/demo-state.ts`: pure reducer (no React, clock or randomness) producing the same event shapes the live bridge delivers.
- `web/hooks/use-demo-bridge.ts`: the demo's `BridgeHookResult` (same shape as `useVSCodeBridge`).
- `web/components/agent-visualizer/visualizer-view.tsx`: the former `AgentVisualizer`, now taking its bridge as a prop; `index.tsx` (live) and `demo-visualizer.tsx` (demo) wrap it.
- `web/lib/demo/demo-isolation.test.ts`: guard that the demo source reaches neither the live bridge modules nor any network API.
