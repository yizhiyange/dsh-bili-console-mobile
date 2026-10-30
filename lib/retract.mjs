/**
 * lib/retract.mjs —— 撤回（把 AI 自己发出去的内容删掉）
 * ============================================================================
 * 为什么要这个：AI 在别人视频下发的评论是**公开且不可撤回**的，一旦发错
 * （语气不对、事实说错、发到不该发的视频下），只能靠"删自己的评论"来补救。
 * 所以每发一条就记一条账（posted.json），撤回时按账去删。
 *
 * 能删的只有**自己发的**（B站 侧会校验权限），所以这张账本不会变成"删别人评论"的工具。
 *
 * 账本：home/posted.json
 *   { items: [{ bvid, rpid, text, at, kind: 'comment' | 'reply', title? }] }
 *   新的在前，最多留 500 条。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { deleteComment } from './bili.mjs'

const FILE = 'posted.json'
const MAX = 500

function pathOf(home) { return join(home, FILE) }

function readAll(home) {
  try {
    const j = JSON.parse(readFileSync(pathOf(home), 'utf8'))
    const items = Array.isArray(j && j.items) ? j.items : []
    return items.filter((x) => x && x.bvid && Number(x.rpid) > 0)
  } catch { return [] }
}

function writeAll(home, items) {
  try {
    if (!existsSync(home)) mkdirSync(home, { recursive: true })
    writeFileSync(pathOf(home), JSON.stringify({ items: items.slice(0, MAX) }, null, 2), 'utf8')
    return true
  } catch { return false }
}

/**
 * 记一条"我发出去了"。发成功就必须调，否则以后撤不回来。
 * @param {string} home 插件数据目录
 * @param {{bvid:string, rpid:number|string, text:string, kind?:string, title?:string}} rec
 */
export function recordPost(home, rec) {
  const bvid = String((rec && rec.bvid) || '').trim()
  const rpid = Number((rec && rec.rpid) || 0)
  if (!bvid || !rpid) return false
  const items = readAll(home).filter((x) => !(x.bvid === bvid && Number(x.rpid) === rpid))
  items.unshift({
    bvid,
    rpid,
    text: String((rec && rec.text) || '').slice(0, 500),
    at: new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }),
    kind: (rec && rec.kind) === 'reply' ? 'reply' : 'comment',
    title: String((rec && rec.title) || '').slice(0, 120),
  })
  return writeAll(home, items)
}

/** 账本（新的在前）。默认只给最近 50 条，够界面看了 */
export function listPosts(home, limit = 50) {
  return readAll(home).slice(0, Math.max(1, limit))
}

/** 从账本里划掉一条（撤回成功后） */
export function dropPost(home, rpid) {
  const id = Number(rpid)
  return writeAll(home, readAll(home).filter((x) => Number(x.rpid) !== id))
}

/** 账本统计，给 /state 用 */
export function postedStats(home) {
  const items = readAll(home)
  return { count: items.length, last: items[0] ? { bvid: items[0].bvid, at: items[0].at, text: items[0].text.slice(0, 40) } : null }
}

/**
 * 撤回最近 N 条（默认 1 条 = "上一条"）。
 * 只删账本里记着的、也就是自己发的。
 *
 * @param {{home:string, client:object, count?:number, dryRun?:boolean, log?:Function}} opt
 * @returns {Promise<{ok:boolean, dryRun:boolean, removed:Array, failed:Array, note:string}>}
 */
export async function retractLast({ home, client, count = 1, dryRun = false, log = () => {} }) {
  const n = Math.max(1, Math.min(20, Number(count) || 1))
  const items = readAll(home).slice(0, n)
  const removed = []
  const failed = []

  if (!items.length) {
    return { ok: true, dryRun, removed, failed, note: '账本是空的：还没有记录过任何发出去的内容（或者已经全部撤回了）' }
  }

  for (const it of items) {
    const tag = it.bvid + ' rpid=' + it.rpid
    if (dryRun) {
      log('（试跑）会撤回 ' + tag + '：' + String(it.text).slice(0, 30))
      removed.push({ bvid: it.bvid, rpid: it.rpid, text: it.text, dryRun: true })
      continue
    }
    let r = null
    try { r = await deleteComment(client, it.bvid, it.rpid) }
    catch (e) { r = { success: false, error: String((e && e.message) || e) } }

    // B站 对"已经删过"的也会返回失败，这不算真失败，从账本划掉即可
    const gone = /已经删除|不存在|已删除|not\s*exist/i.test(String((r && r.error) || ''))
    if (r && r.success === true) {
      dropPost(home, it.rpid)
      removed.push({ bvid: it.bvid, rpid: it.rpid, text: it.text })
      log('已撤回 ' + tag + '：' + String(it.text).slice(0, 30))
    } else if (gone) {
      dropPost(home, it.rpid)
      removed.push({ bvid: it.bvid, rpid: it.rpid, text: it.text, already: true })
      log('本来就没了 ' + tag + '（已从账本划掉）')
    } else {
      failed.push({ bvid: it.bvid, rpid: it.rpid, error: String((r && r.error) || '未知原因').slice(0, 160) })
      log('撤回失败 ' + tag + '：' + String((r && r.error) || '未知原因'))
    }
  }

  const note = failed.length
    ? ('撤回 ' + removed.length + ' 条，' + failed.length + ' 条没成功（详情见下面）')
    : ('已撤回 ' + removed.length + ' 条')
  return { ok: failed.length === 0, dryRun, removed, failed, note }
}

/** 一键清空账本（不动 B站，只是不再记着这些） */
export function clearPosts(home) {
  const n = readAll(home).length
  writeAll(home, [])
  return n
}
