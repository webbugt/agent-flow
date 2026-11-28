# Demo page (`/demo`)

The visualiser on synthetic events and resources, with a control panel. It has its own data: it never reads or writes
live sessions, the relay or the event stream.

## Open it

- Built app: `pnpm build:app && node app/dist/app.js --port 3100 --no-open`, then open `http://127.0.0.1:3100/demo`
  (the app server answers `/demo` with the same page as `/`; the bundle mounts the demo view by path).
  Use a scratch port: the live relay is on 3001.
- Next dev: `pnpm dev:web` (or `cd web && NEXT_PUBLIC_DEMO=0 npx next dev -p 3100`), then `http://localhost:3100/demo`.

The page makes no `/events` or `/api/fleet` request (the Network tab shows only the page, CSS and JS).

## Panel

| Section | What it does |
|---|---|
| Mode | Resource-anchor mode on/off (the same option as the top bar's *Anchors*). |
| Session | One tab per profile name (`<profile> · demo`, colour from the profile palette). *Start session* adds an agent node to the profile's tab. |
| Events | For the chosen node: tool call, tool return (ok / error), permission wait, dispatch / return a subagent, done. |
| Resources | Add a Kanban board, Supermemory container, Bash command head or subsystem (`cron`, `gateway`); the chosen node uses it once. *Use* moves the chosen node's use to another resource; × removes it. |
| Reset | Clears sessions, events and resources. |

Resources carry names only (board slug, container tag, command head, subsystem), never task or memory text.

## Code

- `web/lib/demo/demo-state.ts`: pure reducer (no React, clock or randomness) producing the same event shapes the live bridge delivers.
- `web/hooks/use-demo-bridge.ts`: the demo's `BridgeHookResult` (same shape as `useVSCodeBridge`).
- `web/components/agent-visualizer/visualizer-view.tsx`: the former `AgentVisualizer`, now taking its bridge as a prop; `index.tsx` (live) and `demo-visualizer.tsx` (demo) wrap it.
- `web/lib/demo/demo-isolation.test.ts`: guard that the demo source reaches neither the live bridge modules nor any network API.
