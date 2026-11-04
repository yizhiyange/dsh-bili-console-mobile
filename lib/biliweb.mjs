/**
 * lib/biliweb.mjs —— 直接调 B 站网页接口（2026-11-1 加）
 * ============================================================================
 * 为什么要有这个文件：
 *   底层 MCP 工具只提供了「删评论」，**没有删动态、删稿件**。而用户要求"能发的都得能撤"。
 *   这两个功能只能走 B 站自己的网页接口（带 cookie + csrf）。
 *
 * ⚠️ 重要：这两个接口不是官方文档承诺的，属于网页端自用。B站 改版就可能失效，
 *    所以调用方必须把失败原样告诉用户（别假装成功）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homeCredFile, vendorCredFile } from './bili.mjs'

/** 读 cookie 凭证（home 优先，其次 vendor） */
export function readCred(home) {
  for (const f of [homeCredFile(home), vendorCredFile()]) {
    try {
      if (!existsSync(f)) continue
      const d = JSON.parse(readFileSync(f, 'utf8'))
      if (d && (d.sessdata || d.bili_jct)) {
        return {
          sessdata: String(d.sessdata || ''),
          biliJct: String(d.bili_jct || ''),
          dedeuserid: String(d.dedeuserid || d.DedeUserID || ''),
          buvid3: String(d.buvid3 || ''),
          acTimeValue: String(d.ac_time_value || ''),
        }
      }
    } catch { /* 读坏就跳过 */ }
  }
  return null
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36'

function cookieOf(c) {
  const parts = []
  if (c.sessdata) parts.push('SESSDATA=' + c.sessdata)
  if (c.biliJct) parts.push('bili_jct=' + c.biliJct)
  if (c.dedeuserid) parts.push('DedeUserID=' + c.dedeuserid)
  if (c.buvid3) parts.push('buvid3=' + c.buvid3)
  return parts.join('; ')
}

async function postForm(url, form, home, referer = 'https://www.bilibili.com/') {
  const c = readCred(home)
  if (!c || !c.biliJct) return { ok: false, code: -1, message: '没有可用的登录凭证（需要 bili_jct）' }
  try {
    const body = new URLSearchParams({ ...form, csrf: c.biliJct }).toString()
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Referer: referer,
        Origin: new URL(referer).origin,
        Cookie: cookieOf(c),
      },
      body,
    })
    const txt = await r.text()
    let j = {}
    try { j = JSON.parse(txt) } catch { /* 非 JSON */ }
    return { ok: r.ok && Number(j.code) === 0, http: r.status, code: Number(j.code ?? NaN), message: j.message || j.msg || txt.slice(0, 120) }
  } catch (e) {
    return { ok: false, code: -2, message: String((e && e.message) || e).slice(0, 120) }
  }
}

/** 删一条动态（网页接口） */
export async function deleteDynamic(home, dynamicId) {
  const id = String(dynamicId || '').trim()
  if (!/^\d+$/.test(id)) return { ok: false, message: '动态 id 不合法' }
  // 旧接口（vc 域）：很多账号还能用，但 B站 已在逐步下线（2026-11-1 实测列表接口已 404）
  const a = await postForm(
    'https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/rm_dynamic',
    { dynamic_id: id },
    home,
    'https://t.bilibili.com/',
  )
  if (a.ok) return a
  // 新接口兜底
  const b = await postForm(
    'https://api.bilibili.com/x/dynamic/feed/delete',
    { dynamic_id: id },
    home,
    'https://t.bilibili.com/',
  )
  if (b.ok) return b
  return { ok: false, message: '两个接口都失败（旧：' + (a.message || a.code) + '；新：' + (b.message || b.code) + '）。B站 可能已改版', code: b.code ?? a.code }
}

/** 删一个投稿（网页接口，需要 aid；没有 aid 就退而用 bvid 查一次） */
export async function deleteArchive(home, { aid, bvid }) {
  let target = aid ? String(aid) : ''
  const c = readCred(home)
  if (!target && bvid && c) {
    // 先查 aid
    try {
      const r = await fetch('https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid), {
        headers: { 'User-Agent': UA, Cookie: cookieOf(c) },
      })
      const j = await r.json()
      target = String(j?.data?.aid || '')
    } catch { /* 查不到就算了 */ }
  }
  if (!/^\d+$/.test(target)) return { ok: false, message: '拿不到稿件 aid（可能不是你的稿件，或接口改版）' }
  return postForm(
    'https://member.bilibili.com/x/vu/web/delete?aid=' + target,
    {},
    home,
    'https://member.bilibili.com/platform/upload-manager/article',
  )
}
