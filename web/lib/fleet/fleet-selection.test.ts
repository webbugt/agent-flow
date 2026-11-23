import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  FLEET_SELECTION_KEY, MAX_STORED_IDS, isSelected, loadSelection, parseSelection, saveSelection,
  selectAll, selectNone, serializeSelection, setMany, toggleMany, type StorageLike,
} from './fleet-selection'

class MemStorage implements StorageLike {
  data = new Map<string, string>()
  getItem(k: string) { return this.data.get(k) ?? null }
  setItem(k: string, v: string) { this.data.set(k, v) }
}

const empty = new Set<string>()

test('everything is selected by default', () => {
  assert.equal(isSelected(empty, 'a'), true)
})

test('setMany deselects/selects and returns the same set when nothing changes', () => {
  const off = setMany(empty, ['a', 'b'], false)
  assert.deepEqual([...off].sort(), ['a', 'b'])
  assert.equal(isSelected(off, 'a'), false)
  assert.equal(setMany(off, ['a'], false), off)
  assert.equal(setMany(empty, ['x'], true), empty)
  assert.deepEqual([...setMany(off, ['a'], true)], ['b'])
})

test('toggleMany: all selected -> deselect all; partial or none -> select all', () => {
  const ids = ['a', 'b', 'c']
  const none = toggleMany(empty, ids)
  assert.deepEqual([...none].sort(), ids)
  const partial = new Set(['b'])
  assert.deepEqual([...toggleMany(partial, ids)], [])
  assert.deepEqual([...toggleMany(none, ids)], [])
  assert.equal(toggleMany(empty, []), empty)
})

test('selectAll clears; selectNone deselects known ids but not unknown future ones', () => {
  assert.equal(selectAll(empty), empty)
  assert.deepEqual([...selectAll(new Set(['a']))], [])
  const off = selectNone(empty, ['a', 'b'])
  assert.equal(isSelected(off, 'a'), false)
  assert.equal(isSelected(off, 'new-instance'), true)
})

test('serialize / parse round trip', () => {
  const off = new Set(['a', 'group:x'])
  assert.deepEqual(parseSelection(serializeSelection(off)), off)
})

test('parse is tolerant of garbage', () => {
  for (const raw of [null, undefined, '', 'not json', '42', 'null', '{}', '{"off":"a"}', '[1,2]']) {
    assert.deepEqual([...parseSelection(raw as string | null | undefined)], [], String(raw))
  }
  assert.deepEqual([...parseSelection('{"v":1,"off":["a",3,null,"b"]}')], ['a', 'b'])
})

test('stored ids are capped both ways', () => {
  const big = new Set(Array.from({ length: MAX_STORED_IDS + 50 }, (_, i) => `id${i}`))
  assert.equal(parseSelection(serializeSelection(big)).size, MAX_STORED_IDS)
  const raw = JSON.stringify({ v: 1, off: Array.from({ length: MAX_STORED_IDS + 50 }, (_, i) => `id${i}`) })
  assert.equal(parseSelection(raw).size, MAX_STORED_IDS)
})

test('persists across "reloads" through storage', () => {
  const storage = new MemStorage()
  assert.equal(saveSelection(storage, new Set(['taxis-1', 'kanban:alpha'])), true)
  assert.ok(storage.data.has(FLEET_SELECTION_KEY))
  const reloaded = loadSelection(storage)
  assert.deepEqual([...reloaded].sort(), ['kanban:alpha', 'taxis-1'])
})

test('storage failures never throw', () => {
  const throwing: StorageLike = {
    getItem() { throw new Error('denied') },
    setItem() { throw new Error('quota') },
  }
  assert.deepEqual([...loadSelection(throwing)], [])
  assert.equal(saveSelection(throwing, new Set(['a'])), false)
  assert.deepEqual([...loadSelection(null)], [])
  assert.equal(saveSelection(undefined, new Set(['a'])), false)
})
