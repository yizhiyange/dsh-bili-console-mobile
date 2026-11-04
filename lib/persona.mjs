/**
 * lib/persona.mjs —— 人设解析
 * ============================================================================
 * 人设框（config.personaPrompt）两种填法：
 *   ① 直接贴一整张角色卡（默认，上限可调，全文进提示词，没有摘要、没有截断套路）
 *   ② 填一个 AGENTS.md 的路径（Windows 路径 / UNC / ~ 开头）——插件去读那个文件
 * 读不到文件时退回"按文本框内容用"，并在 note 里说明，不静默失败。
 *
 * ⚠️ 上限以前写死 8000 字，用户要求能自己调（有人就想写两万字），
 *    所以改成读 config.personaMaxLen。
 *    2026-11-4：用户要求「下限低、上限几乎不存在」——下限 100，上限 1000 万字。
 *    （真写超长会撞模型上下文，那是模型那边的限制，插件不再替用户砍。）
 * ============================================================================
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** 默认上限（没配置时用这个） */
export const MAX_PERSONA = 8000
/** 最低能设多少（没有最高：用户要"无限制"，2026-11-4） */
export const MIN_PERSONA_LIMIT = 100
/** 老代码可能还引用这个名字；现在只作为"没配置时的默认值"使用，不再当上限 */
export const MAX_PERSONA_LIMIT = Infinity

/**
 * 收敛用户填的字数上限：只保底，不封顶。
 * 乱填（负数 / NaN / Infinity）才回默认，正数多大都照收。
 */
export function clampPersonaLimit(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return MAX_PERSONA
  return Math.max(MIN_PERSONA_LIMIT, Math.floor(n))
}

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
 * @param {string} raw 人设原文（也可能是文件路径）
 * @param {number} [limit] 字数上限，来自 config.personaMaxLen；不传就用默认 8000
 * @returns {{text:string, from:'empty'|'inline'|'file'|'inline-fallback', note:string, truncated:boolean}}
 */
export function resolvePersona(raw, limit) {
  const cap = clampPersonaLimit(limit)
  const text = String(raw || '').trim()
  if (!text) {
    return { text: '', from: 'empty', note: '未配置人设：AI 按中性语气说话', truncated: false }
  }
  if (!looksLikePath(text)) {
    return {
      text: text.slice(0, cap), from: 'inline',
      note: `人设卡 ${Math.min(text.length, cap)} 字（上限 ${cap}，全文生效）`,
      truncated: text.length > cap,
    }
  }
  const p = expandHome(text)
  try {
    const st = statSync(p)
    const file = st.isDirectory() ? resolve(p, 'AGENTS.md') : p
    if (!existsSync(file)) throw Object.assign(new Error('文件不存在'), { code: 'ENOENT' })
    const content = readFileSync(file, 'utf8')
    return {
      text: content.slice(0, cap), from: 'file',
      note: `人设来自文件 ${file}（${content.length} 字${content.length > cap ? '，超出上限已截断到 ' + cap : ''}）`,
      truncated: content.length > cap,
    }
  } catch (e) {
    return {
      text: text.slice(0, cap), from: 'inline-fallback',
      note: `路径读不到（${e.code || e.message}），已按文本框内容使用`,
      truncated: text.length > cap,
    }
  }
}
