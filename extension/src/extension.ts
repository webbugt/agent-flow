import * as vscode from 'vscode'
import { VisualizerPanel } from './webview-provider'
import { JsonlEventSource } from './event-source'
import { WebviewToExtensionMessage } from './protocol'
import { startClaudeRuntime } from './claude-runtime'
import { startCodexRuntime } from './codex-runtime'
import { promptHookSetupIfNeeded, configureClaudeHooks, isDisable1MContext } from './hooks-config'
import { createLogger } from './logger'
import { CostsConfigLoader, CostsConflictError, type CostsScalars } from './costs-config'
import { LimitsObserver } from './limits-observer'
import { defaultInstallerEnv, installStatusLine, uninstallStatusLine, type ActionResult, type InstallerEnv } from './statusline-installer'
import { resolveNodePath } from './discovery'
import type { AgentRuntime, AgentRuntimeMode } from './session-runtime'

const log = createLogger('Extension')

// ─── Costs config (PLAN v2 P3) ─────────────────────────────────────────────

let costsLoader: CostsConfigLoader | undefined

/** The VS Code scalar settings the user actually set (defaults are not a layer). */
function readCostsScalars(): CostsScalars {
  const cfg = vscode.workspace.getConfiguration('agentVisualizer.costs')
  const userSet = <T>(key: string): T | undefined => {
    const i = cfg.inspect<T>(key)
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue
  }
  return {
    enabled: cfg.get<boolean>('enabled', true),
    displayCurrency: userSet<string>('displayCurrency'),
    unit: userSet<string>('unit'),
    unknownModelPolicy: userSet<string>('unknownModelPolicy'),
    configPath: cfg.get<string>('configPath', ''),
  }
}

function startCostsConfig(context: vscode.ExtensionContext): CostsConfigLoader {
  const loader = new CostsConfigLoader({
    workspaceDirs: () => (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
    scalars: readCostsScalars,
  })
  loader.onChange(costs => VisualizerPanel.getCurrent()?.postMessage({ type: 'costs-config', costs }))
  loader.start()
  context.subscriptions.push(
    { dispose: () => loader.dispose() },
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('agentVisualizer.costs')) loader.reload() }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => loader.reload()),
    vscode.commands.registerCommand('agentVisualizer.openCostsConfig', () => openCostsConfig(loader)),
  )
  return loader
}

/** Open ~/.agent-flow/costs.json (creating a minimal one when it does not exist) in an editor. */
async function openCostsConfig(loader: CostsConfigLoader): Promise<void> {
  try {
    const file = loader.ensureUserFile()
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file))
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
  } catch (err) {
    log.error('Failed to open the costs config:', err instanceof Error ? err.message : err)
    vscode.window.showErrorMessage(`Agent Flow: cannot open the costs config. ${err instanceof Error ? err.message : ''}`)
  }
}

// ─── Observed Claude limits (PLAN v2 P6a) ──────────────────────────────────

let limitsObserver: LimitsObserver | undefined

function installerEnv(): InstallerEnv {
  return defaultInstallerEnv({
    nodePath: resolveNodePath(),
    workspaceDirs: (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
  })
}

/**
 * Install / remove the chained statusLine wrapper. Both ask first: it edits ~/.claude/settings.json, which is the
 * person's file, so nothing happens on a click alone. A refusal is a normal answer, not an error.
 */
async function runStatusLineAction(action: 'install' | 'uninstall'): Promise<ActionResult | { ok: false; refused: true; code: 'cancelled'; message: string }> {
  const install = action === 'install'
  const detail = install
    ? 'Agent Flow will wrap the statusLine in ~/.claude/settings.json. Your own status line keeps running unchanged. Only the usage percentages and reset times of each limit window (5-hour, weekly and any other the meter reports), the session id, the model id and a timestamp are saved to ~/.agent-flow/limits/claude.json, plus a short history of those readings in claude-history.json next to it. No prompts or transcripts are stored. A backup is written to settings.json.agent-flow.bak. "Remove Claude statusLine wrapper" restores your original.'
    : 'Your original statusLine is put back in ~/.claude/settings.json (same content) and the saved limits file and its history file are deleted.'
  const choice = await vscode.window.showWarningMessage(
    install ? 'Observe Claude usage limits through a chained statusLine wrapper?' : 'Remove the Agent Flow statusLine wrapper?',
    { modal: true, detail },
    install ? 'Install wrapper' : 'Remove wrapper',
  )
  if (!choice) return { ok: false, refused: true, code: 'cancelled', message: 'Cancelled. Nothing was changed.' }
  const result = install ? installStatusLine(installerEnv()) : uninstallStatusLine(installerEnv())
  limitsObserver?.refresh()
  if (result.ok) void vscode.window.showInformationMessage(`Agent Flow: ${result.message}`)
  else void vscode.window.showWarningMessage(`Agent Flow: ${result.message}`)
  return result
}

function startLimitsObserver(context: vscode.ExtensionContext): LimitsObserver {
  const observer = new LimitsObserver({ env: installerEnv, canConfigure: true })
  observer.onChange(limits => VisualizerPanel.getCurrent()?.postMessage({ type: 'limits-update', limits }))
  observer.start()
  context.subscriptions.push(
    { dispose: () => observer.dispose() },
    vscode.workspace.onDidChangeWorkspaceFolders(() => observer.refresh()),
    vscode.commands.registerCommand('agentVisualizer.configureClaudeStatusLine', () => runStatusLineAction('install')),
    vscode.commands.registerCommand('agentVisualizer.removeClaudeStatusLine', () => runStatusLineAction('uninstall')),
  )
  return observer
}

type ConfiguredRuntimeMode = AgentRuntimeMode | 'auto'

let eventSource: JsonlEventSource | undefined
let runtimes: AgentRuntime[] = []

function readConfiguredMode(): ConfiguredRuntimeMode {
  const raw = vscode.workspace.getConfiguration('agentVisualizer').get<string>('runtime', 'auto')
  return raw === 'claude' || raw === 'codex' ? raw : 'auto'
}

interface StartRuntimesResult {
  runtimes: AgentRuntime[]
  failures: AgentRuntimeMode[]
}

async function startRuntimes(
  mode: ConfiguredRuntimeMode,
  context: vscode.ExtensionContext,
): Promise<StartRuntimesResult> {
  const runtimes: AgentRuntime[] = []
  const failures: AgentRuntimeMode[] = []
  if (mode === 'claude' || mode === 'auto') {
    log.info('Starting Claude runtime...')
    try { runtimes.push(await startClaudeRuntime(context)) }
    catch (err) { log.error('Claude runtime failed to start:', err); failures.push('claude') }
  }
  if (mode === 'codex' || mode === 'auto') {
    log.info('Starting Codex runtime...')
    try { runtimes.push(startCodexRuntime(context)) }
    catch (err) { log.error('Codex runtime failed to start:', err); failures.push('codex') }
  }
  return { runtimes, failures }
}

export async function activate(context: vscode.ExtensionContext) {
  log.info('Extension activated')

  costsLoader = startCostsConfig(context)
  limitsObserver = startLimitsObserver(context)

  const mode = readConfiguredMode()
  log.info(`Runtime mode: ${mode}`)
  const { runtimes: started, failures } = await startRuntimes(mode, context)
  runtimes = started
  log.info(`Active runtimes: ${runtimes.map(r => r.mode).join(', ') || 'none'}`)

  // Surface startup failures to the user — the log-only path leaves them
  // staring at a "disconnected" visualizer with no explanation.
  if (runtimes.length === 0 && failures.length > 0) {
    vscode.window.showWarningMessage(
      `Agent Visualizer: ${failures.join(' and ')} runtime${failures.length > 1 ? 's' : ''} failed to start. See the Output panel for details.`,
    )
  } else if (failures.length > 0) {
    log.info(`Partial startup — ${failures.join(', ')} failed but ${runtimes.map(r => r.mode).join(', ')} active`)
  }

  // ─── Commands ──────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.open', () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.One)
      wirePanel(panel)
      promptHookSetupIfNeededForClaude(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.openToSide', () => {
      const panel = VisualizerPanel.create(context.extensionUri, vscode.ViewColumn.Beside)
      wirePanel(panel)
      promptHookSetupIfNeededForClaude(context)
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.connectToAgent', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(radio-tower) Claude Code Hooks', description: 'Auto-configure hooks for live streaming', value: 'hooks' },
          { label: '$(file) Watch JSONL File', description: 'Watch a file for agent events', value: 'jsonl' },
          { label: '$(play) Mock Data', description: 'Use built-in demo scenario', value: 'mock' },
        ],
        { placeHolder: 'Select event source' },
      )

      if (!choice) { return }

      if (choice.value === 'hooks') {
        await configureClaudeHooks()
      } else if (choice.value === 'jsonl') {
        const fileUri = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'JSONL Files': ['jsonl', 'json', 'ndjson'] },
          title: 'Select agent event log file',
        })

        if (fileUri?.[0]) {
          connectToJsonl(fileUri[0].fsPath, context)
        }
      } else if (choice.value === 'mock') {
        const panel = VisualizerPanel.getCurrent()
        if (panel) {
          panel.postMessage({ type: 'config', config: { mode: 'replay', autoPlay: true, showMockData: true } })
        }
      }
    }),
  )

  context.subscriptions.push(
    vscode.commands.registerCommand('agentVisualizer.configureHooks', async () => {
      await configureClaudeHooks()
    }),
  )

  // ─── Serializer (restore panel on VS Code restart) ─────────────────────────

  vscode.window.registerWebviewPanelSerializer(VisualizerPanel.viewType, {
    async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel) {
      const panel = VisualizerPanel.revive(webviewPanel, context.extensionUri)
      wirePanel(panel)
    },
  })
}

/** Only prompt for Claude hook setup if a Claude runtime is active —
 *  otherwise a Codex-only user would see an irrelevant prompt. */
function promptHookSetupIfNeededForClaude(context: vscode.ExtensionContext): void {
  if (runtimes.some(r => r.mode === 'claude')) {
    promptHookSetupIfNeeded(context)
  }
}

function collectActiveSessions(): ReturnType<AgentRuntime['watcher']['getActiveSessions']> {
  const all: ReturnType<AgentRuntime['watcher']['getActiveSessions']> = []
  for (const r of runtimes) all.push(...r.watcher.getActiveSessions())
  return all
}

function replaySessions(sessionIds: string[]): void {
  for (const r of runtimes) {
    const ownIds = r.watcher.getActiveSessions()
      .map(s => s.id)
      .filter(id => sessionIds.includes(id))
    if (ownIds.length > 0) r.watcher.replaySessionStart(ownIds)
  }
}

function combinedConnectionStatus(): string {
  if (runtimes.length === 0) return 'disconnected'
  return runtimes.map(r => r.connectionStatus()).join(' + ')
}

function wirePanel(panel: VisualizerPanel): void {
  if (panel.isWired) { return }
  panel.markWired()
  let readyHandled = false
  panel.onCommand((message: WebviewToExtensionMessage) => {
    switch (message.type) {
      case 'ready':
        if (readyHandled) { return }
        readyHandled = true
        log.info('Webview ready')
        // Allow events to flow before replay — replay emits through the
        // same onEvent listener, and it's synchronous so no live events
        // can interleave. Events before this point were gated (dropped),
        // and replayExistingContent covers them from the JSONL file.
        panel.markReady()
        // Clear stale webview state from any previous panel instance
        panel.postMessage({ type: 'reset', reason: 'panel-reopened' })
        // Costs config first, so the first session render already prices with it
        if (costsLoader) panel.postMessage({ type: 'costs-config', costs: costsLoader.snapshot() })
        if (limitsObserver) panel.postMessage({ type: 'limits-update', limits: limitsObserver.refresh() })
        // Send environment-derived config (e.g. CLAUDE_CODE_DISABLE_1M_CONTEXT)
        if (isDisable1MContext()) {
          panel.postMessage({ type: 'config', config: { disable1MContext: true } })
        }
        // Report current connection status and replay active sessions
        // Send session list FIRST so the webview selects a session
        // before replay events arrive (otherwise they have no selected
        // session to match and are only buffered, not delivered).
        const sessions = collectActiveSessions()
        if (sessions.length > 0) {
          panel.postMessage({ type: 'session-list', sessions })
          replaySessions(sessions.map(s => s.id))
        }
        panel.setConnectionStatus('watching', combinedConnectionStatus())
        break

      case 'request-connect':
        vscode.commands.executeCommand('agentVisualizer.connectToAgent')
        break

      case 'request-disconnect':
        disconnectEventSource()
        panel.setConnectionStatus('disconnected', '')
        break

      case 'open-file':
        handleOpenFile(message.filePath, message.line)
        break

      case 'open-costs-config':
        if (costsLoader) void openCostsConfig(costsLoader)
        break

      case 'statusline-action': {
        const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 64) : ''
        if (message.action !== 'install' && message.action !== 'uninstall') break
        const action = message.action
        void runStatusLineAction(action).then(r => {
          panel.postMessage({ type: 'statusline-action-result', requestId, action, ok: r.ok, message: r.message })
        })
        break
      }

      case 'write-costs-config': {
        const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 64) : ''
        const reply = (ok: boolean, extra: { error?: string; conflict?: boolean; fingerprint?: string } = {}) =>
          panel.postMessage({ type: 'costs-config-write-result', requestId, ok, ...extra })
        if (!costsLoader) { reply(false, { error: 'costs config is not available' }); break }
        if (message.layer !== 'user' && message.layer !== 'project') { reply(false, { error: 'unknown layer' }); break }
        // The page must say which version of the file it edited, so a write can never replace a newer one unseen.
        if (typeof message.base !== 'string' || message.base === '' || message.base.length > 128) { reply(false, { error: 'the save did not say which version of the file it was based on' }); break }
        try {
          const written = costsLoader.writeConfig(message.layer, message.doc, message.base)
          reply(true, { fingerprint: written.fingerprint })
        } catch (err) {
          reply(false, { error: err instanceof Error ? err.message : 'write failed', ...(err instanceof CostsConflictError ? { conflict: true } : {}) })
        }
        break
      }

      case 'log': {
        const webviewLog = createLogger('Webview')
        const logFn = message.level === 'error' ? webviewLog.error
          : message.level === 'warn' ? webviewLog.warn
          : webviewLog.info
        logFn(message.message)
        break
      }
    }
  })
}

// ─── JSONL Connection ──────────────────────────────────────────────────────

function connectToJsonl(filePath: string, context: vscode.ExtensionContext): void {
  disconnectEventSource()

  eventSource = new JsonlEventSource(filePath)
  context.subscriptions.push(eventSource)

  const panel = VisualizerPanel.getCurrent()
  if (!panel) { return }

  eventSource.onEvent((event) => {
    panel.sendEvent(event)
  })

  eventSource.onStatus((status) => {
    panel.setConnectionStatus(
      status === 'connected' ? 'watching' : 'disconnected',
      filePath,
    )
  })

  eventSource.start()
}

function disconnectEventSource(): void {
  if (eventSource) {
    eventSource.dispose()
    eventSource = undefined
  }
}

// ─── File Handlers ────────────────────────────────────────────────────────

async function handleOpenFile(filePath: string, line?: number): Promise<void> {
  try {
    const uri = vscode.Uri.file(filePath)
    const doc = await vscode.workspace.openTextDocument(uri)
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
    })
    if (line && line > 0) {
      const pos = new vscode.Position(line - 1, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    }
  } catch (err) {
    log.error(`Failed to open file: ${filePath}`, err)
  }
}

export function deactivate(): void {
  disconnectEventSource()
  costsLoader?.dispose()
  costsLoader = undefined
  limitsObserver?.dispose()
  limitsObserver = undefined
  for (const r of runtimes) r.dispose()
  runtimes = []
}
