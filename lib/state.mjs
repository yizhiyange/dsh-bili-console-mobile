/**
 * lib/state.mjs —— 插件的"家"与配置
 * ============================================================================
 * 规矩：**配置、凭证、报告、日志都放插件自己的家** —— `$DSH_HOME/bili-console/`，
 * 绝不写进插件包目录（装进 node_modules 后可能只读、升级也会被覆盖）。
 *
 * 🔴 真机踩坑（2026-10-14，dsh 只留一句 warning + 堆栈）：
 *    `ctx.get('dshHomePath')` 返回的是**函数**，不是字符串！
 *    形状：`dshHomePath(...segments) => join(resolveDshHome(), ...segments)`
 *    当字符串用会让路径变成"函数源码+\bili-console" ⇒ mkdir ENOENT ⇒ 插件不激活。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 谷时窗口（北京时间）——官方口径：高峰=工作日 9-12 点与 14-18 点，其余全是谷时 */
export const WINDOWS = {
  noon:  { label: '中午谷时', start: '12:00', end: '14:00' },
  night: { label: '晚上/夜间谷时', start: '18:00', end: '09:00' },
}

/** 设置的默认值——和 index.js 的 Config schema 一一对应（改这里记得改那边） */
export const CONFIG_DEFAULTS = {
  // 挑与评
  keywords: [], perDay: 10, commentPerRound: 5, mentionName: '',
  mentionMode: 'model',     // @ 谁：model=让模型自己判断（默认）/ auto=关键词兜底 / always=每条都 @ / never=从不
  autoComment: false, replyToComments: false, replyPerRound: 1,
  // 视频从哪来 / 两级筛选（2026-10-31 加：固定关键词会一直捞同一个池子）
  useHomeFeed: true,        // 首页个性化推荐流（B站按账号口味实时推的，最新最相关）
  useKeywordSearch: true,   // 关键词搜索（用户可关；关键词也会慢慢培养账号的推荐口味）
  triage: true,             // 两级筛选：先批量粗筛（省 token），只对前几条取字幕深判
  triageTop: 5,             // 二级细看几条
  // 互动升级（2026-10-31 加）
  autoLike: false,          // 值得看的视频顺手点赞
  autoCoin: false,          // 值得看的视频投币（花自己的币，默认关）
  coinPerDay: 2,            // 每天最多投几个币
  // 视频生成（2026-10-31 加，独立配置，不和评论混在一起）
  videoVoice: true,         // 配音（edge-tts，免费但需要联网；关掉=纯画面，不联网也能出片）
  chainStrength: {},        // 每个模型单独的思考强度 { 模型id: off|low|medium|high }（2026-11-1 加）
  thinkLevel: 'off',        // 思考强度：off/low/medium/high（2026-11-1 加；只影响视频写稿，评论那边有自己的一套）
  videoVoiceName: 'zh-CN-XiaoxiaoNeural', // 配音声线（微软 edge-tts 的音色，见设置里的下拉）
  videoVoiceRate: '+0%',    // 语速，如 -20% 慢一点 / +20% 快一点
  videoVoicePitch: '+0Hz',  // 音调，如 -10Hz 更低沉 / +10Hz 更尖稚
  videoVoiceVolume: '+0%',  // 音量，如 +20% 更大声
  videoQuality: '720',      // '720'（默认）/ '1080' / '480'（极端省电，会糊）
  videoUseAI: true,         // 用模型写口播稿；关掉=用当天刷到的标题拼合集（不需要任何 key）
  videoMaxCards: 6,         // 最多几张卡片
  videoModel: '',           // 指定用哪个模型写稿；空=自动
  // 视频专用自定义模型（不进评论链；想给视频单独用哪家的 key 就填这里）
  videoCustomEnabled: false, // 是否启用视频专用自定义模型
  videoCustomBaseUrl: '',    // 接口地址，如 https://open.bigmodel.cn/api/paas/v4
  videoCustomModel: '',      // 模型名，如 glm-4-flash
  videoCustomKey: '',        // 该模型的 API Key（明文存在本地配置，与评论的密钥同级别）
  videoCustomName: '',       // 显示名（可选）
  // 画面生成模型（文生图接口，给每张卡片画背景图；OpenAI 兼容格式）
  videoImageEnabled: false,  // 开了才联网调文生图；关掉=纯色卡片
  videoImageBaseUrl: '',     // 接口地址，如 https://api.siliconflow.cn/v1
  videoImageModel: '',       // 模型名，如 Kwai-Kolors/Kolors
  videoImageKey: '',         // 该接口的 API Key
  videoModelSource: 'dsh',  // 'dsh'=直接从 DSH 配置里提取（默认，独立于评论链）/ 'chain'=跟评论同一条降级链
  useAssets: false,         // 启用素材库（图片当背景、音频当 BGM；每条素材必须有备注，AI 靠备注判断何时用）
  lowPower: false,          // 省电模式：界面轮询变慢、渲染更省 CPU（想边打游戏边跑就开）
  // 定时值守总开关：默认关。开了才会每 5 分钟自己跑一轮（否则只有你点按钮才跑）
  // —— 单独一个开关，避免"打开自动评论"顺带把每 5 分钟自动发帖也开起来
  schedulerOn: false,
  // 转写
  transcribe: false, asrModel: 'small',
  // 私信
  dmMode: 'off', dmUid: 0, dmWatch: true, dmWatchMinutes: 1, dmReplyPerDay: 0,
  // 节奏
  peakValley: false, noon: true, night: true,
  // 报告
  reportLevel: 'full', favFolderId: 0,
  // 人设
  personaPrompt: '', personaMaxLen: 8000,
  // 试验：把每轮小结投进 DSH 会话（默认关）
  dshSession: false,
  // 省 token：关掉模型思考（关不掉的就降到最低档）
  thinkingOff: true,
  // 上下文：isolated = 一条视频一个上下文（默认，互不串、不留对话）；
  //         thread   = 每条视频保留对话上下文（能接着聊，但落盘存别人的留言）
  contextMode: 'isolated',
  // 风控
  cooldownMinutes: 1440,
  // 技术（高级，只读展示）
  pythonPath: '', dshBin: '', headlessProfile: 'headless', overlayMcp: true, workspace: '',
  // 模型与降级链（自定义模型 + 顺序；预设从 DSH 提取，挂在 hostModels）
  models: [],                 // [{id,provider,displayName,apiUrl,modelName,apiKeySource,apiKey,customKey,customUrl,addToChain}]
  chainOrder: [],             // 模型 id 顺序（可拖动调序）
  visionModel: { apiUrl: '', apiKey: '', modelName: '' },  // 识图模型（自己填）
}

/** 插件家目录。ctx.get('dshHomePath') 是函数；拿不到就退到家目录下的 .dsh */
export function stateDirOf(ctx) {
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') return p('bili-console')
    if (typeof p === 'string' && p) return join(p, 'bili-console')
  } catch { /* 落到默认 */ }
  return join(homedir(), '.dsh', 'bili-console')
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = {}) {
  try {
    if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  } catch { /* 读不到用默认 */ }
  return fallback
}

export function writeJson(file, obj) {
  ensureDir(dirname(file))
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(obj, null, 2))
  renameSync(tmp, file)
}

function dirname(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i > 0 ? p.slice(0, i) : '.'
}

/** 读配置：默认值打底，用户值覆盖；记录哪些键被显式改过（_set） */
export function loadConfig(dir) {
  const file = join(dir, 'config.json')
  const raw = readJson(file, {})
  const cfg = { ...CONFIG_DEFAULTS }
  for (const k of Object.keys(CONFIG_DEFAULTS)) {
    if (raw[k] !== undefined && raw[k] !== null) cfg[k] = raw[k]
  }
  cfg._set = Array.isArray(raw._set) ? raw._set.slice() : []
  return cfg
}

/** 写配置：只认白名单键；自动备份；更新 _set。返回真正改动的键名 */
/**
 * 只保留最近 keep 份「配置文件备份」（2026-11-1 加，省磁盘）
 * 以前每次改配置就拷一份 .bak-<日期>，从来不删 → 跑几天就堆一堆，每份约 18KB，纯浪费。
 * 现在只留最近 2 份，够回滚了。
 */
export function pruneBackups(file, keep = 2) {
  try {
    // ⚠️ 这个文件里已经有自己实现的 dirname/basename 工具函数了，别再 import node:path 的同名方法（会重名报错）
    const dir = String(file).replace(/[/\\][^/\\]*$/, '')
    const base = String(file).split(/[/\\]/).pop() || 'config.json'
    const list = readdirSync(dir).filter((f) => f.startsWith(base + '.bak-')).sort()
    const drop = list.slice(0, Math.max(0, list.length - keep))
    for (const f of drop) {
      try { unlinkSync(join(dir, f)) } catch { /* 删不掉就算了 */ }
    }
    return drop.length
  } catch { return 0 }
}

export function saveConfig(dir, patch) {
  const file = join(dir, 'config.json')
  const raw = readJson(file, {})
  const changed = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in CONFIG_DEFAULTS)) continue
    const norm = normalize(k, v)
    if (JSON.stringify(raw[k]) !== JSON.stringify(norm)) {
      raw[k] = norm
      changed.push(k)
    }
  }
  if (changed.length) {
    try {
      copyFileSync(file, file + '.bak-' + new Date().toISOString().slice(0, 10))
      pruneBackups(file, 2)   // 只留最近 2 份，不然天天攒一份永远在涨（2026-11-1）
    } catch { /* 第一次没有原文件 */ }
    const set = new Set(Array.isArray(raw._set) ? raw._set : [])
    changed.forEach((k) => set.add(k))
    raw._set = [...set]
    writeJson(file, raw)
  }
  return changed
}

/** 按 schema 类型收敛（防呆：设置页传错类型不至于写坏配置） */
export function normalize(k, v) {
  const d = CONFIG_DEFAULTS[k]

  // ⚠️ 键专属规则必须放在通用类型规则**之前**：
  // 以前 models / chainOrder / visionModel 排在 Array.isArray(d) 后面，
  // 通用分支先 return 了，导致自定义模型被 v.map(String) 压成 "[object Object]"
  // —— 也就是说「自己加一个模型」这个功能从来没真正存进去过。（2026-10-29 修）
  if (k === 'models') {
    if (!Array.isArray(v)) return []
    return v.filter((m) => m && typeof m === 'object').map((m) => ({
      id: String(m.id || ('m' + Math.random().toString(36).slice(2, 9))),
      provider: String(m.provider || ''),
      displayName: String(m.displayName || m.modelName || ''),
      apiUrl: String(m.apiUrl || '').replace(/\/+$/, ''),
      modelName: String(m.modelName || ''),
      apiKeySource: m.apiKeySource === 'preset' ? 'preset' : 'custom',
      customKey: String(m.customKey || ''),
      addToChain: m.addToChain !== false,
    }))
  }
  if (k === 'chainOrder') return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []
  if (k === 'visionModel') {
    return (v && typeof v === 'object')
      ? { apiUrl: String(v.apiUrl ?? ''), apiKey: String(v.apiKey ?? ''), modelName: String(v.modelName ?? '') }
      : { apiUrl: '', apiKey: '', modelName: '' }
  }

  if (typeof d === 'number') {
    // 人设上限允许开到 20 万字（有人就是想写长），其它数值仍按 0~9999 保守夹取
    if (k === 'personaMaxLen') return Math.max(500, Math.min(200000, Math.floor(Number(v) || 8000)))
    return Math.max(0, Math.min(9999, Number(v) || 0))
  }
  if (typeof d === 'boolean') return Boolean(v)
  if (Array.isArray(d)) return Array.isArray(v) ? v.map((x) => String(x)) : []
  if (k === 'reportLevel') return ['full', 'brief', 'none', 'off'].includes(String(v)) ? String(v) : 'full'
  if (k === 'asrModel') return ['small', 'medium', 'large'].includes(String(v)) ? String(v) : 'small'
  if (k === 'asrMode') return ['local', 'cloud'].includes(String(v)) ? String(v) : 'local'
  if (k === 'dmMode') return ['off', 'only', 'both'].includes(String(v)) ? String(v) : 'off'
  if (k === 'personaPrompt') return String(v ?? '')
  return String(v ?? '')
}

/* ---------- 今日进度（state.json） ---------- */
export function loadState(dir) {
  return readJson(join(dir, 'state.json'), { day: '', count: 0, picked: 0, windows: {}, lastRunAt: '', lastWhy: '' })
}
export function saveState(dir, st) { writeJson(join(dir, 'state.json'), st) }

/* ---------- 判重表（seen.md） ---------- */
/** 粗解析判重表：统计看过的视频数与发过的评论数（展示用） */
export function parseSeen(md) {
  const text = String(md || '')
  const videos = (text.match(/^- \[[ x]\]\s*BV\S+/gm) || []).length
  const comments = (text.match(/^- \[[ x]\]\s*rpid[:：]?\s*\d+/gm) || []).length
  return { videos, comments }
}

/* ---------- 日报（out/<日期>.md） ---------- */
export function reportPath(dir, day) { return join(dir, 'out', `${day}.md`) }
export function readReport(dir, day) {
  const file = reportPath(dir, day)
  if (!existsSync(file)) return { date: day, exists: false, markdown: '', picked: 0 }
  const markdown = readFileSync(file, 'utf8')
  const picked = (markdown.match(/^###\s+BV/gm) || []).length
  return { date: day, exists: true, markdown, picked }
}

/* ---------- 本地日期 & 谷时判断 ---------- */
export function dayKey(d = new Date()) {
  // ⚠️ 固定按北京时间（UTC+8）算「今天」，不用进程本地时区。
  //   原因：安卓 proot 里 TZ 经常是 UTC，北京时间过了 0 点 dayKey 还是前一天
  //   → 每日额度永远不刷新（用户 2026-11-1 实测：13 轮、过了 0 点还挂在昨天）。
  const t = new Date(d.getTime() + 8 * 3600 * 1000)
  return t.toISOString().slice(0, 10)
}
function inRange(now, start, end) {
  const cur = now.getHours() * 60 + now.getMinutes()
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const s = sh * 60 + sm, e = eh * 60 + em
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e)  // 跨夜
}
/** 现在是否在任何一个开着的谷时窗口里 */
export function inWindow(cfg, now = new Date()) {
  if (cfg.noon && inRange(now, WINDOWS.noon.start, WINDOWS.noon.end)) return 'noon'
  if (cfg.night && inRange(now, WINDOWS.night.start, WINDOWS.night.end)) return 'night'
  return ''
}
