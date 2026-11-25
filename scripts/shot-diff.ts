/**
 * Pixel diff of two PNGs written by the screenshot harness (H0-A5 determinism check).
 *
 *   pnpm shot:diff <a.png> <b.png> [--max-pct 0.1] [--out diff.png]
 *   pnpm shot:diff <dirA> <dirB> [--max-pct 0.1]      (compares same-named files)
 *
 * Exit code 0 when every pair differs in at most --max-pct percent of pixels (default 0.1),
 * 1 otherwise. Reads 8-bit, non-interlaced RGB/RGBA PNGs (what Chrome writes), no dependency
 * beyond Node's zlib.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as zlib from 'zlib'

export interface Raster { width: number; height: number; channels: 3 | 4; data: Buffer }

export function decodePng(buf: Buffer): Raster {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) throw new Error('not a PNG')
  let pos = 8
  let width = 0; let height = 0; let channels: 3 | 4 = 4
  const idat: Buffer[] = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4)
      const depth = body[8]; const colour = body[9]; const interlace = body[12]
      if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${colour}, interlace ${interlace})`)
      channels = colour === 2 ? 3 : 4
    } else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length !== (stride + 1) * height) throw new Error('unexpected PNG data length')
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? out[dst + x - channels] : 0
      const up = y > 0 ? out[dst - stride + x] : 0
      const upLeft = y > 0 && x >= channels ? out[dst - stride + x - channels] : 0
      let v = raw[src + x]
      if (filter === 1) v += left
      else if (filter === 2) v += up
      else if (filter === 3) v += (left + up) >> 1
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left); const pb = Math.abs(p - up); const pc = Math.abs(p - upLeft)
        v += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
      } else if (filter !== 0) throw new Error(`bad PNG filter ${filter}`)
      out[dst + x] = v & 0xff
    }
  }
  return { width, height, channels, data: out }
}

function crc32(b: Buffer): number {
  let c = ~0
  for (let i = 0; i < b.length; i++) {
    c ^= b[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

export function encodePng(r: Raster): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(type, 4, 'latin1')
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, tail])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(r.width, 0); ihdr.writeUInt32BE(r.height, 4); ihdr[8] = 8; ihdr[9] = r.channels === 3 ? 2 : 6
  const stride = r.width * r.channels
  const raw = Buffer.alloc((stride + 1) * r.height)
  for (let y = 0; y < r.height; y++) r.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export interface DiffResult { sameSize: boolean; total: number; differing: number; pct: number; diffImage?: Raster }

/** Count pixels whose channels differ by more than `tolerance` (0 = any difference). */
export function diffRasters(a: Raster, b: Raster, tolerance = 0, withImage = false): DiffResult {
  if (a.width !== b.width || a.height !== b.height) return { sameSize: false, total: a.width * a.height, differing: a.width * a.height, pct: 100 }
  const total = a.width * a.height
  const img = withImage ? Buffer.alloc(total * 3) : undefined
  let differing = 0
  for (let i = 0; i < total; i++) {
    let d = 0
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.data[i * a.channels + c] - b.data[i * b.channels + c]))
    const bad = d > tolerance
    if (bad) differing++
    if (img) { const v = a.data[i * a.channels] >> 2; img[i * 3] = bad ? 255 : v; img[i * 3 + 1] = bad ? 0 : v; img[i * 3 + 2] = bad ? 0 : v }
  }
  return { sameSize: true, total, differing, pct: (differing / total) * 100, ...(img ? { diffImage: { width: a.width, height: a.height, channels: 3 as const, data: img } } : {}) }
}

export function main(argv: string[]): number {
  const pos: string[] = []
  let maxPct = 0.1; let out: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--max-pct') maxPct = Number(argv[++i])
    else if (argv[i] === '--out') out = argv[++i]
    else pos.push(argv[i])
  }
  if (pos.length !== 2 || !Number.isFinite(maxPct)) { console.error('usage: shot:diff <a.png|dirA> <b.png|dirB> [--max-pct 0.1] [--out diff.png]'); return 2 }
  const pairs: Array<[string, string]> = fs.statSync(pos[0]).isDirectory()
    ? fs.readdirSync(pos[0]).filter(f => f.endsWith('.png')).sort().map(f => [path.join(pos[0], f), path.join(pos[1], f)] as [string, string])
    : [[pos[0], pos[1]]]
  let ok = true
  for (const [a, b] of pairs) {
    if (!fs.existsSync(b)) { console.log(`MISSING ${b}`); ok = false; continue }
    const r = diffRasters(decodePng(fs.readFileSync(a)), decodePng(fs.readFileSync(b)), 0, !!out && pairs.length === 1)
    const pass = r.sameSize && r.pct <= maxPct
    if (!pass) ok = false
    console.log(`${pass ? 'OK  ' : 'FAIL'} ${path.basename(a)}: ${r.sameSize ? `${r.differing}/${r.total} pixels differ (${r.pct.toFixed(4)}%)` : 'different sizes'}`)
    if (out && r.diffImage) fs.writeFileSync(out, encodePng(r.diffImage))
  }
  return ok ? 0 : 1
}

if (require.main === module) process.exit(main(process.argv.slice(2)))
