/**
 * lib/memory.mjs —— 每条视频的「对话上下文」（可选）
 * ============================================================================
 * 两种模式（配置项 contextMode）：
 *
 *   isolated（默认，一条视频一个上下文，彼此不串）
 *     - 每次判断/回复都是全新会话：只带「人设 + 章程 + 这一条视频」，
 *       不读任何历史对话，也不写对话记录。
 *     - 唯一跨轮留下的东西是**判重表 seen.md**（哪个视频/评论处理过），
 *       那是"别再重复"的记号，不是上下文，不含任何对话内容。
 *     - 代价：同一条视频下你之前说过什么、对方回了什么，它下次**完全不记得**。
 *
 *   thread（保留线程上下文）
 *     - 每条视频一个 threads/<BV>.json，记「我们说过的话 + 谁回了什么」。
 *     - 下次再碰这条视频（补评论 / 回评论）时，把最近几轮压缩后放进 prompt，
 *       所以它能接着聊、不会自相矛盾。
 *     - 代价见 UI 里的风险说明：本地会存别人的昵称与留言、token 变多、
 *       还容易"顺着自己前面说过的话往下圆"。
 *
 * 所有读写都是纯尽力：出错就当没有，绝不拖垮值守。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const MAX_TURNS = 40          // 单条视频最多留 40 轮，超出丢最早的
const CTX_TURNS = 6           // 塞进 prompt 的最近轮数
const CTX_CHARS = 900         // 塞进 prompt 的字数上限

function threadsDir(home) { return join(home, 'threads') }

function fileOf(home, bvid) {
  const id = String(bvid || '').replace(/^BV/i, '')
  return join(threadsDir(home), `BV${id}.json`)
}

function readJson(f, dflt) {
  try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt }
}

function writeJson(f, obj) {
  try {
    mkdirSync(join(f, '..'), { recursive: true })
    writeFileSync(f, JSON.stringify(obj, null, 2))
    return true
  } catch { return false }
}

export function readThread(home, bvid) {
  const t = readJson(fileOf(home, bvid), null)
  if (!t || typeof t !== 'object') return null
  if (!Array.isArray(t.turns)) t.turns = []
  return t
}

/** 追加一轮对话（role: 'us' | 'them'） */
export function appendTurn(home, bvid, turn) {
  const f = fileOf(home, bvid)
  const t = readThread(home, bvid) || { bvid: String(bvid || ''), title: '', turns: [], ourRpid: 0 }
  t.turns.push({
    role: turn.role === 'them' ? 'them' : 'us',
    text: String(turn.text || '').slice(0, 500),
    at: turn.at || new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    ...(turn.uid ? { uid: turn.uid } : {}),
    ...(turn.rpid ? { rpid: turn.rpid } : {}),
  })
  if (t.turns.length > MAX_TURNS) t.turns = t.turns.slice(-MAX_TURNS)
  if (turn.title) t.title = String(turn.title).slice(0, 120)
  if (turn.ourRpid) t.ourRpid = turn.ourRpid
  t.updatedAt = new Date().toISOString()
  writeJson(f, t)
  return t
}

/**
 * 给 prompt 用的压缩上下文（thread 模式才调用）。
 * 返回空串表示这条视频没有历史。
 */
export function threadContextText(home, bvid, opts = {}) {
  const t = readThread(home, bvid)
  if (!t || !t.turns.length) return ''
  const turns = t.turns.slice(-(opts.turns || CTX_TURNS))
  const lines = []
  let used = 0
  for (const x of turns) {
    const who = x.role === 'them' ? '对方' : '你'
    const s = `- ${who}：${x.text}`
    if (used + s.length > (opts.maxChars || CTX_CHARS)) break
    lines.push(s)
    used += s.length
  }
  return lines.join('\n')
}

/** 统计（给 UI 显示用了多少条视频的上下文） */
export function threadStats(home) {
  try {
    const dir = threadsDir(home)
    if (!existsSync(dir)) return { count: 0, turns: 0, bytes: 0 }
    const files = readdirSync(dir).filter((f) => /^BV.*\.json$/i.test(f))
    let turns = 0, bytes = 0
    for (const f of files) {
      const t = readJson(join(dir, f), null)
      if (t && Array.isArray(t.turns)) turns += t.turns.length
      try { bytes += readFileSync(join(dir, f), 'utf8').length } catch { /* noop */ }
    }
    return { count: files.length, turns, bytes }
  } catch { return { count: 0, turns: 0, bytes: 0 } }
}

/** 一把清空所有上下文（UI 的"忘掉全部"按钮） */
export function clearThreads(home) {
  try { rmSync(threadsDir(home), { recursive: true, force: true }); return true } catch { return false }
}

/* ───────── 回复通知的去重（避免同一条回复被回两次）───────── */

function repliedFile(home) { return join(home, 'replied.json') }

export function loadReplied(home) {
  const arr = readJson(repliedFile(home), [])
  return new Set(Array.isArray(arr) ? arr.map(String) : [])
}

export function markReplied(home, id) {
  const set = loadReplied(home)
  set.add(String(id))
  const arr = [...set].slice(-2000)
  try { mkdirSync(home, { recursive: true }); writeFileSync(repliedFile(home), JSON.stringify(arr, null, 2)) } catch { /* noop */ }
}
