#!/usr/bin/env node
/**
 * Repo hygiene gate — runs in CI and before every release.
 *
 * Fails the build when a *tracked* file contains:
 *   • a real-looking API key / bearer token / private key
 *   • a machine-specific path (home directory, this machine's workspace, a local
 *     ComfyUI or DSH checkout)
 *   • a secret-bearing file name (.env, *.pem, *.key, video-forge.json …)
 *   • a tracked blob larger than 5 MB
 *
 * Zero dependencies, read-only, safe to run anywhere git is available:
 *   node scripts/check-hygiene.mjs
 *   node scripts/check-hygiene.mjs --json
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

const MAX_TRACKED_BYTES = 5 * 1024 * 1024

/** Files that legitimately contain the patterns below (this gate itself, docs about it). */
const SELF_ALLOW = new Set(['scripts/check-hygiene.mjs'])

const TEXT_EXT = new Set([
  '.md', '.txt', '.json', '.yml', '.yaml', '.ts', '.tsx', '.js', '.mjs', '.cjs',
  '.sh', '.py', '.html', '.css', '.toml', '.ini', '.patch', '.example', '',
])

const RULES = [
  // ---- credentials -------------------------------------------------------
  {
    id: 'secret/openai-style-key',
    re: /\bsk-[A-Za-z0-9_-]{16,}\b/,
    hint: 'looks like an API key; move it to an env var or ~/.dsh/video-forge.json',
  },
  {
    id: 'secret/aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    id: 'secret/private-key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/,
  },
  {
    id: 'secret/bearer-token',
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/,
  },
  {
    id: 'secret/assigned-credential',
    re: /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password)\b\s*[:=]\s*["'][A-Za-z0-9._~+/=-]{24,}["']/i,
    hint: 'credential literal; use a placeholder such as "<ARK_API_KEY>"',
  },
  {
    id: 'secret/uuid-token',
    re: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    allow: [/fixtures\//, /\.lock$/, /package-lock\.json$/],
    hint: 'UUID-shaped token; keep identifiers out of the public tree',
  },

  // ---- machine-specific paths -------------------------------------------
  {
    id: 'path/windows-user-home',
    re: /\b[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._-]+/,
  },
  {
    id: 'path/workspace',
    re: /\b[A-Za-z]:[\\/]{1,2}dsh for comfy\b/i,
  },
  {
    id: 'path/comfyui-install',
    re: /\b[A-Za-z]:[\\/]{1,2}comfy ui\b/i,
  },
  {
    id: 'path/dsh-checkout',
    re: /\b[A-Za-z]:[\\/]{1,2}(?:dsh[\\/]{1,2}(?:deepseek-harness|app|workspaces)|deepseek-harness)\b/i,
  },
  {
    id: 'path/posix-home',
    re: /(?:^|[\s"'`(=])\/(?:home|Users)\/[a-z0-9._-]{2,}\/(?:dsh|\.dsh|deepseek|repos?|projects?)\b/i,
  },
  {
    id: 'path/msys-drive-mount',
    re: /(?:^|[\s"'`(=])\/[a-z]\/dsh\//i,
  },
]

/** File names that must never be tracked. */
const FORBIDDEN_NAMES = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|pfx|p12|jks|keystore)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/,
  /(?:^|\/)(?:video-forge|seedream)\.json$/,
  /(?:^|\/)credentials(?:\.json)?$/,
]

function gitFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 })
  return out.toString('utf8').split('\0').filter(Boolean)
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function main() {
  const json = process.argv.includes('--json')
  const findings = []
  const tracked = gitFiles()
  let scanned = 0

  for (const file of tracked) {
    const base = file.split('/').pop()
    for (const re of FORBIDDEN_NAMES) {
      if (re.test(base) || re.test(file)) {
        findings.push({ file, line: 0, id: 'file/forbidden', text: 'file name is not allowed in the public tree' })
      }
    }

    let st
    try {
      st = statSync(file)
    } catch {
      continue // submodule / deleted-in-index entry
    }
    if (st.size > MAX_TRACKED_BYTES) {
      findings.push({
        file,
        line: 0,
        id: 'size/tracked-blob',
        text: `${(st.size / 1024 / 1024).toFixed(1)} MB > 5 MB limit`,
      })
      continue
    }
    if (SELF_ALLOW.has(file)) continue
    if (!TEXT_EXT.has(extname(file).toLowerCase())) continue

    const buf = readFileSync(file)
    if (isBinary(buf)) continue
    scanned++

    const lines = buf.toString('utf8').split(/\r?\n/)
    for (const rule of RULES) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (line.length > 4000) continue // generated/minified single-line assets
        const m = rule.re.exec(line)
        if (!m) continue
        if (rule.allow?.some((re) => re.test(file))) continue
        findings.push({
          file,
          line: i + 1,
          id: rule.id,
          text: line.trim().slice(0, 160),
          hint: rule.hint,
        })
        break // one hit per rule per file is enough to fail
      }
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ tracked: tracked.length, scannedText: scanned, findings }, null, 2) + '\n')
  } else if (findings.length === 0) {
    console.log(`check-hygiene: OK — ${tracked.length} tracked files (${scanned} scanned as text), no secrets, no machine paths, no blob > 5 MB`)
  } else {
    console.error(`check-hygiene: ${findings.length} finding(s) in ${tracked.length} tracked files\n`)
    const byFile = new Map()
    for (const f of findings) {
      if (!byFile.has(f.file)) byFile.set(f.file, [])
      byFile.get(f.file).push(f)
    }
    for (const [file, items] of byFile) {
      console.error(`  ${file}`)
      for (const it of items) {
        const where = it.line ? `:${it.line}` : ''
        console.error(`    ${it.id}${where}  ${it.text}`)
        if (it.hint) console.error(`      → ${it.hint}`)
      }
    }
    console.error('\nFix the files above (or add a justified allow-rule to scripts/check-hygiene.mjs) and re-run.')
  }

  process.exit(findings.length === 0 ? 0 : 1)
}

main()
