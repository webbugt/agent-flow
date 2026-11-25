import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { decodePng, diffRasters, encodePng, type Raster } from './shot-diff'

function raster(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]): Raster {
  const data = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(fill(x, y), (y * w + x) * 4)
  return { width: w, height: h, channels: 4, data }
}

test('encodePng -> decodePng round-trips pixels', () => {
  const r = raster(7, 5, (x, y) => [x * 30, y * 40, (x + y) * 10, 255])
  const back = decodePng(encodePng(r))
  assert.equal(back.width, 7)
  assert.equal(back.height, 5)
  assert.deepEqual([...back.data], [...r.data])
})

test('decodePng rejects non-PNG input', () => {
  assert.throws(() => decodePng(Buffer.from('not a png')), /not a PNG/)
})

test('diffRasters counts differing pixels, tolerance and size mismatch', () => {
  const a = raster(10, 10, () => [10, 20, 30, 255])
  const b = raster(10, 10, (x, y) => (x === 3 && y === 4 ? [10, 20, 90, 255] : [10, 20, 30, 255]))
  const d = diffRasters(a, b)
  assert.equal(d.differing, 1)
  assert.equal(d.total, 100)
  assert.equal(d.pct, 1)
  assert.equal(diffRasters(a, b, 100).differing, 0, 'tolerance hides a small channel delta')
  assert.equal(diffRasters(a, a).differing, 0)
  const withImg = diffRasters(a, b, 0, true)
  assert.equal(withImg.diffImage?.data[(4 * 10 + 3) * 3], 255)
  assert.equal(diffRasters(a, raster(5, 5, () => [0, 0, 0, 255])).sameSize, false)
})
