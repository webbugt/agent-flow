import { DEFAULT_RELAY_PORT } from '../../extension/src/constants'

/** Parse CLI arguments. Keeps it simple — no dependencies. */
export function parseArgs(argv: string[]) {
  let port = DEFAULT_RELAY_PORT
  let open = true
  let verbose = false
  /** Value of the anonymize setting from the command line; undefined = not given (env var, then default applies) */
  let anonymizeContent: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      const n = parseInt(argv[i + 1], 10)
      if (!isNaN(n) && n > 0 && n < 65536) port = n
      i++
    } else if (arg === '--no-open') {
      open = false
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--show-content') {
      anonymizeContent = 'none'
    } else if (arg === '--anonymize-content') {
      // Bare flag: everyone. `--anonymize-content hestia,sophia` is also accepted.
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        anonymizeContent = next
        i++
      } else {
        anonymizeContent = 'all'
      }
    } else if (arg.startsWith('--anonymize-content=')) {
      anonymizeContent = arg.slice('--anonymize-content='.length) || 'all'
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: agent-flow [options]

Options:
  -p, --port <number>  Port for the server (default: ${DEFAULT_RELAY_PORT})
  --no-open            Don't open the browser automatically
  -v, --verbose        Show detailed event logs
  --anonymize-content[=<all|none|profile,profile>]
                       Show structure only (command names, sizes, paths) instead of content,
                       for all profiles, none, or only the listed Hermes profiles.
                       Default: AGENT_FLOW_ANONYMIZE_CONTENT, else full content (none)
  --show-content       Same as --anonymize-content=none
  -h, --help           Show this help message
`)
      process.exit(0)
    }
  }

  return { port, open, verbose, anonymizeContent }
}
