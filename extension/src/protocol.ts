/**
 * Message protocol between VS Code extension host and webview.
 *
 * Extension → Webview: agent events, state updates, connection status
 * Webview → Extension: user commands (inject, connect/disconnect)
 */

import type { PromptBucket } from './spend-tiers'

// ─── Agent Event Types (from real agent sessions) ────────────────────────────

export type AgentEventType =
  | 'agent_spawn'
  | 'agent_complete'
  | 'agent_idle'
  | 'message'
  | 'context_update'
  | 'model_detected'
  | 'tool_call_start'
  | 'tool_call_end'
  | 'subagent_dispatch'
  | 'subagent_return'
  | 'permission_requested'
  | 'error'

export interface AgentEvent {
  time: number
  type: AgentEventType
  /** tool_call_start / tool_call_end carry `toolUseId` (Claude tool_use id, Codex call_id)
   *  when the source has one, so the web view can match parallel calls to the same tool. */
  payload: Record<string, unknown>
  sessionId?: string
}

export interface SessionInfo {
  id: string
  label: string
  status: 'active' | 'completed'
  startTime: number
  lastActivityTime: number
  /** Listed from history only (Hermes profile with recent sessions, nothing live): fleet view only, no tab. */
  idle?: boolean
}

// ─── Extension → Webview Messages ────────────────────────────────────────────

export type ExtensionToWebviewMessage =
  | { type: 'connection-status'; status: 'connected' | 'disconnected' | 'watching'; source: string }
  | { type: 'agent-event'; event: AgentEvent }
  | { type: 'agent-event-batch'; events: AgentEvent[] }
  | { type: 'reset'; reason: string }
  | { type: 'config'; config: Partial<VisualizerConfig> }
  | { type: 'session-list'; sessions: SessionInfo[] }
  | { type: 'session-started'; session: SessionInfo }
  | { type: 'session-ended'; sessionId: string }
  | { type: 'session-updated'; sessionId: string; label: string }
  | { type: 'costs-config'; costs: CostsConfigPayload }
  | { type: 'costs-config-write-result'; requestId: string; ok: boolean; error?: string; /** The file changed since the drawer loaded it. */ conflict?: boolean; /** Version of the file just written. */ fingerprint?: string }
  | { type: 'limits-update'; limits: LimitsUpdatePayload }
  | { type: 'statusline-action-result'; requestId: string; action: 'install' | 'uninstall'; ok: boolean; message: string }

// ─── Observed limits (task P6a; the host reads ~/.agent-flow/limits/claude.json, see limits-observer.ts) ───

export type ObservedWindowKind = 'five_hour' | 'seven_day' | 'other'

/** One window of the account's usage meter as Claude Code reported it (numbers only). */
export interface ObservedLimitWindow {
  /** Key in Claude Code's `rate_limits` (`five_hour`, `seven_day`, ...). */
  key: string
  kind: ObservedWindowKind
  /** Used percentage 0-100; null when unknown or when the window has ended (`expired`). */
  usedPct: number | null
  /** End of the window, ms epoch; null when the reading did not carry it. */
  resetsAt: number | null
  /** `fresh`: recent reading. `stale`: the reading is old (show `as of`). `expired`: `resetsAt` has passed, no value. */
  state: 'fresh' | 'stale' | 'expired'
}

/**
 * The `limits-update` message body. Mirror of `LimitsUpdatePayload` in web/lib/costs/observed-types.ts.
 * `observed` is null when there is no reading (wrapper not installed, or no reading yet): the UI then falls back
 * to estimates. No transcript, prompt, path or credential is ever part of it.
 */
export interface LimitsUpdatePayload {
  version: 1
  /** Increases on every change the host publishes. */
  seq: number
  provider: 'claude'
  source: 'statusline'
  /** The host can install / remove the wrapper when the person clicks in the UI. */
  canConfigure: boolean
  install: {
    state: 'not-installed' | 'installed' | 'refused' | 'broken'
    /** An install would succeed right now. */
    canInstall: boolean
    /** Why an install was refused, or what is broken. Plain text, never file content. */
    reason?: string
    code?: string
    /** Project settings files (home shown as `~`) whose own statusLine hides the wrapper inside that project. */
    shadowedBy?: string[]
    warnings?: string[]
  }
  observed: null | {
    /** When Claude Code reported the numbers (ms epoch). */
    at: number
    /** The reading is older than the freshness limit: show `as of HH:MM`, tag `stale`. */
    stale: boolean
    modelId?: string
    windows: ObservedLimitWindow[]
  }
  /** The limits file exists but cannot be used (not JSON, wrong version, too large). No content is quoted. */
  fileError?: string
}

// ─── Costs config (the host reads files, the webview validates; see web/lib/costs/layers.ts) ───

/** Lowest precedence first: VS Code scalar settings, the user's costs.json, the project's .agent-flow/costs.json. */
export type CostsLayerId = 'settings' | 'user' | 'project'

/** One config source as the host read it. Mirror of `CostsLayer` in web/lib/costs/layers.ts. */
export interface CostsConfigLayer {
  id: CostsLayerId
  /** Display path (home shown as `~`); null for the VS Code settings layer. */
  path: string | null
  status: 'ok' | 'missing' | 'error'
  /** Parsed JSON object. Present when status is `ok`, or `error` with `stale` (the host's last good copy). */
  raw?: Record<string, unknown>
  /** `raw` is the previous good content because the file now fails to read or parse. */
  stale?: boolean
  /** Host-side problem: unreadable, too large, not JSON, not an object, resolves outside its directory. */
  error?: string
  /** Host-side notes, e.g. an ignored key. */
  warnings?: string[]
  /**
   * Version of the file's bytes (SHA-256 prefix) when they were read, also for a file that does not parse.
   * Absent for the settings layer, a missing file (the version is then `missing`) and a file that could not be read.
   * The settings drawer sends it back with a save; the host refuses the write if the file no longer has it.
   */
  fingerprint?: string
}

/** The `costs-config` message body. Mirror of `CostsConfigPayload` in web/lib/costs/layers.ts. */
export interface CostsConfigPayload {
  version: 1
  /** Increases on every change the host publishes. */
  seq: number
  /** VS Code setting `agentVisualizer.costs.enabled`; false = built-in pricing, files ignored. */
  enabled: boolean
  layers: CostsConfigLayer[]
}

export interface VisualizerConfig {
  mode: 'live' | 'replay'
  autoPlay: boolean
  showMockData: boolean
  disable1MContext: boolean
}

// ─── Webview → Extension Messages ────────────────────────────────────────────

export type WebviewToExtensionMessage =
  | { type: 'ready' }
  | { type: 'request-connect' }
  | { type: 'request-disconnect' }
  | { type: 'open-file'; filePath: string; line?: number }
  | { type: 'open-costs-config' }
  /** Opt-in: install / remove the chained Claude statusLine wrapper. The host asks the person to confirm. */
  | { type: 'statusline-action'; requestId: string; action: 'install' | 'uninstall' }
  /** Settings drawer save: the host validates the shape, writes the file atomically (0600) and reloads. */
  | { type: 'write-costs-config'; requestId: string; layer: 'user' | 'project'; doc: unknown; /** Fingerprint of the file version `doc` was edited from; required. */ base: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }

// ─── Transcript Types (from Claude Code JSONL files) ─────────────────────────

export interface TranscriptEntry {
  sessionId: string
  type: string
  uuid?: string
  message: {
    role: string
    model?: string
    content: Array<TranscriptContentBlock> | string
  }
}

export interface ToolUseBlock {
  type: 'tool_use'
  name: string
  id: string
  input: Record<string, unknown>
}

export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ text?: string; type?: string }>
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export type TranscriptContentBlock =
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | TextBlock
  | { type: string; [key: string]: unknown }

// ─── Shared Helpers ─────────────────────────────────────────────────────────

/** Minimal emitter interface used by {@link emitSubagentSpawn}. */
export interface AgentEventEmitter {
  emit(event: AgentEvent, sessionId?: string): void
  elapsed(sessionId?: string): number
}

/**
 * Emit the paired subagent_dispatch + agent_spawn events.
 *
 * This two-event sequence is required every time a subagent is spawned and was
 * previously duplicated in SessionWatcher and TranscriptParser.
 */
export function emitSubagentSpawn(
  emitter: AgentEventEmitter,
  parent: string,
  child: string,
  task: string,
  sessionId?: string,
): void {
  emitter.emit({
    time: emitter.elapsed(sessionId),
    type: 'subagent_dispatch',
    payload: { parent, child, task },
  }, sessionId)
  emitter.emit({
    time: emitter.elapsed(sessionId),
    type: 'agent_spawn',
    payload: { name: child, parent, task },
  }, sessionId)
}

// ─── Shared Internal Types ───────────────────────────────────────────────────

/** A tool call that has started but not yet received its result */
export interface PendingToolCall {
  name: string
  args: string
  filePath?: string
  startTime: number
}

// ─── Session Types ──────────────────────────────────────────────────────────

export interface SubagentState {
  watcher: import('fs').FSWatcher | null
  fileSize: number
  /** Incomplete trailing JSONL record carried between reads. */
  fileTail: string
  agentName: string
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  permissionTimer: NodeJS.Timeout | null
  permissionEmitted: boolean
  spawnEmitted: boolean
  /** Node has been completed (Workflow subagents complete when their Workflow
   *  tool_result arrives). Cleared if the transcript starts growing again. */
  completed: boolean
}

/** State tracked for a single watched Claude Code session */
export interface WatchedSession {
  sessionId: string
  filePath: string
  fileWatcher: import('fs').FSWatcher | null
  pollTimer: NodeJS.Timeout | null
  fileSize: number
  /** Incomplete trailing JSONL record carried between reads. */
  fileTail: string
  sessionStartTime: number
  pendingToolCalls: Map<string, PendingToolCall>
  seenToolUseIds: Set<string>
  seenMessageHashes: Set<string>
  sessionDetected: boolean
  sessionCompleted: boolean
  lastActivityTime: number
  inactivityTimer: NodeJS.Timeout | null
  subagentWatchers: Map<string, SubagentState>
  /** Names of subagents already spawned (by transcript parser or file watcher) — prevents duplicate spawns */
  spawnedSubagents: Set<string>
  /** Subagent names currently receiving inline progress events — file watcher skips these */
  inlineProgressAgents: Set<string>
  subagentsDirWatcher: import('fs').FSWatcher | null
  subagentsDir: string | null
  label: string
  labelSet: boolean
  model: string | null
  /** Maps agent names to their last emitted model ID — re-emits on model change */
  modelDetectedAgents: Map<string, string>
  permissionTimer: NodeJS.Timeout | null
  permissionEmitted: boolean
  contextBreakdown: {
    systemPrompt: number
    userMessages: number
    toolResults: number
    reasoning: number
    subagentResults: number
  }
  /** Real billed usage per agent (summed from assistant message.usage) */
  spendByAgent: Map<string, SpendTotals>
  /** Claude message ids whose usage has already been counted */
  seenUsageIds: Set<string>
}

/** Token counts of one kind of usage (the flat part of `SpendTotals`). */
export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Cache writes with the default 5-minute TTL */
  cacheWrite5mTokens: number
  /** Cache writes with the 1-hour TTL (billed at a higher rate) */
  cacheWrite1hTokens: number
}

/**
 * Busy time of a local-model session in one UTC hour (key of `EnergyUsage.byHour` = hours since the epoch).
 * Mirror of web/lib/costs/types.ts (the extension cannot import from web/). `busySec` is overlap-split device
 * load time; the page prices it with the watts, throughput and tariff of the CURRENT config.
 */
export interface EnergyHour {
  busySec: number
  callSec: number
  calls: number
  untimedCalls: number
  untimedInTok: number
  untimedOutTok: number
}

export interface EnergyUsage {
  v: 1
  byHour: Record<string, EnergyHour>
}

/** Cumulative billed token counts for one agent, as reported by the API */
export interface SpendTotals extends TokenCounts {
  /** Last real model id seen for this agent */
  model?: string
  /**
   * Provider id of the latest call: `anthropic` for Claude Code transcripts, the Hermes
   * `provider=` value for Hermes (`copilot`, `claude-subscription-directsdk-experimental`,
   * `ollama`, ...). One value per agent, like `model`: an agent that switched provider keeps
   * the latest. Absent for runtimes that report none.
   */
  provider?: string
  /**
   * The same totals split by the prompt size of each request (see spend-tiers.ts). The buckets
   * sum to the flat totals above. Absent when the ledger saw no per-request usage.
   */
  byBucket?: Partial<Record<PromptBucket, TokenCounts>>
  /** API calls counted into these totals */
  calls?: number
  /** Calls that reported a latency (<= `calls`; Claude Code transcripts report none) */
  timedCalls?: number
  /** Sum of the reported per-call latencies, in seconds */
  latencySeconds?: number
  /** Hour-bucketed busy time of a local model (Hermes relay only); priced client-side, see web/lib/costs/energy.ts */
  energy?: EnergyUsage
}

// ─── Claude Settings Types ──────────────────────────────────────────────────

export interface ClaudeHookDef {
  type?: string
  url?: string
  command?: string
  timeout?: number
}

export interface ClaudeHookEntry {
  hooks?: ClaudeHookDef[]
}

