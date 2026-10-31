/**
 * lib/bili.mjs —— B站高层封装 + 凭证同步 + python 解析
 * ============================================================================
 * 这一层把"会网络/会起 python"的脏活收口，让上层（round / dm / index）只调业务。
 *
 * 凭证规矩（关键）：
 *   - python 的 mcp_server.py 登录成功后会把凭证写到 **vendor/bilibili-mcp/bili_credential.json**
 *   - 但插件家目录 `bili-console/bili_credential.json` 才是**真相源**：升级 node_modules
 *     会把 vendor 清掉，家目录不会被碰。
 *   - 所以：跑之前把家目录凭证 **拷到 vendor**（给 python 用）；登录成功后再把 vendor
 *     的 **拷回家目录**（持久化）。两处任一存在都算"已登录"。
 * ============================================================================
 */
import { existsSync, copyFileSync, statSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BiliMcp, ALLOWED_TOOLS } from './mcpc.mjs'
import { resolvePython } from './pyenv.mjs'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const VENDOR_DIR = join(SELF_DIR, '..', 'vendor', 'bilibili-mcp')

export function vendorDir() { return VENDOR_DIR }
export function vendorCredFile() { return join(VENDOR_DIR, 'bili_credential.json') }
export function homeCredFile(home) { return join(home, 'bili_credential.json') }

/** 两处任一存在且含有效凭证即视为已登录；返回 { loggedIn, at } */
export function loginStatus(home) {
  const v = vendorCredFile()
  const h = homeCredFile(home)
  for (const f of [h, v]) {
    if (existsSync(f)) {
      // 空凭证（文件是 {} 或关键字段全空）不算已登录，否则会骗过 UI 不弹二维码
      let valid = false
      try {
        const d = JSON.parse(readFileSync(f, 'utf-8'))
        valid = !!(d && (d.sessdata || d.bili_jct || d.dedeuserid))
      } catch { /* 读坏则当未登录 */ }
      if (!valid) continue
      let at = ''
      try { at = new Date(statSync(f).mtime).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) } catch { /* noop */ }
      return { loggedIn: true, at, file: f }
    }
  }
  return { loggedIn: false, at: '' }
}

/** 跑之前：家目录凭证覆盖到 vendor（给 python 用）。失败不致命。 */
export function syncCredToVendor(home) {
  const h = homeCredFile(home), v = vendorCredFile()
  if (existsSync(h)) { try { copyFileSync(h, v) } catch { /* noop */ } }
}

/** 登录成功后：vendor 凭证拷回家目录（持久化）。 */
export function syncCredToHome(home) {
  const h = homeCredFile(home), v = vendorCredFile()
  if (existsSync(v)) { try { copyFileSync(v, h) } catch { /* noop */ } }
}

/** 新开一个一次性 MCP 客户端（每轮独立，避免状态串味） */
export function newClient(cfg, home) {
  return new BiliMcp({ python: resolvePython(cfg, home), env: cfg.env || {} })
}

/* ----------------------------- 登录会话 ----------------------------- */

export class LoginSession {
  constructor(cfg, home) {
    this.home = home
    this.client = new BiliMcp({ python: resolvePython(cfg, home), env: cfg.env || {} })
    this.done = false
  }

  /** 生成二维码：返回 { status, qrcode_image?, qrcode_url?, message } */
  async start() {
    await this.client.callTool('bili_login') // 触发握手 + 起会话
    const txt = await this.client.callText('bili_login')
    try { return JSON.parse(txt) } catch { return { status: 'error', message: txt } }
  }

  /** 轮询状态：返回解析后的对象；status==='done' 时同步凭证回家目录 */
  async check() {
    const txt = await this.client.callText('bili_login_check')
    let obj
    try { obj = JSON.parse(txt) } catch { return { status: 'error', message: txt } }
    if (obj.status === 'done') { syncCredToHome(this.home); this.done = true }
    return obj
  }

  /** 校验当前凭证是否有效（uid/用户名） */
  async verify() {
    const txt = await this.client.callText('bili_check_credential')
    try { return JSON.parse(txt) } catch { return { logged_in: false, message: txt } }
  }

  close() { try { this.client.close() } catch { /* noop */ } }
}

/* ----------------------------- 业务封装 ----------------------------- */

/** 搜索视频，返回 [{ bvid, title, ... }]（尽力解析） */
export async function searchVideos(client, keyword, num = 10, order = 'totalrank') {
  const txt = await client.callText('bili_search', { keyword, num, order })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 首页个性化推荐流：B站按登录账号的口味实时推的视频（天然新鲜，不会像关键词那样反复捞同一个池子） */
export async function homeFeed(client, num = 20) {
  const txt = await client.callText('bili_home_feed', { num })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 点赞（status=1 点赞，0 取消） */
export async function likeVideo(client, bvid, status = 1) {
  const txt = await client.callText('bili_like', { bvid, status })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 投币（num 1~2；likeAlso=1 时顺便点赞） */
export async function coinVideo(client, bvid, num = 1, likeAlso = 0) {
  const txt = await client.callText('bili_coin', { bvid, num, like_also: likeAlso })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 取某视频评论（num 条） */
export async function getComments(client, bvid, num = 30) {
  const txt = await client.callText('bili_comments', { bvid, num })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 取字幕（无字幕时返回空/提示） */
export async function getSubtitle(client, bvid) {
  const txt = await client.callText('bili_subtitle', { bvid })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 发评论；rpid/root 为 0 表示发在视频下，非零表示回复某条 */
export async function postComment(client, bvid, text, rpid = 0, root = 0) {
  const txt = await client.callText('bili_reply', { bvid, text, rpid, root })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 发私信给某人 */
export async function sendMessage(client, uid, text) {
  const txt = await client.callText('bili_send_message', { receiver_uid: Number(uid), text })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 取未读私信 */
export async function unreadMessages(client) {
  const txt = await client.callText('bili_unread_messages')
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/**
 * 谁回复了我的评论 / @ 了我（B站 消息里的"回复我的"）
 * 返回 { items: [{ id, user:{mid,nickname,avatar}, item:{ root_id, target_id, uri, source_content,
 *          root_reply_content, title, subject_id }, reply_time }] }
 */
export async function receivedReplies(client) {
  const txt = await client.callText('bili_received_replies', {})
  try { return JSON.parse(txt) } catch { return { items: [] } }
}

/** 取视频详情（含封面 pic、时长等） */
export async function videoInfo(client, bvid) {
  const txt = await client.callText('bili_video_info', { bvid })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 我的收藏夹列表 */
export async function favoriteLists(client, uid = 0) {
  const txt = await client.callText('bili_favorite_lists', uid ? { uid: Number(uid) } : {})
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 把视频加入收藏夹 */
export async function addFavorite(client, bvid, mediaId) {
  const txt = await client.callText('bili_favorite_add', { bvid, media_id: Number(mediaId) })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 取音频流地址（给本地转写用） */
export async function audioUrl(client, bvid) {
  const txt = await client.callText('bili_audio_url', { bvid })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 删除自己发的一条评论（撤回用）。只能删自己的，B站 侧会校验 */
export async function deleteComment(client, bvid, rpid) {
  const txt = await client.callText('bili_comment_delete', { bvid, rpid: Number(rpid) })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/* ----------------------------- 发布能力（2026-10-31 新增，自己写的上层） ----------------------------- */
/* 说明：底层工具是 MIT 开源 bilibili-mcp 自带的，这里只做 JS 封装，不复制底层逻辑。 */

/** 发图文动态：text 必填，images 最多9张（本地路径或 URL），topic_id 话题，schedule_time 定时戳 */
export async function sendDynamic(client, { text, images = [], topicId = 0, scheduleTime = 0 } = {}) {
  const txt = await client.callText('bili_send_dynamic', {
    text: String(text || ''),
    images: Array.isArray(images) ? images.slice(0, 9) : [],
    topic_id: Number(topicId) || 0,
    schedule_time: Number(scheduleTime) || 0,
  })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 上传单P视频：video_path 必填，title 必填，其余可选。返回含 BV 号的结果。 */
export async function uploadVideo(client, o = {}) {
  const txt = await client.callText('bili_upload_video', {
    video_path: String(o.videoPath || ''),
    title: String(o.title || ''),
    desc: String(o.desc || ''),
    tid: Number(o.tid) || 124,
    tags: String(o.tags || 'AI'),
    cover_path: String(o.coverPath || ''),
    source: String(o.source || ''),
    dynamic_text: String(o.dynamicText || ''),
    no_reprint: o.noReprint !== false,
  })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 上传多P视频：videoPaths / pageTitles 等长数组 */
export async function uploadVideoMulti(client, o = {}) {
  const txt = await client.callText('bili_upload_video_multi', {
    video_paths: Array.isArray(o.videoPaths) ? o.videoPaths.map(String) : [],
    page_titles: Array.isArray(o.pageTitles) ? o.pageTitles.map(String) : [],
    title: String(o.title || ''),
    desc: String(o.desc || ''),
    tid: Number(o.tid) || 124,
    tags: String(o.tags || 'AI'),
    cover_path: String(o.coverPath || ''),
    source: String(o.source || ''),
  })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 发图文专栏（Opus）：title + content 正文，images 可选 */
export async function sendOpus(client, { title, content, images = [] } = {}) {
  const txt = await client.callText('bili_send_opus', {
    title: String(title || ''),
    content: String(content || ''),
    images: Array.isArray(images) ? images : [],
  })
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

/** 查常用分区 ID（供上传时选 tid） */
export async function videoZones(client) {
  const txt = await client.callText('bili_video_zones', {})
  try { return JSON.parse(txt) } catch { return { raw: txt } }
}

export { ALLOWED_TOOLS }
