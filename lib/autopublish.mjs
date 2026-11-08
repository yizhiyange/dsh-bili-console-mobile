/**
 * autopublish.mjs —— 自动发视频（2026-11-08）
 * ============================================================================
 * 干什么的：
 *   刷视频插件本来就会"生成视频"（AI 写文案 → 配音字幕 → .video/video-*.mp4），
 *   但生成完就停了，得手动去投稿。这个模块把最后一公里接上：
 *
 *     扫 .video/ 目录发现新成片 → 排队 → 按「全自动 / 人工审核」两种模式投稿
 *
 * 设计原则（照用户 2026-11-08 定的方向）：
 *   ① 总开关默认关；关着的时候这个模块一个字节都不发。
 *   ② 全自动 = AI 文案直接投；人工审核 = 投稿前必须在控制台点确认。
 *   ③ 风控护栏（学 dsh-bili-upload-kit 的"三不"）：
 *      · 两次投稿最小间隔（默认 6 小时，可调）
 *      · 每日上限（默认 2 条）
 *      · 只投插件自己生成的成片（.video/ 目录里的 mp4），不碰别的文件
 *   ④ 投稿管道 100% 复用现有手动投稿（lib/bili.mjs 的 uploadVideo → vendor），
 *      不新写上传代码，登录、封面、分区逻辑都和手动那套完全一致。
 *   ⑤ 任何失败只记日志和队列状态，绝不影响刷视频主流程。
 * ============================================================================
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loginStatus, syncCredToVendor, newClient, uploadVideo } from './bili.mjs'

const dayKey = () => new Date().toISOString().slice(0, 10)

const stateFile = (home) => join(home, '.autopublish.json')

function loadState(home) {
  try { return JSON.parse(readFileSync(stateFile(home), 'utf8')) } catch { return { queue: [], lastPubMs: 0, day: '', dayCount: 0, lastScanMs: 0 } }
}
function saveState(home, s) {
  try { writeFileSync(stateFile(home), JSON.stringify(s, null, 2), 'utf8') } catch { /* 写不进就不记，别影响主流程 */ }
}

/** 从 spec.json 里把 AI 文案抠成投稿用的 标题/简介 */
function copyFromSpec(videoPath) {
  try {
    const spec = JSON.parse(readFileSync(join(videoPath, '..', 'spec.json'), 'utf8'))
    const cards = Array.isArray(spec.cards) ? spec.cards : []
    const first = cards[0] || {}
    const title = String(first.title || '').slice(0, 80)
    const desc = cards.slice(0, 6).map((c) => [c.title, ...(c.lines || [])].filter(Boolean).join('：')).join('；').slice(0, 240)
    return { title: title || 'AI 每日刷B站小结', desc }
  } catch { return { title: 'AI 每日刷B站小结', desc: '' } }
}

/**
 * 扫描 .video/ 目录，把还没登记过的新成片放进队列。
 * 频率没到、开关没开时不扫（省 IO）。返回本次新排进队了几条。
 */
export function enqueueNewVideos(home, cfg) {
  const s = loadState(home)
  const dir = join(home, '.video')
  if (!existsSync(dir)) { s.lastScanMs = Date.now(); saveState(home, s); return 0 }
  // 第一次扫描（lastScanMs 还是 0）：先记个基线，历史旧片一律不追投——
  // 用户开开关是为了"以后自动发"，不是想把以前生成的十几条一口气倒出去（风控大忌）。
  if (!s.lastScanMs) { s.lastScanMs = Date.now(); saveState(home, s); return 0 }
  const known = new Set(s.queue.map((q) => q.video))
  let added = 0
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.mp4') || known.has(f)) continue
    const p = join(dir, f)
    let mt = 0
    try { mt = statSync(p).mtimeMs } catch { continue }
    // 只登记这个模块启用之后生成的新片，历史旧片不追投（用户没让补发）
    if (mt < (s.lastScanMs || 0)) continue
    const copy = copyFromSpec(p)
    s.queue.push({
      id: 'ap' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      video: f, title: copy.title, desc: copy.desc,
      tid: Number(cfg.apTid) || 124,
      tags: String(cfg.apTags || 'AI,刷B站日报'),
      status: 'pending', createdAt: Date.now(), error: '', bvid: '',
    })
    added++
  }
  // 队列最多留 20 条，太老的失败项清掉，别越积越大
  s.queue = s.queue.slice(-20)
  s.lastScanMs = Date.now()
  saveState(home, s)
  return added
}

/** 配置是否满足"现在可以投一条"（登录/间隔/每日上限/时段） */
export function canPublishNow(cfg, s, scheduleOk) {
  if (!cfg.apOn) return { ok: false, why: '开关没开' }
  if (!scheduleOk) return { ok: false, why: '不在运行时段' }
  if (s.day !== dayKey()) { s.day = dayKey(); s.dayCount = 0 }
  const perDay = Math.max(1, Number(cfg.apPerDay) || 2)
  if (s.dayCount >= perDay) return { ok: false, why: '今天发够了（上限 ' + perDay + ' 条）' }
  const gapMs = Math.max(0.25, Number(cfg.apGapHours) || 6) * 3600e3
  if (s.lastPubMs && Date.now() - s.lastPubMs < gapMs) {
    return { ok: false, why: '离上次发布还不到 ' + (Number(cfg.apGapHours) || 6) + ' 小时' }
  }
  return { ok: true }
}

/**
 * 投一条：复用手动投稿的全套管道（登录校验 → vendor 上传 → 记账）。
 * entry.status: pending（等审）→ approved（审过，等投）→ done / failed
 */
export async function publishOne(home, cfg, entry, log) {
  const put = (m) => { try { log && log(m) } catch { /* noop */ } }
  try {
    if (!loginStatus(home).loggedIn) return { ok: false, error: '还没登录 B 站，去发布页扫码' }
    syncCredToVendor(home)
    const cli = newClient(cfg, home)
    try {
      const r = await uploadVideo(cli, {
        videoPath: join(home, '.video', entry.video),
        title: entry.title,
        desc: entry.desc,
        tid: entry.tid,
        tags: entry.tags,
        noReprint: true,
      })
      const ok = Boolean(r && r.success)
      put(ok ? '已自动投稿：' + entry.title.slice(0, 30) + '（' + (r.bvid || '') + '）' : '自动投稿失败：' + ((r && r.error) || '未知'))
      return { ok, bvid: (r && (r.bvid || (r.data && r.data.bvid))) || '', error: ok ? '' : ((r && r.error) || '未知') }
    } finally { try { cli.close() } catch { /* noop */ } }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}

/**
 * 后台调度 tick（每 60 秒被 index.js 调一次）：
 *   扫新片入队 → 全自动模式直接投到点的那条；人工审核模式只投 status=approved 的。
 */
export async function autoTick({ home, cfg, scheduleOk, log }) {
  try {
    if (!cfg.apOn) return { did: false }
    enqueueNewVideos(home, cfg)
    const s = loadState(home)
    const gate = canPublishNow(cfg, s, scheduleOk)
    if (!gate.ok) return { did: false, why: gate.why }
    // 全自动投最早的一条 pending；人工审核只投最早的一条 approved
    const pick = cfg.apMode === 'review'
      ? s.queue.find((q) => q.status === 'approved')
      : s.queue.find((q) => q.status === 'pending')
    if (!pick) return { did: false, why: cfg.apMode === 'review' ? '没有等你确认的视频' : '队列是空的' }
    pick.status = 'working'
    saveState(home, s)
    const r = await publishOne(home, cfg, pick, log)
    const s2 = loadState(home)
    const it = s2.queue.find((q) => q.id === pick.id) || pick
    it.status = r.ok ? 'done' : 'failed'
    it.bvid = r.bvid || ''
    it.error = r.error || ''
    it.publishedAt = Date.now()
    if (r.ok) { s2.lastPubMs = Date.now(); s2.dayCount = (s2.dayCount || 0) + 1 }
    saveState(home, s2)
    return { did: r.ok, bvid: r.bvid, error: r.error }
  } catch (e) {
    try { log && log('自动投稿调度异常：' + ((e && e.message) || e)) } catch { /* noop */ }
    return { did: false, error: String((e && e.message) || e) }
  }
}

/** 给前端的队列+状态快照（把 mp4 大小也带上，方便人认） */
export function autoSnapshot(home, cfg) {
  const s = loadState(home)
  if (s.day !== dayKey()) { s.day = dayKey(); s.dayCount = 0; saveState(home, s) }
  const items = s.queue.slice(-20).reverse().map((q) => {
    let size = 0
    try { size = statSync(join(home, '.video', q.video)).size } catch { /* 文件可能被清理了 */ }
    return { ...q, size }
  })
  const perDay = Math.max(1, Number(cfg.apPerDay) || 2)
  const gapMs = Math.max(0.25, Number(cfg.apGapHours) || 6) * 3600e3
  return {
    on: !!cfg.apOn,
    mode: cfg.apMode === 'review' ? 'review' : 'auto',
    gapHours: Number(cfg.apGapHours) || 6,
    perDay,
    todayCount: s.dayCount || 0,
    nextOkMs: s.lastPubMs ? s.lastPubMs + gapMs : 0,
    queue: items,
  }
}
