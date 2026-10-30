/**
 * update.mjs —— 版本自检 / 新版本提示（自己造的那套）
 * ============================================================================
 * 为什么要有它：DSH 自带的「检查更新」更新的是 DSH 软件本身，不会管我们的插件。
 *              所以由插件自己去 GitHub 问一句"仓库里的版本号是多少"，跟本地比一比。
 *
 * 四条铁律（改这个文件前先看这里）：
 *   ① 绝不拖慢 /state —— /state 每 2 秒被前端轮询，所以联网检查只能异步后台跑，
 *      snapshot() 只读内存里的缓存（毫秒级以下，不允许有任何 IO）。
 *   ② 绝不把插件搞崩 —— 每一步 try/catch。网络不通、被墙、返回乱码，一律当"没查到"，
 *      界面上不报错、不吓人。
 *   ③ 绝不多打请求 —— 结果缓存 6 小时，存在插件家目录的 update.json。
 *   ④ 勇于失败但给后路 —— 官方源被挡时，能自动或手动换 CDN / 加速代理 / 用户自定义地址。
 *
 * 配置存在：家目录/update.json（不碰 DSH 的 Config schema，免得 settings.update 抛）
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// 仓库身份统一放 version.mjs（手机版/电脑版只有这一个文件不同），这里不许再自己写一份
import { REPO } from './version.mjs'

const BRANCH = 'main'
const HOMEPAGE = `https://github.com/${REPO}`
/** GitHub 官方原始文件地址（其它加速源基本都是拿它做前缀拼接） */
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`
/** 给人看的版本主页 */
const RELEASES_URL = `https://github.com/${REPO}/releases`
/** 一键下载最新代码 */
const ZIP_URL = `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`

/**
 * 可用的更新源。id=auto 表示挨个试；custom 让用户自己填代理地址。
 * 这些加速站是第三方公益服务，随时可能失效——所以顺序即优先级，且失败就往下走。
 */
export const SOURCES = [
  { id: 'gh', label: 'GitHub 官方', url: RAW, note: '最准，国内有时打不开' },
  { id: 'jsdelivr', label: 'jsDelivr CDN', url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/package.json`, note: 'GitHub 官方合作 CDN，一般很稳' },
  { id: 'ghfast', label: 'ghfast 加速', url: `https://ghfast.top/${RAW}`, note: '第三方代理，专治直连失败' },
  { id: 'ghproxy', label: 'gh-proxy 加速', url: `https://gh-proxy.com/${RAW}`, note: '老牌第三方代理' },
  { id: 'custom', label: '自定义代理', url: '', note: '自己填一个能打开上面 GitHub 地址的前缀或完整地址' },
]
/** 排在前面的先试（auto 模式的尝试顺序） */
const AUTO_ORDER = ['gh', 'jsdelivr', 'ghfast', 'ghproxy']
const SOURCE_MAP = Object.fromEntries(SOURCES.map((s) => [s.id, s]))

/** 缓存多久：6 小时 */
const CACHE_MS = 6 * 60 * 60 * 1000
/** 单次联网超时：8 秒 */
const NET_TIMEOUT_MS = 8000

/* ── 进程内缓存（不落盘，最快路径） ───────────────────────────── */
let cache = { latest: '', checkedAt: 0, ok: false, source: '', tried: [] }
let cfg = { mode: 'auto', custom: '', autoCheck: true }
/** 并发去重：同一时间只允许一个网络检查在跑 */
let inflight = null

/* ── 配置读写（自己的小文件，不碰 DSH Config） ────────────────── */
const cfgFile = (home) => (home ? join(home, 'update.json') : '')

function loadCfg(home) {
  try {
    const f = cfgFile(home)
    if (!f || !existsSync(f)) return
    const j = JSON.parse(readFileSync(f, 'utf8'))
    if (!j || typeof j !== 'object') return
    // 一次性把「上次查到的版本」也捞回来，重启后不用立刻重新联网
    if (typeof j.latest === 'string' && j.latest) {
      cache = { latest: j.latest, checkedAt: Number(j.checkedAt) || 0, ok: true, source: j.source || '', tried: [] }
    }
    cfg = {
      mode: ['auto', ...SOURCES.map((s) => s.id)].includes(j.mode) ? j.mode : 'auto',
      custom: typeof j.custom === 'string' ? j.custom : '',
      autoCheck: j.autoCheck !== false,
    }
  } catch { /* 配置坏了就用默认值，照样能跑 */ }
}

function saveCfg(home) {
  try {
    const f = cfgFile(home)
    if (!f) return
    writeFileSync(f, JSON.stringify({
      mode: cfg.mode, custom: cfg.custom, autoCheck: cfg.autoCheck,
      latest: cache.latest, checkedAt: cache.checkedAt, source: cache.source,
    }, null, 2), 'utf8')
  } catch { /* 写不了盘不影响运行 */ }
}

/* ── 版本号比较 ─────────────────────────────────────────────── */
/** "v1.2.3-beta" → [1,2,3]；解析不出返回 null */
export function parseVer(s) {
  try {
    const m = String(s || '').trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/)
    return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null
  } catch { return null }
}
/** a>b 返回 1，相等 0，a<b 返回 -1；谁都解析不出来返回 0（不敢乱报新版本） */
export function cmpVer(a, b) {
  const x = parseVer(a)
  const y = parseVer(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) {
    if (x[i] > y[i]) return 1
    if (x[i] < y[i]) return -1
  }
  return 0
}

/* ── 联网 ───────────────────────────────────────────────────── */
/** 把用户填的 custom 变成完整 URL：可以只填前缀，也可以填完整地址 */
function resolveUrl(id) {
  if (id === 'custom') {
    const c = String(cfg.custom || '').trim()
    if (!c) return ''
    // 填的是完整地址就直接用；否则当代理前缀拼到官方地址前面
    if (/^https?:\/\//i.test(c)) return c
    return `https://${c.replace(/^\/+/, '')}/${RAW}`
  }
  return SOURCE_MAP[id]?.url || ''
}

/** 带超时的 fetch。任何网络问题都干净地失败并返回 null */
async function fetchText(url) {
  if (!url) return null
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch {} }, NET_TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'dsh-bili-console/update', accept: 'application/json,text/plain' },
    })
    if (!r || !r.ok) return null
    return await r.text()
  } catch { return null } finally { clearTimeout(timer) }
}

/* ── 对外 ───────────────────────────────────────────────────── */
/**
 * 给 /state 用的快照。纯内存读，不联网不读盘——必须在 1ms 内返回。
 * 就算一次都没查成功，返回的字段也要齐全且类型稳定，绝不让前端崩。
 */
export function snapshot(current) {
  const latest = cache.latest || ''
  return {
    ok: Boolean(cache.ok) && Boolean(latest),
    current: current || '0.0.0',
    latest,
    hasUpdate: Boolean(latest) && cmpVer(latest, current) > 0,
    checkedAt: cache.checkedAt || 0,
    source: cache.source || '',
    tried: Array.isArray(cache.tried) ? cache.tried : [],
    mode: cfg.mode,
    custom: cfg.custom || '',
    autoCheck: cfg.autoCheck !== false,
    sources: SOURCES.map((s) => ({ id: s.id, label: s.label, note: s.note })),
    url: RELEASES_URL,
    zipUrl: ZIP_URL,
    homepage: HOMEPAGE,
  }
}

/** 改配置（换加速源 / 开关自动检查） */
export function setUpdateOption(home, patch = {}) {
  if (patch.mode !== undefined && ['auto', ...SOURCES.map((s) => s.id)].includes(patch.mode)) cfg.mode = patch.mode
  if (patch.custom !== undefined) cfg.custom = String(patch.custom || '')
  if (patch.autoCheck !== undefined) cfg.autoCheck = Boolean(patch.autoCheck)
  saveCfg(home)
  return { mode: cfg.mode, custom: cfg.custom, autoCheck: cfg.autoCheck }
}

/**
 * 真正的检查动作（异步、并发去重）。
 * @returns {Promise<object>} snapshot 的同构结果，外加 ok / error 说明
 */
export async function checkUpdate({ current, home, force = false }) {
  const fresh = cache.checkedAt && (Date.now() - cache.checkedAt) < CACHE_MS
  if (fresh && cache.latest && !force) return { ...snapshot(current), cached: true }
  if (inflight) return await inflight

  inflight = (async () => {
    const order = cfg.mode === 'auto' ? AUTO_ORDER : [cfg.mode]
    const tried = []
    let found = null
    for (const id of order) {
      const url = resolveUrl(id)
      if (!url) { tried.push({ id, ok: false, why: id === 'custom' ? '还没填代理地址' : '源地址为空' }); continue }
      const txt = await fetchText(url)
      let v = null
      if (txt) {
        try { const maybe = JSON.parse(txt)?.version; if (typeof maybe === 'string' && parseVer(maybe)) v = maybe } catch { /* 返回的不是 JSON */ }
      }
      tried.push({ id, ok: Boolean(v), why: v ? '' : (txt ? '内容不是有效的 package.json' : '连不上或超时') })
      if (v) { found = { v, source: id }; break }
    }
    if (found) {
      cache = { latest: found.v, checkedAt: Date.now(), ok: true, source: found.source, tried }
      saveCfg(home)
    } else {
      // 全失败：把时间戳往前推一点，10 分钟后再说，免得每 2 秒重试把网络打满
      cache = { ...cache, checkedAt: Date.now() - CACHE_MS + 10 * 60 * 1000, ok: false, tried }
    }
    return { ...snapshot(current), cached: false }
  })().finally(() => { inflight = null })

  return await inflight
}

/** 插件挂载时调用：捞回上次的磁盘配置（同步、不联网） */
export function initUpdate(home) {
  loadCfg(home)
}
