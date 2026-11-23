import { createRequire } from 'node:module'

// Git branch + commit (AGENT_FLOW_BUILD_BRANCH / AGENT_FLOW_BUILD_COMMIT override),
// inlined at build time and rendered as <meta name="build-branch|build-commit"> by app/layout.tsx.
const { resolveBuildInfo } = createRequire(import.meta.url)('../scripts/build-info.js')
const build = resolveBuildInfo()

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  env: {
    NEXT_PUBLIC_BUILD_BRANCH: build.branch,
    NEXT_PUBLIC_BUILD_COMMIT: build.commit,
  },
}

export default nextConfig
