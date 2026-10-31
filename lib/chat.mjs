/**
 * chat.mjs —— 插件自己的「对话」存储 + 回复
 * ============================================================================
 * 为什么不直接接 DSH 的会话：
 *   DSH 没给插件公开的会话接口，会话文件是 zstd 压缩的 JSONL，硬写有把 DSH 读坏的风险。
 *   所以自己做一套：存在插件家目录的 chat.jsonl，界面在插件面板里，效果一样但零风险。
 *
 * 两种消息：
 *   - role:'bot'  插件说的（每轮小结 / 回答你）
 *   - role:'me'   你说的
 * kind: 'round' | 'reply' | 'sys'
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { resolvePersona } from './persona.mjs'
import { buildEndpoints } from './chain.mjs'
import { chat as callChat } from './llm.mjs'

const MAX_LINES = 400

export function chatFile(home) {
  return join(home, 'chat.jsonl')
}

function ensureDir(f) {
  try { mkdirSync(dirname(f), { recursive: true }) } catch { /* noop */ }
}

/** 读最近 limit 条（早的在前面） */
export function loadChat(home, limit = 120) {
  const f = chatFile(home)
  if (!existsSync(f)) return []
  try {
    const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/** 追加一条（超过上限就重写成最近 MAX_LINES 条，避免文件无限长） */
export function appendChat(home, entry) {
  const f = chatFile(home)
  ensureDir(f)
  const item = { at: new Date().toISOString(), ...entry }
  try { appendFileSync(f, JSON.stringify(item) + '\n', 'utf8') } catch { return item }
  try {
    const n = readFileSync(f, 'utf8').split('\n').filter(Boolean).length
    if (n > MAX_LINES + 50) {
      const kept = readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(-MAX_LINES)
      writeFileSync(f, kept.join('\n') + '\n', 'utf8')
    }
  } catch { /* 清理失败不影响追加 */ }
  return item
}

export function clearChat(home) {
  try { writeFileSync(chatFile(home), '', 'utf8'); return true } catch { return false }
}

/**
 * 用当前模型链回答用户一句话。
 * @param {object} cfg
 * @param {Array} hostModels DSH 预设模型
 * @param {string} text 用户输入
 * @param {string} home 用来读人设/历史
 * @returns {Promise<{ok:boolean, text?:string, error?:string, modelUsed?:string}>}
 */
export async function chatReply(cfg, hostModels, text, home) {
  const chain = buildEndpoints(cfg, hostModels || [])
  if (!chain || !chain.length) return { ok: false, error: '还没有可用模型：去「模型与密钥」配一个，或在 DSH 里选一个预设' }

  const p = resolvePersona(cfg.personaPrompt, cfg.personaMaxLen)
  const history = loadChat(home, 10)
    .filter((m) => m.text && (m.kind === 'reply' || m.kind === 'sys' || m.role === 'me'))
    .map((m) => (m.role === 'me' ? '用户：' : '你：') + String(m.text).slice(0, 300))
    .join('\n')

  const system = [
    '你在一个 B站 刷视频插件里，和用户文字对话。',
    p.text ? ('你的人设（照着说话，别自我介绍）：\n' + p.text.slice(0, 1200)) : '用自然、简短的口气说话。',
    '规则：1) 说人话，2-3 句为主，别长篇大论；2) 不确定就说不确定，别编；',
    '3) 你没有直接操作插件的能力，做不到的事直接说做不到；4) 不要用「作为一个AI」这类开场。',
  ].join('\n')

  const user = (history ? ('之前的对话：\n' + history + '\n\n') : '') + '用户说：' + String(text || '').slice(0, 1000)

  const r = await callChat(chain, { system, user, maxTokens: 500, temperature: 0.8, thinkingOff: cfg.thinkingOff !== false })
  if (!r.ok) return { ok: false, error: r.lastError || '模型没回话' }
  const reply = String(r.text || '').trim()
  if (!reply) return { ok: false, error: '模型返回空内容' }
  return { ok: true, text: reply, modelUsed: r.modelUsed || '' }
}

/** 每轮结束往对话里丢一条小结（可在界面关掉） */
export function appendRoundSummary(home, lines) {
  const text = (Array.isArray(lines) ? lines : [lines]).filter(Boolean).join('\n')
  if (!text.trim()) return null
  return appendChat(home, { role: 'bot', kind: 'round', text })
}
