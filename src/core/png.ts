/**
 * 极简确定性 PNG 编码器（零依赖，只用 node:zlib）。
 *
 * 用途：Mock/Dry-Run 模式下生成"有像素、可被 Three.js 当纹理读"的占位图，
 * 而不是给一个空文件让下游渲染报错。同一 seed + 尺寸 → 字节级一致（可做契约/快照测试）。
 */
import { readFileSync } from 'node:fs'
import { inflateSync, deflateSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0)
  return Buffer.concat([length, typeBytes, Buffer.from(data), crc])
}

/** mulberry32：固定种子的伪随机，保证同 seed 同图（呼应 video-shotcraft 的确定性铁律）。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function hashSeed(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface PngOptions {
  width: number
  height: number
  seed: number
  /** 顶部/底部颜色，中间做多段渐变 + 低频云雾噪声 + 地平线辉光 */
  colorA?: [number, number, number]
  colorB?: [number, number, number]
  /** 叠加细网格（默认关：网格被放大到 3D 舞台上会变成刺眼的马赛克） */
  grid?: boolean
  /** 地平线位置 0..1，null 关闭辉光；深度图/法线图的通道图应关掉 */
  horizon?: number | null
}

/** 整数哈希 → [0,1)，用于确定性值噪声。 */
function hash2(x: number, y: number, seed: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 双线性插值的低频值噪声，octaves 层叠加。 */
function valueNoise(x: number, y: number, seed: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  for (let o = 0; o < octaves; o++) {
    const px = x * freq
    const py = y * freq
    const x0 = Math.floor(px)
    const y0 = Math.floor(py)
    const fx = px - x0
    const fy = py - y0
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const n00 = hash2(x0, y0, seed + o * 131)
    const n10 = hash2(x0 + 1, y0, seed + o * 131)
    const n01 = hash2(x0, y0 + 1, seed + o * 131)
    const n11 = hash2(x0 + 1, y0 + 1, seed + o * 131)
    const top = n00 + (n10 - n00) * sx
    const bottom = n01 + (n11 - n01) * sx
    sum += (top + (bottom - top) * sy) * amp
    amp *= 0.5
    freq *= 2.1
  }
  return sum
}

export function renderPlaceholderPng(options: PngOptions): Buffer {
  const width = Math.max(2, Math.min(4096, Math.floor(options.width)))
  const height = Math.max(2, Math.min(4096, Math.floor(options.height)))
  const rand = mulberry32(options.seed)
  // 默认色板走"电影感薄雾"：深靛蓝夜空 → 青灰雾层，而不是艳丽撞色（后者被放大成 3D 背景会很脏）
  const a = options.colorA ?? [16 + Math.floor(rand() * 14), 22 + Math.floor(rand() * 16), 38 + Math.floor(rand() * 22)]
  const b = options.colorB ?? [96 + Math.floor(rand() * 60), 116 + Math.floor(rand() * 50), 138 + Math.floor(rand() * 40)]
  const grid = options.grid === true
  const horizon = options.horizon === undefined ? 0.58 : options.horizon
  const raw = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1)
    raw[rowStart] = 0
    const ty = y / Math.max(1, height - 1)
    for (let x = 0; x < width; x++) {
      const tx = x / Math.max(1, width - 1)
      // 三段渐变：天顶（a）→ 地平线（b）→ 地面压暗
      const t = ty < 0.5 ? Math.pow(ty * 2, 1.35) * 0.85 : 0.85 + (ty - 0.5) * 0.3
      const offset = rowStart + 1 + x * 3
      let r = a[0] + (b[0] - a[0]) * t
      let g = a[1] + (b[1] - a[1]) * t
      let bl = a[2] + (b[2] - a[2]) * t
      // 低频云雾：横向拉长（层云感），只轻微改变明度
      const cloud = valueNoise(tx * 3.2, ty * 1.4, options.seed, 4) - 0.5
      const veil = 1 + cloud * 0.55
      r *= veil
      g *= veil
      bl *= veil
      if (horizon !== null) {
        // 地平线辉光：沿 ty 的窄高斯带，偏暖
        const d = ty - horizon
        const glow = Math.exp(-(d * d) / (2 * 0.05 * 0.05)) * 0.34
        r += glow * (b[0] * 0.9 + 22)
        g += glow * (b[1] * 0.85 + 16)
        bl += glow * (b[2] * 0.7 + 10)
        if (ty > horizon) {
          const shade = 1 - Math.min(0.55, (ty - horizon) * 1.4)
          r *= shade
          g *= shade
          bl *= shade
        }
      }
      if (grid && (x % 256 === 0 || y % 256 === 0)) {
        r = Math.min(255, r + 20)
        g = Math.min(255, g + 20)
        bl = Math.min(255, bl + 20)
      }
      raw[offset] = Math.max(0, Math.min(255, Math.round(r)))
      raw[offset + 1] = Math.max(0, Math.min(255, Math.round(g)))
      raw[offset + 2] = Math.max(0, Math.min(255, Math.round(bl)))
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 从 "2048x1152" / "16:9" 之类的描述里推断尺寸，默认 1280x720。 */
export function inferSize(value: unknown, fallback: [number, number] = [1280, 720]): [number, number] {
  if (typeof value === 'string') {
    const m = /(\d{2,5})\s*[x×]\s*(\d{2,5})/i.exec(value)
    if (m !== null) return [Number(m[1]), Number(m[2])]
    const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value.trim())
    if (ratio !== null) {
      const w = Number(ratio[1])
      const h = Number(ratio[2])
      const scale = 1280 / Math.max(w, h)
      return [Math.round(w * scale), Math.round(h * scale)]
    }
  }
  return fallback
}

/* ── PNG 解码（只做"读 alpha 覆盖率"这一件事） ──────────────────
 * 背景板守卫需要知道抠像结果里到底有没有前景：matte 几乎是全透明时，
 * 拆出来的 plate 只会是黑孔图。这里只支持探针需要的子集——8bit、非交错、
 * colour type 0/2/4/6；遇到不支持的就返回 null，让调用方跳过判断而不是误判。
 */

export interface PngAlphaImage {
  width: number
  height: number
  /** 每像素 alpha（0–255），仅 RGBA / 灰度+alpha 有值 */
  alpha: Uint8Array
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** 解出 alpha 通道；不支持的颜色类型/位深返回 null（调用方必须容忍）。 */
export function decodePngAlpha(bytes: Uint8Array): PngAlphaImage | null {
  if (bytes.length < 8) return null
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  const idat: Uint8Array[] = []
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const type = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd > bytes.length) return null
    if (type === 'IHDR') {
      width = view.getUint32(dataStart, false)
      height = view.getUint32(dataStart + 4, false)
      bitDepth = bytes[dataStart + 8]!
      colorType = bytes[dataStart + 9]!
      interlace = bytes[dataStart + 12]!
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }
  if (width <= 0 || height <= 0) return null
  if (bitDepth !== 8 || interlace !== 0) return null
  const channels = colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0
  if (channels === 0) return null
  if (idat.length === 0) return null
  let raw: Buffer
  try {
    raw = inflateSync(Buffer.concat(idat.map(part => Buffer.from(part))))
  } catch {
    return null
  }
  const stride = width * channels
  if (raw.length < (stride + 1) * height) return null
  const pixels = new Uint8Array(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const prev = dst - stride
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x]!
      const a = x >= channels ? pixels[dst + x - channels]! : 0
      const b = y > 0 ? pixels[prev + x]! : 0
      const c = y > 0 && x >= channels ? pixels[prev + x - channels]! : 0
      let out: number
      if (filter === 0) out = value
      else if (filter === 1) out = value + a
      else if (filter === 2) out = value + b
      else if (filter === 3) out = value + ((a + b) >> 1)
      else if (filter === 4) out = value + paeth(a, b, c)
      else return null
      pixels[dst + x] = out & 0xff
    }
  }
  // 只有 RGBA / 灰度+alpha 才有可信的 alpha 通道
  if (colorType !== 6 && colorType !== 4) return null
  const alpha = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    alpha[i] = colorType === 6 ? pixels[i * 4 + 3]! : pixels[i * 2 + 1]!
  }
  return { width, height, alpha }
}

/**
 * 不透明像素占比（alpha > threshold 的像素 / 总像素）。
 * 读不出来（格式不支持 / 文件缺失）返回 null —— 宁可不判断，也不要误判。
 */
export function alphaCoverage(path: string, threshold = 8): number | null {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return null
  }
  const image = decodePngAlpha(bytes)
  if (image === null) return null
  let solid = 0
  for (let i = 0; i < image.alpha.length; i++) if (image.alpha[i]! > threshold) solid += 1
  return image.alpha.length === 0 ? null : solid / image.alpha.length
}
