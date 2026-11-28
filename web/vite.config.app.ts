import { defineConfig } from 'vite'
import { createRequire } from 'module'
import { createBuildConfig } from './vite.config.shared'

// Commit this bundle was built from (AGENT_FLOW_BUILD_COMMIT overrides git): the page compares it with the
// relay's `server-version` message and reloads when they differ (lib/auto-reload.ts).
const { resolveBuildInfo } = createRequire(import.meta.url)('../scripts/build-info.js')
const build = resolveBuildInfo()

export default defineConfig(createBuildConfig({
  outDir: '../app/dist/webview',
  entry: 'app-entry.tsx',
  name: 'AgentFlowApp',
  define: {
    'process.env.NEXT_PUBLIC_DEMO': '"0"',
    'process.env.NEXT_PUBLIC_RELAY_PORT': '""',
    'process.env.AGENT_FLOW_STANDALONE': '"1"',
    'process.env.NEXT_PUBLIC_BUILD_COMMIT': JSON.stringify(build.commit),
  },
}))
