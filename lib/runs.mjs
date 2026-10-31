/**
 * lib/runs.mjs —— 插件自己的「运行小结」历史（2026-11-1 加）
 * ============================================================================
 * 为什么不再依赖 DSH 会话：
 *   之前想把每轮小结投进 DSH 的会话列表，靠的是宿主内部接口（sessions.create / agents.* 那些）。
 *   那些接口没对外开放、版本一变就失效，用户跑了几轮都投不进去（2026-11-1 实测）。
 *   这里改成**插件自己记账**：每轮结束追加一行 JSON 到 runs.jsonl，
 *   在插件面板里直接看时间线，跟宿主实现无关，永远不会"投递失败"。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = (home) => join(home, 'runs.jsonl')
const MAX_LINES = 400      // 只看最近 400 轮，避免文件无限长

/** 记一轮（异步调用方不用等；写失败也不影响跑轮） */
export function appendRun(home, s = {}) {
  if (!home) return false
  try {
    const row = {
      at: Date.now(),
      // 时间线要能一眼看懂：挑了几条、发了几条、为什么停
      scanned: Number(s.scanned) || 0,
      picked: Number(s.picked) || 0,
      posted: Number(s.posted) || 0,
      dryRun: !!s.dryRun,
      why: String(s.why || '').slice(0, 200),
      degraded: !!s.degraded,
      errors: (Array.isArray(s.errors) ? s.errors : []).slice(0, 3).map((x) => String(x).slice(0, 120)),
      items: (Array.isArray(s.items) ? s.items : []).slice(0, 8).map((x) => ({
        bvid: String(x.bvid || ''),
        title: String(x.title || '').slice(0, 40),
        grade: String(x.grade || ''),
        reason: String(x.reason || '').slice(0, 60),
        posted: !!x.posted,
      })),
    }
    appendFileSync(FILE(home), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch { return false }
}

/** 读最近的记录（倒序，最新在前） */
export function listRuns(home, limit = 30) {
  if (!home) return []
  try {
    const p = FILE(home)
    if (!existsSync(p)) return []
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean)
    const tail = lines.slice(-Math.max(1, Math.min(MAX_LINES, lines.length)))
    const out = []
    for (const ln of tail) {
      try { out.push(JSON.parse(ln)) } catch { /* 坏行跳过 */ }
    }
    return out.reverse().slice(0, Math.max(1, Math.min(200, Number(limit) || 30)))
  } catch { return [] }
}

/** 清空历史 */
export function clearRuns(home) {
  try { writeFileSync(FILE(home), '', 'utf8'); return true } catch { return false }
}

/** 统计：今天跑了几轮、发了几条（给界面头部用） */
export function runStats(home) {
  const rows = listRuns(home, 200)
  const dayStart = (() => {
    const d = new Date(Date.now() + 8 * 3600 * 1000)   // 跟 dayKey 一致：按北京时间算今天
    d.setUTCHours(0, 0, 0, 0)
    return d.getTime() - 8 * 3600 * 1000
  })()
  const today = rows.filter((r) => Number(r.at) >= dayStart)
  return {
    total: rows.length,
    todayRuns: today.length,
    todayPosted: today.reduce((n, r) => n + (Number(r.posted) || 0), 0),
    todayPicked: today.reduce((n, r) => n + (Number(r.picked) || 0), 0),
    lastAt: rows[0] ? rows[0].at : 0,
  }
}
