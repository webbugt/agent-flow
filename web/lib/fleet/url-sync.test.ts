import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildUrlSearch, commitChange, readUrlState, replaceUrlState, resolveUrlState, syncOnLoad, type UrlParamSpecs, type UrlTarget } from './url-sync'

// A made-up state with a non-boolean option, to show the helper is not tied to the view options.
interface S { mode: 'a' | 'b'; zoom: number }
const specs: UrlParamSpecs<S> = {
  mode: { param: 'mode', parse: r => (r === 'a' || r === 'b' ? r : undefined), format: v => v },
  zoom: { param: 'z', parse: r => { const n = Number(r); return r && Number.isInteger(n) && n >= 1 && n <= 9 ? n : undefined }, format: v => String(v) },
}

test('readUrlState keeps only valid values', () => {
  assert.deepEqual(readUrlState('?mode=b&z=3', specs), { mode: 'b', zoom: 3 })
  assert.deepEqual(readUrlState('?mode=c&z=12', specs), {})
  assert.deepEqual(readUrlState(undefined, specs), {})
})

test('resolveUrlState: URL wins, storage fills the rest', () => {
  assert.deepEqual(resolveUrlState<S>({ mode: 'a', zoom: 2 }, { zoom: 5 }), { mode: 'a', zoom: 5 })
})

test('syncOnLoad saves only the values the URL changed', () => {
  const saved: string[] = []
  const persist = { mode: (v: S['mode']) => saved.push(`mode=${v}`), zoom: (v: number) => saved.push(`zoom=${v}`) }
  assert.deepEqual(syncOnLoad<S>('?mode=a&z=4', { mode: 'a', zoom: 2 }, specs, persist), { mode: 'a', zoom: 4 })
  assert.deepEqual(saved, ['zoom=4'])
  assert.deepEqual(syncOnLoad<S>('?mode=zzz', { mode: 'b', zoom: 2 }, specs, persist), { mode: 'b', zoom: 2 })
  assert.deepEqual(saved, ['zoom=4'])
})

test('buildUrlSearch appends missing keys, replaces present ones, keeps the rest', () => {
  assert.equal(buildUrlSearch<S>('?x=1&mode=a', { mode: 'b', zoom: 3 }, specs), '?x=1&mode=b&z=3')
  assert.equal(buildUrlSearch<S>('', { mode: 'a', zoom: 1 }, specs), '?mode=a&z=1')
})

test('commitChange saves the changed option, then writes the URL once', () => {
  const calls: string[] = []
  const w: UrlTarget = {
    location: { pathname: '/', search: '?mode=a', hash: '' },
    history: { state: null, replaceState: (_s, _u, url) => { calls.push(String(url)) } },
  }
  const saved: number[] = []
  assert.equal(commitChange<S, 'zoom'>(w, { mode: 'a', zoom: 7 }, 'zoom', specs, { zoom: v => saved.push(v) }), true)
  assert.deepEqual(saved, [7])
  assert.deepEqual(calls, ['/?mode=a&z=7'])
  assert.equal(replaceUrlState(w, { mode: 'a', zoom: 7 }, specs), true) // location.search is a plain field here, not updated
})
