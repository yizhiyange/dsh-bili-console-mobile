/**
 * lib/publishlog.mjs —— 记录"我发出去的东西"（2026-11-1 加）
 * ============================================================================
 * 为什么需要：要能撤回，就必须先知道"发了什么、id 是多少"。
 * 评论有现成账本（retract.mjs），但动态/投稿没有 → 这里补一份。
 * 只记 id 和摘要，不存内容大字段，文件很小。
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILE = (home) => join(home, 'published.jsonl')

export function addPublished(home, rec = {}) {
  try {
    const row = {
      kind: rec.kind === 'video' ? 'video' : 'dynamic',
      id: String(rec.id || ''),
      aid: rec.aid ? String(rec.aid) : '',
      bvid: String(rec.bvid || ''),
      text: String(rec.text || '').slice(0, 120),
      at: Date.now(),
      retracted: false,
    }
    if (!row.id && !row.bvid) return false
    appendFileSync(FILE(home), JSON.stringify(row) + '\n', 'utf8')
    return true
  } catch { return false }
}

function readAll(home) {
  try {
    const p = FILE(home)
    if (!existsSync(p)) return []
    return readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

function writeAll(home, items) {
  try { writeFileSync(FILE(home), items.map((x) => JSON.stringify(x)).join('\n') + (items.length ? '\n' : ''), 'utf8'); return true } catch { return false }
}

/** 列表（新的在前），只给没撤回的 */
export function listPublished(home, limit = 30) {
  return readAll(home).filter((x) => !x.retracted).reverse().slice(0, Math.max(1, limit))
}

/** 标记为已撤回 */
export function markRetracted(home, kind, id) {
  const items = readAll(home)
  let hit = false
  for (const x of items) {
    if (x.kind === kind && (x.id === String(id) || x.bvid === String(id))) { x.retracted = true; hit = true }
  }
  if (hit) writeAll(home, items)
  return hit
}
