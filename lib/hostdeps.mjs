/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`（拿不到就退、再拿不到就降级）
 * ============================================================================
 * 为什么需要：这些包是 optional peer，桌面版 profile（autoInstallPeers: false）
 * 永远不装它们——顶部裸 import 会让整条插件不激活（DSH 只留一句 did not activate）。
 * 策略：① 优先从宿主树解析（跟宿主同一份）② bare import 自己依赖里那份
 *      ③ 彻底拿不到就降级——**绝不让一个 import 拖死整条插件**。
 * （Phase 2 注册 MCP 工具时才真正用到；现在备着。）
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

export function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
    try {
      for (const n of readdirSync(join(npm, '@deepseek-ai'))) {
        push(join(npm, '@deepseek-ai', n, 'node_modules', '@deepseek-ai'))
      }
    } catch { /* 没有就算了 */ }
  }
  try {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', p, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

async function fromHostTree(name) {
  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, name)
    if (!url) continue
    try { return await import(url) } catch { /* 试下一个 */ }
  }
  return null
}

/** @returns {Promise<{z:any, defineTool:Function|null, notes:string[]}>} */
export async function loadHostDeps() {
  const notes = []
  let zMod = await fromHostTree('schemastery')
  if (!zMod) {
    try { zMod = await import('@deepseek-ai/schemastery'); notes.push('schemastery: 自己依赖里那份') }
    catch { notes.push('schemastery: 拿不到，设置页降级') }
  }
  let dtMod = await fromHostTree('dsh-tools')
  if (!dtMod) {
    try { dtMod = await import('@deepseek-ai/dsh-tools') } catch { notes.push('dsh-tools: 拿不到，工具注册降级') }
  }
  return { z: zMod?.default ?? zMod ?? null, defineTool: dtMod?.defineTool ?? null, notes }
}
