/**
 * 极小 PNG 像素采样器（无依赖）：只支持非隔行 8bit RGB/RGBA。
 * 用法：node scripts/pixel.mjs out/probe5.png [x] [y]
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

const file = process.argv[2] ?? 'out/probe5.png'
const px = Number(process.argv[3] ?? -1)
const py = Number(process.argv[4] ?? -1)
const buf = readFileSync(file)
let pos = 8
let width = 0
let height = 0
let bitDepth = 8
let colorType = 6
const idat = []
while (pos < buf.length) {
  const len = buf.readUInt32BE(pos)
  const type = buf.toString('ascii', pos + 4, pos + 8)
  const data = buf.subarray(pos + 8, pos + 8 + len)
  if (type === 'IHDR') {
    width = data.readUInt32BE(0)
    height = data.readUInt32BE(4)
    bitDepth = data[8]
    colorType = data[9]
  } else if (type === 'IDAT') {
    idat.push(data)
  } else if (type === 'IEND') {
    break
  }
  pos += 12 + len
}
if (bitDepth !== 8 || colorType < 2) {
  console.log('unsupported png: depth=' + bitDepth + ' colorType=' + colorType)
  process.exit(1)
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
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      v = (v + pred) & 0xff
    }
    cur[x] = v
  }
  cur.copy(out, y * stride)
  prev = cur
}
function sample(x, y) {
  const i = y * stride + x * channels
  return [out[i], out[i + 1], out[i + 2]]
}
const cx = px >= 0 ? px : width >> 1
const cy = py >= 0 ? py : height >> 1
console.log('size', width + 'x' + height, 'channels', channels)
console.log('center', JSON.stringify(sample(cx, cy)))
console.log('top-left', JSON.stringify(sample(2, 2)))
const uniq = new Set()
for (let y = 0; y < height; y += Math.max(1, height >> 4)) {
  for (let x = 0; x < width; x += Math.max(1, width >> 4)) {
    uniq.add(sample(x, y).join(','))
  }
}
console.log('distinct(sampled)', uniq.size)
