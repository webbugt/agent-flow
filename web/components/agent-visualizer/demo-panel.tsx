'use client'

import { useMemo, useState } from 'react'
import { DEMO_PANEL_GAP, DEMO_PANEL_WIDTH } from '@/lib/demo/demo-feed'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { profileColor } from '@/lib/fleet/anchor-mode'
import { getOptions, updateOptions } from '@/lib/options-store'
import { useOptions } from '@/hooks/use-options'
import type { DemoHandle } from '@/hooks/use-demo-bridge'
import {
  RESOURCE_KINDS, canSubagentReturn, demoNodeChoices, normaliseProfile, normaliseResourceKey,
  type ResourceKind, type SupermemoryCall,
} from '@/lib/demo/demo-state'
import {
  DEMO_PROFILE_PRESETS, DEMO_TOOL_PRESETS, RESOURCE_DEFAULT_KEYS, RESOURCE_KEY_LABELS, RESOURCE_KIND_LABELS,
} from '@/lib/demo/demo-presets'

const field: React.CSSProperties = {
  background: 'rgba(255,255,255,0.05)', border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, color: COLORS.textPrimary,
  padding: '3px 6px', fontFamily: 'inherit', fontSize: 11, minWidth: 0,
}
const button: React.CSSProperties = {
  color: COLORS.complete, border: `1px solid ${COLORS.glassBorder}`, borderRadius: 4, padding: '3px 8px', fontSize: 11,
  background: 'rgba(255,255,255,0.04)', cursor: 'pointer', whiteSpace: 'nowrap',
}
const hint: React.CSSProperties = { color: COLORS.textMuted, fontSize: 9 }

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={{ borderTop: `1px solid ${COLORS.glassBorder}`, padding: '8px 0' }}>
      <h3 style={{ margin: '0 0 5px', color: COLORS.textMuted, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase' }}>{title}</h3>
      {note && <p style={{ ...hint, margin: '0 0 5px' }}>{note}</p>}
      {children}
    </section>
  )
}

function Btn({ id, onClick, disabled, children, tone }: { id: string; onClick: () => void; disabled?: boolean; children: React.ReactNode; tone?: string }) {
  return (
    <button
      type="button" data-testid={id} onClick={onClick} disabled={disabled}
      style={{ ...button, color: tone ?? button.color, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}
    >
      {children}
    </button>
  )
}

function Dot({ color }: { color: string }) {
  return <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: '50%', background: color, boxShadow: `0 0 4px ${color}`, flexShrink: 0 }} />
}

export interface DemoPanelProps {
  demo: DemoHandle
  /** Opens the tab of a profile session (the tab strip does the same). */
  onSelectSession: (sessionId: string) => void
  selectedSessionId: string | null
  /** Folded or open: the map reserves the panel's width while it is open. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Control panel of the /demo route (D2, D3, D6): fire each event type for a chosen session, create a session per
 * profile (palette colour), add / use / remove resources, switch anchor mode, reset. Everything goes through
 * `demo.dispatch`: the panel holds no data of its own beyond what is typed in its fields.
 */
export function DemoPanel({ demo, onSelectSession, selectedSessionId, open, onOpenChange }: DemoPanelProps) {
  const options = useOptions()
  const { state, dispatch } = demo
  const [profileText, setProfileText] = useState<string>(DEMO_PROFILE_PRESETS[0])
  const [tool, setTool] = useState<string>(DEMO_TOOL_PRESETS[0])
  const [args, setArgs] = useState('')
  const [kind, setKind] = useState<ResourceKind>('kanban')
  const [keys, setKeys] = useState<Record<ResourceKind, string>>({ ...RESOURCE_DEFAULT_KEYS })
  const [memoryCall, setMemoryCall] = useState<SupermemoryCall>('search')
  const [targetValue, setTargetValue] = useState<string>('')

  const colorOf = (profile: string) => profileColor(profile, options.profilePalette, options.profileColors)
  const profile = normaliseProfile(profileText)
  const choices = useMemo(() => demoNodeChoices(state), [state])
  const active = choices.filter(c => c.status === 'active')
  // The chosen node while it is active, else the newest active node of the open tab (what you are looking at), else the newest active one.
  const inOpenTab = active.filter(c => c.sessionId === selectedSessionId)
  const target = active.find(c => c.value === targetValue) ?? inOpenTab[inOpenTab.length - 1] ?? active[active.length - 1]
  const at = target ? { sessionId: target.sessionId, node: target.node } : null
  // A subagent returns itself; a session node returns its newest active subagent. Disabled when there is nothing to return.
  const canReturn = target !== undefined && canSubagentReturn(state, target.sessionId, target.node)
  const key = keys[kind]
  const keyOk = normaliseResourceKey(kind, key) !== null

  const useResource = (k: ResourceKind, rkey: string) => {
    if (at) dispatch({ type: 'resource_use', ...at, kind: k, key: rkey, call: k === 'memory' ? memoryCall : undefined })
  }

  return (
    <aside
      data-testid="demo-panel"
      className="glass-card"
      style={{
        // The Fleet map and timeline reserve this width (demoPanelInset), so their controls sit left of the panel, not under it.
        position: 'fixed', right: DEMO_PANEL_GAP / 2, top: 'max(3rem, calc(var(--af-top-bar-bottom, 0px) + 8px))', zIndex: Z.controlBar + 1,
        width: open ? `min(${DEMO_PANEL_WIDTH}px, calc(100vw - ${DEMO_PANEL_GAP}px))` : 'auto', maxHeight: 'calc(100vh - 4rem)', overflowY: 'auto',
        padding: '8px 10px', fontSize: 11, color: COLORS.textPrimary, fontFamily: "'SF Mono', 'Fira Code', monospace",
      }}
    >
      <div className="flex items-center gap-2" style={{ justifyContent: 'space-between' }}>
        <span style={{ color: COLORS.tool, letterSpacing: 1, fontSize: 10 }}>DEMO · synthetic data</span>
        <button type="button" data-testid="demo-toggle" style={{ ...button, padding: '1px 6px' }} onClick={() => onOpenChange(!open)} aria-expanded={open}>
          {open ? '–' : '+'}
        </button>
      </div>
      {open && (
        <>
          <p style={{ ...hint, margin: '4px 0 0' }}>
            Own data: nothing here reads or writes live sessions, the relay or the event stream.
          </p>

          <Section title="Mode">
            <label className="flex items-center gap-2" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox" data-testid="demo-anchor" checked={options.anchorMode}
                onChange={() => updateOptions({ anchorMode: !getOptions().anchorMode })}
              />
              <span>Resource-anchor mode</span>
            </label>
          </Section>

          <Section title="Session" note="One session tab per profile; each start adds an agent node to it.">
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
              <input
                list="demo-profiles" data-testid="demo-profile" value={profileText} onChange={e => setProfileText(e.target.value)}
                style={{ ...field, width: 110, ...(profile === null ? { borderColor: '#ff6677' } : {}) }} aria-label="profile name"
              />
              <datalist id="demo-profiles">{DEMO_PROFILE_PRESETS.map(p => <option key={p} value={p} />)}</datalist>
              {profile !== null && <Dot color={colorOf(profile)} />}
              <Btn id="demo-session-start" disabled={profile === null} onClick={() => profile !== null && dispatch({ type: 'session_start', profile })}>
                Start session
              </Btn>
            </div>
            {state.sessions.length > 0 && (
              <ul data-testid="demo-sessions" style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
                {state.sessions.map(s => (
                  <li key={s.id} className="flex items-center gap-2" style={{ padding: '1px 0' }}>
                    <Dot color={colorOf(s.profile)} />
                    <button
                      type="button" data-testid={`demo-open-${s.profile}`} onClick={() => onSelectSession(s.id)}
                      style={{ color: s.id === selectedSessionId ? COLORS.holoBright : COLORS.textDim, background: 'none', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}
                    >
                      {s.profile}
                    </button>
                    <span style={hint}>{s.nodes.filter(n => n.status === 'active').length}/{s.nodes.length} active · {s.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Events" note={active.length === 0 ? 'Start a session first.' : undefined}>
            <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
              <select
                data-testid="demo-target" value={target?.value ?? ''} onChange={e => setTargetValue(e.target.value)}
                disabled={active.length === 0} style={{ ...field, flex: 1 }} aria-label="target node"
              >
                {active.map(c => <option key={c.value} value={c.value}>{c.kind === 'subagent' ? '↳ ' : ''}{c.node}</option>)}
              </select>
              {target && <Dot color={colorOf(target.profile)} />}
            </div>
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
              <select data-testid="demo-tool" value={tool} onChange={e => setTool(e.target.value)} style={field} aria-label="tool">
                {DEMO_TOOL_PRESETS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <input
                data-testid="demo-args" value={args} onChange={e => setArgs(e.target.value)} placeholder="arguments (default)"
                style={{ ...field, flex: 1 }} aria-label="tool arguments"
              />
            </div>
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
              <Btn id="demo-tool-call" disabled={!at} onClick={() => at && dispatch({ type: 'tool_call', ...at, tool, args })}>Tool call</Btn>
              <Btn id="demo-tool-return" disabled={!at} onClick={() => at && dispatch({ type: 'tool_return', ...at })}>Tool return</Btn>
              <Btn id="demo-tool-error" disabled={!at} tone={COLORS.error} onClick={() => at && dispatch({ type: 'tool_return', ...at, isError: true })}>Return error</Btn>
              <Btn id="demo-permission" disabled={!at} tone={COLORS.waiting_permission} onClick={() => at && dispatch({ type: 'permission_wait', ...at })}>Permission wait</Btn>
              <Btn id="demo-subagent-dispatch" disabled={!at} tone={COLORS.dispatch} onClick={() => at && dispatch({ type: 'subagent_dispatch', ...at })}>Dispatch subagent</Btn>
              <Btn id="demo-subagent-return" disabled={!at || !canReturn} tone={COLORS.dispatch} onClick={() => at && dispatch({ type: 'subagent_return', ...at })}>Subagent return</Btn>
              <Btn id="demo-done" disabled={!at} tone={COLORS.holoBase} onClick={() => at && dispatch({ type: 'done', ...at })}>Done</Btn>
            </div>
          </Section>

          <Section
            title="Resources"
            note="Add registers it and the target node uses it once. A removed resource leaves the map when its linger and fade run out (Options)."
          >
            <div className="flex items-center gap-2" style={{ flexWrap: 'wrap', marginBottom: 6 }}>
              <select
                data-testid="demo-resource-kind" value={kind} onChange={e => setKind(e.target.value as ResourceKind)} style={field} aria-label="resource kind"
              >
                {RESOURCE_KINDS.map(k => <option key={k} value={k}>{RESOURCE_KIND_LABELS[k]}</option>)}
              </select>
              {kind === 'subsystem' ? (
                <select
                  data-testid="demo-resource-key" value={key} onChange={e => setKeys(p => ({ ...p, subsystem: e.target.value }))}
                  style={field} aria-label={RESOURCE_KEY_LABELS[kind]}
                >
                  <option value="cron">cron</option>
                  <option value="gateway">gateway</option>
                </select>
              ) : (
                <input
                  data-testid="demo-resource-key" value={key} onChange={e => setKeys(p => ({ ...p, [kind]: e.target.value }))}
                  placeholder={RESOURCE_KEY_LABELS[kind]} aria-label={RESOURCE_KEY_LABELS[kind]}
                  style={{ ...field, flex: 1, ...(keyOk ? {} : { borderColor: '#ff6677' }) }}
                />
              )}
              <Btn
                id="demo-resource-add" disabled={!at || !keyOk}
                onClick={() => at && dispatch({ type: 'resource_add', kind, key, ...at, call: kind === 'memory' ? memoryCall : undefined })}
              >
                Add + use
              </Btn>
            </div>
            <label className="flex items-center gap-2" style={{ marginBottom: 4 }}>
              <span style={hint}>Supermemory call</span>
              <select data-testid="demo-memory-call" value={memoryCall} onChange={e => setMemoryCall(e.target.value as SupermemoryCall)} style={field}>
                <option value="search">search</option>
                <option value="store">store</option>
                <option value="forget">forget</option>
              </select>
            </label>
            {state.resources.length > 0 && (
              <ul data-testid="demo-resources" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {state.resources.map(r => (
                  <li key={`${r.kind}:${r.key}`} className="flex items-center gap-2" style={{ padding: '1px 0' }}>
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      <span style={hint}>{RESOURCE_KIND_LABELS[r.kind]} </span>{r.key}
                    </span>
                    <Btn id={`demo-resource-use-${r.kind}-${r.key}`} disabled={!at} onClick={() => useResource(r.kind, r.key)}>Use</Btn>
                    <Btn id={`demo-resource-remove-${r.kind}-${r.key}`} tone={COLORS.error} onClick={() => dispatch({ type: 'resource_remove', kind: r.kind, key: r.key })}>×</Btn>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Reset">
            <Btn id="demo-reset" tone={COLORS.error} onClick={() => dispatch({ type: 'reset' })}>Reset demo</Btn>
            <span style={{ ...hint, marginLeft: 6 }}>clears sessions, events and resources</span>
          </Section>
        </>
      )}
    </aside>
  )
}
