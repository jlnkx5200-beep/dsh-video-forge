/**
 * 比较两张 PNG 的像素差（无依赖，复用 pixel.mjs 的解码思路）。
 * 用法：node scripts/pngdiff.mjs a.png b.png
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

function decode(file) {
  const buf = readFileSync(file)
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 6
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') break
    pos += 12 + len
  }
  const channels = colorType === 6 ? 4 : 3
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  let rp = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[rp]
    rp += 1
    const line = raw.subarray(rp, rp + stride)
    rp += stride
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = line[x]
      if (filter === 1) v = (v + a) & 0xff
      else if (filter === 2) v = (v + b) & 0xff
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      }
      cur[x] = v
    }
    cur.copy(out, y * stride)
    prev = cur
  }
  return { width, height, channels, data: out }
}

const a = decode(process.argv[2])
const b = decode(process.argv[3])
if (a.width !== b.width || a.height !== b.height) {
  console.log('尺寸不同：' + a.width + 'x' + a.height + ' vs ' + b.width + 'x' + b.height)
  process.exit(2)
}
let maxDiff = 0
let sum = 0
let changed = 0
for (let i = 0; i < a.data.length; i += a.channels) {
  let d = 0
  for (let c = 0; c < 3; c += 1) d = Math.max(d, Math.abs(a.data[i + c] - b.data[i + c]))
  if (d > maxDiff) maxDiff = d
  if (d > 2) changed += 1
  sum += d
}
const pixels = a.width * a.height
console.log('maxDiff', maxDiff, 'avgDiff', (sum / pixels).toFixed(3), 'changed>2', ((changed / pixels) * 100).toFixed(2) + '%')
