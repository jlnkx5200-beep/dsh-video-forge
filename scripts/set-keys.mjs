#!/usr/bin/env node
/**
 * Video Forge 密钥录入器（Key 全程不回显、不进 shell 历史、不进仓库）
 *
 * 用法（PowerShell / Git-Bash / CMD 都行）：
 *   node scripts/set-keys.mjs
 *
 * 写入位置（都在仓库之外）：
 *   Ark（Seedream）  → ~/.dsh/seedream.json         {"apiKey":"..."}      与 dsh-seedream 插件共用
 *   MiniMax H3       → ~/.dsh/video-forge.json      {"minimaxApiKey":"..."}
 *   MAGI-2 (Sand.ai) → ~/.dsh/video-forge.json      {"sandApiKey":"..."}
 *
 * MiniMax / Sand.ai 一项直接回车 = 清除对应的已存 Key。
 * 写入后只打印掩码提示（前 4 … 后 4），键值本身不落终端、不进日志。
 */
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SEEDREAM_CFG = join(DSH_HOME, 'seedream.json')
const FORGE_CFG = join(DSH_HOME, 'video-forge.json')

function mask(key) {
  if (!key) return '(未设置)'
  if (key.length <= 12) return `${key.slice(0, 2)}…${key.slice(-2)} (len ${key.length})`
  return `${key.slice(0, 4)}…${key.slice(-4)} (len ${key.length})`
}

function readJsonSafe(path) {
  try {
    if (!existsSync(path)) return {}
    const raw = readFileSync(path, 'utf8').trim()
    if (!raw) return {}
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function writeJson(path, data) {
  mkdirSync(DSH_HOME, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

/** 非 TTY（管道/重定向）时先把 stdin 全读成行，再按顺序消费 */
const pipedLines = []
let pipedLoaded = false

async function nextPipedLine() {
  if (!pipedLoaded) {
    pipedLoaded = true
    const text = await new Promise(resolve => {
      let buf = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', chunk => {
        buf += chunk
      })
      process.stdin.on('end', () => resolve(buf))
      process.stdin.on('error', () => resolve(buf))
      process.stdin.resume()
    })
    for (const line of text.split(/\r?\n/)) pipedLines.push(line)
  }
  return (pipedLines.shift() ?? '').trim()
}

/** 逐字符读，隐去回显；非 TTY 时退化为普通读取（会提示） */
function askHidden(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt)
    const stdin = process.stdin
    const canRaw = typeof stdin.setRawMode === 'function' && stdin.isTTY
    if (!canRaw) {
      process.stdout.write('(当前不是交互终端，输入会回显)\n')
      nextPipedLine().then(resolve)
      return
    }
    stdin.resume()
    stdin.setRawMode(true)
    stdin.setEncoding('utf8')
    let buf = ''
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\u0003') {
          // Ctrl+C
          stdin.setRawMode(false)
          stdin.pause()
          process.stdout.write('\n已取消。\n')
          process.exit(130)
        }
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(buf.trim())
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buf.length > 0) {
            buf = buf.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }
        if (ch === '\u001b') continue // 忽略方向键等转义序列（够用即可）
        if (ch < ' ') continue
        buf += ch
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

function looksLikeArk(key) {
  return /^ark-[0-9a-f]{8}-/i.test(key)
}
function looksLikeMinimax(key) {
  return /^sk-/i.test(key) || key.length >= 32
}
/** Sand.ai Key 目前没有稳定前缀；只做长度与字符集的基本体检，不做格式断言。 */
function looksLikeSand(key) {
  return key.length >= 20 && /^[\x21-\x7e]+$/.test(key) && !/\s/.test(key)
}

async function main() {
  console.log('=== Video Forge 密钥录入 ===')
  console.log('Key 不会回显、不会写入 shell 历史、不会进仓库。')
  console.log(`Ark(Seedream) → ${SEEDREAM_CFG}`)
  console.log(`MiniMax H3    → ${FORGE_CFG}`)
  console.log(`MAGI-2 Sand   → ${FORGE_CFG}\n`)

  const ark = await askHidden('粘贴 火山方舟 Ark API Key（直接回车=保持不变）：')
  if (ark) {
    if (!looksLikeArk(ark)) {
      console.log(`⚠ 格式看起来不像方舟 Key（通常以 ark- 开头），仍然写入。`)
    }
    writeJson(SEEDREAM_CFG, { ...readJsonSafe(SEEDREAM_CFG), apiKey: ark })
    console.log(`✓ Ark 已写入：${mask(ark)}`)
  } else {
    console.log('· Ark 保持不变')
  }

  const mm = await askHidden('粘贴 MiniMax H3 API Key（直接回车=清除已存 MiniMax Key）：')
  const forge = readJsonSafe(FORGE_CFG)
  if (mm) {
    if (!looksLikeMinimax(mm)) console.log('⚠ 长度偏短，仍然写入。')
    forge.minimaxApiKey = mm
    forge.minimaxBaseUrl ||= 'https://api.minimaxi.com'
    forge.minimaxModel ||= 'MiniMax-H3'
    writeJson(FORGE_CFG, forge)
    console.log(`✓ MiniMax 已写入：${mask(mm)}`)
  } else {
    delete forge.minimaxApiKey
    writeJson(FORGE_CFG, forge)
    console.log('✓ MiniMax Key 已清除')
  }

  const sand = await askHidden('粘贴 Sand.ai SAND_API_KEY（MAGI-2 官方直连；直接回车=清除已存 Sand Key）：')
  const forge2 = readJsonSafe(FORGE_CFG)
  if (sand) {
    if (!looksLikeSand(sand)) {
      console.log('⚠ 含空白或长度异常，仍然写入（以官方下发为准）。')
    }
    forge2.sandApiKey = sand
    forge2.sandBaseUrl ||= 'https://api.sand.ai'
    writeJson(FORGE_CFG, forge2)
    console.log(`✓ Sand.ai 已写入：${mask(sand)}`)
  } else {
    delete forge2.sandApiKey
    writeJson(FORGE_CFG, forge2)
    console.log('✓ Sand.ai Key 已清除')
  }

  // 落盘后再核对一次（只读回掩码，绝不打印明文）
  const arkNow = readJsonSafe(SEEDREAM_CFG).apiKey || ''
  const mmNow = readJsonSafe(FORGE_CFG).minimaxApiKey || ''
  const sandNow = readJsonSafe(FORGE_CFG).sandApiKey || ''
  console.log('\n=== 当前状态 ===')
  console.log(`Ark      : ${mask(arkNow)}`)
  console.log(`MiniMax  : ${mask(mmNow)}`)
  console.log(`Sand.ai  : ${mask(sandNow)}`)
  console.log('\n完成。回到会话里说一声「继续」，我来做真实出图验收。')
}

main().catch(err => {
  console.error('录入失败：', err?.message || err)
  process.exit(1)
})
