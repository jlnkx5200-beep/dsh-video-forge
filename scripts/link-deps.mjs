#!/usr/bin/env node
/**
 * Resolve the host's peer packages for a build.
 *
 * This plugin is a DeepSeek Harness (DSH) bundle: it imports `cordis`,
 * `schemastery` and `@deepseek-ai/dsh-tools` at build time, and the host ships
 * those from a source checkout rather than from npm. Two build modes exist:
 *
 *   node scripts/link-deps.mjs --npm                 # devDependencies from npm
 *   node scripts/link-deps.mjs --checkout <path>     # a DSH source checkout
 *
 * Why the `cordis` alias is needed
 * --------------------------------
 * `@deepseek-ai/dsh-tools` declares `module '@deepseek-ai/cordis' { interface
 * Context { tools: ToolRegistry } }`. The host installs that same framework as
 * `cordis`, so `ctx.tools` only typechecks when both specifiers resolve to one
 * copy of the package. npm (and the checkout) keep them separate by default,
 * which silently drops the augmentation and yields three `Property 'tools' does
 * not exist` errors. Pointing `cordis` at the real package restores identity.
 *
 * Every link is idempotent: an existing correct link is left untouched.
 */
import { existsSync, mkdirSync, readlinkSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const linkType = process.platform === 'win32' ? 'junction' : 'dir'

const argv = process.argv.slice(2)
const mode = argv.includes('--checkout') ? 'checkout' : 'npm'
const checkoutArg = mode === 'checkout' ? argv[argv.indexOf('--checkout') + 1] : undefined

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return resolve(a) === resolve(b)
  }
}

function isLinkedTo(link, target) {
  try {
    return samePath(resolve(dirname(link), readlinkSync(link)), target)
  } catch {
    return false
  }
}

function link(relLink, relTarget) {
  const linkPath = join(root, 'node_modules', relLink)
  const target = resolve(root, relTarget)
  if (!existsSync(target)) {
    console.error(`link-deps: target missing: ${relTarget}`)
    process.exit(1)
  }
  if (isLinkedTo(linkPath, target)) return `${relLink} (already linked)`
  mkdirSync(dirname(linkPath), { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(target, linkPath, linkType)
  return `${relLink} -> ${relTarget}`
}

const done = []

if (mode === 'checkout') {
  if (checkoutArg === undefined || !existsSync(join(checkoutArg, 'packages'))) {
    console.error('link-deps: --checkout needs a path containing packages/')
    process.exit(1)
  }
  const checkout = resolve(checkoutArg)
  const vendor = (p) => join(checkout, p)
  const pairs = [
    ['cordis', vendor('vendor/cordis')],
    ['@deepseek-ai/cordis', vendor('vendor/cordis')],
    ['cosmokit', vendor('vendor/cosmokit')],
    ['schemastery', vendor('vendor/schemastery')],
    ['@deepseek-ai/dsh-tools', vendor('packages/core/tools')],
    ['@deepseek-ai/dsh-llm', vendor('packages/llm/llm')],
    ['@deepseek-ai/dsh-system-prompt', vendor('packages/core/system-prompt')],
    ['@types/node', vendor('node_modules/@types/node')],
    ['@types/react', vendor('node_modules/@types/react')],
    ['@types/react-dom', vendor('node_modules/@types/react-dom')],
  ]
  for (const [relLink, target] of pairs) {
    if (!existsSync(target)) {
      // Optional peers (llm / system-prompt / @types) are absent in some
      // checkouts; only the framework itself is mandatory.
      if (relLink === 'cordis' || relLink === '@deepseek-ai/dsh-tools' || relLink === 'schemastery') {
        console.error(`link-deps: required package missing in checkout: ${target}`)
        process.exit(1)
      }
      continue
    }
    done.push(link(relLink, target))
  }
  const stdSchema = join(checkout, 'node_modules/@standard-schema/spec')
  if (existsSync(stdSchema)) done.push(link('@standard-schema/spec', stdSchema))
} else {
  // npm mode: both `cordis` (auto-installed peer) and `@deepseek-ai/cordis`
  // must resolve to one copy. The devDependency provides the real package.
  const real = join(root, 'node_modules', '@deepseek-ai/cordis')
  if (!existsSync(real)) {
    console.error('link-deps: @deepseek-ai/cordis is not installed — run `npm install` first')
    process.exit(1)
  }
  done.push(link('cordis', 'node_modules/@deepseek-ai/cordis'))
}

console.log(`link-deps (${mode}): ${done.join(', ')}`)
