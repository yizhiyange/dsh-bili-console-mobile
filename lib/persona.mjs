/**
 * lib/persona.mjs —— 人设解析
 * ============================================================================
 * 人设框（config.personaPrompt）两种填法：
 *   ① 直接贴一整张角色卡（默认，≤8000 字，全文进提示词，没有摘要、没有截断套路）
 *   ② 填一个 AGENTS.md 的路径（Windows 路径 / UNC / ~ 开头）——插件去读那个文件
 * 读不到文件时退回"按文本框内容用"，并在 note 里说明，不静默失败。
 * ============================================================================
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

export const MAX_PERSONA = 8000

export function looksLikePath(s) {
  const t = String(s || '').trim()
  if (!t || t.includes('\n')) return false
  return /^[A-Za-z]:[\\/]/.test(t) || t.startsWith('\\\\') || t.startsWith('~/') || t.startsWith('/')
}

export function expandHome(p) {
  const t = String(p || '').trim()
  if (t.startsWith('~/') || t === '~') return resolve(homedir(), t === '~' ? '' : t.slice(2))
  return t
}

/**
 * @returns {{text:string, from:'empty'|'inline'|'file'|'inline-fallback', note:string, truncated:boolean}}
 */
export function resolvePersona(raw) {
  const text = String(raw || '').trim()
  if (!text) {
    return { text: '', from: 'empty', note: '未配置人设：AI 按中性语气说话', truncated: false }
  }
  if (!looksLikePath(text)) {
    return {
      text: text.slice(0, MAX_PERSONA), from: 'inline',
      note: `人设卡 ${Math.min(text.length, MAX_PERSONA)} 字（上限 ${MAX_PERSONA}，全文生效）`,
      truncated: text.length > MAX_PERSONA,
    }
  }
  const p = expandHome(text)
  try {
    const st = statSync(p)
    const file = st.isDirectory() ? resolve(p, 'AGENTS.md') : p
    if (!existsSync(file)) throw Object.assign(new Error('文件不存在'), { code: 'ENOENT' })
    const content = readFileSync(file, 'utf8')
    return {
      text: content.slice(0, MAX_PERSONA), from: 'file',
      note: `人设来自文件 ${file}（${content.length} 字）`,
      truncated: content.length > MAX_PERSONA,
    }
  } catch (e) {
    return {
      text: text.slice(0, MAX_PERSONA), from: 'inline-fallback',
      note: `路径读不到（${e.code || e.message}），已按文本框内容使用`,
      truncated: text.length > MAX_PERSONA,
    }
  }
}
