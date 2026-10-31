/**
 * videogen.mjs —— 「最简图文视频」生成：AI 写文案 + 本地渲染
 * ============================================================================
 * 为什么做这一档（和用户 2026-10-31 讨论定的）：
 *   · 不上付费的生成式视频 API（可灵/即梦那种按秒烧钱）
 *   · 文字卡 + 免费配音 + 本地编码，零额外 API 费
 *   · 不依赖系统 ffmpeg：用 pip 装的 imageio-ffmpeg 自带的二进制
 *
 * 两条内容来源：
 *   ① 有模型链 → AI 写 3~6 张卡片（口播稿）
 *   ② 没有模型链 → 用今天刷到的标题拼一个"资讯合集"（纯模板，不需要任何 key）
 *
 * 渲染在独立 Python 进程里跑（vendor/bilibili-mcp/make_video.py），
 * 进度从它的 stdout 解析（PROGRESS n），手机上也扛得住（720p 静态卡片，很轻）。
 * ============================================================================
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolvePython } from './pyenv.mjs'
import { chat } from './llm.mjs'
import { resolvePersona, MAX_PERSONA } from './persona.mjs'
import { readReport, dayKey } from './state.mjs'

const execFileP = promisify(execFile)
const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(SELF_DIR, '..', 'vendor', 'bilibili-mcp', 'make_video.py')

let job = null

export function videoJobSnapshot() {
  if (!job) return { phase: 'idle', running: false, pct: 0, log: [] }
  return {
    phase: job.phase, pct: job.pct, log: (job.log || []).slice(-12),
    done: Boolean(job.done), error: job.error || '',
    running: !job.done && !job.error, outPath: job.outPath || '', startedAt: job.startedAt,
  }
}

function push(line) {
  if (!job) return
  job.log.push(String(line).split('\n')[0].slice(0, 200))
  if (job.log.length > 40) job.log.splice(0, job.log.length - 40)
}

/** 确保当前 Python 里有渲染依赖（没有就 pip 装，写到日志里） */
async function ensureVideoDeps(py) {
  const check = async () => {
    try {
      await execFileP(py, ['-c', 'import imageio_ffmpeg, edge_tts'], { timeout: 20000, windowsHide: true })
      return true
    } catch { return false }
  }
  if (await check()) { push('渲染依赖已就绪'); return true }
  push('首次使用：正在安装渲染依赖 imageio-ffmpeg / edge-tts（约 30MB，仅一次）…')
  try {
    await execFileP(py, ['-m', 'pip', 'install', '-q', 'imageio-ffmpeg', 'edge-tts',
      '-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'],
      { timeout: 600000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 })
    push('渲染依赖装好了')
    return await check()
  } catch (e) {
    push('渲染依赖安装失败：' + String((e && (e.stderr || e.message)) || e).slice(0, 200))
    return false
  }
}

/** 从今天刷到的标题拼一个不需要任何 key 的"资讯合集" */
function templateCards(home, n = 5) {
  const cards = []
  try {
    const rep = readReport(home, dayKey())
    const md = String(rep.markdown || '')
    const titles = [...md.matchAll(/标题：(.+)/g)].map((m) => m[1].trim()).filter(Boolean)
    if (titles.length) {
      cards.push({ title: '今天刷到的 ' + titles.length + ' 条', lines: ['按值得看的程度排了个序'], seconds: 3.5 })
      for (const t of titles.slice(0, n)) {
        cards.push({ title: t.slice(0, 22), lines: [t.slice(22, 70) || ''], seconds: 4 })
      }
      return cards
    }
  } catch { /* 没日报 */ }
  try {
    const seen = readFileSync(join(home, 'seen.md'), 'utf8')
    const bvs = [...new Set(seen.match(/BV[0-9A-Za-z]+/g) || [])].slice(0, n)
    if (bvs.length) {
      cards.push({ title: '这些视频我都看过了', lines: ['挑出来留个记录'], seconds: 3 })
      for (const bv of bvs) cards.push({ title: bv, lines: ['之前处理过的一条'], seconds: 2.5 })
      return cards
    }
  } catch { /* 没判重表 */ }
  return [
    { title: '今天先做个占位', lines: ['等你设置好关键词、跑过几轮之后', '这里就会自动变成资讯合集'], seconds: 4 },
  ]
}

/** 清晰度：默认 720（480 只作极端省电，会糊） */
export function pickQuality(cfg = {}) {
  const q = String(cfg.videoQuality || '720')
  if (q === '1080') return { w: 1920, h: 1080, fps: 30 }
  if (q === '480') return { w: 854, h: 480, fps: 20 }
  // '720' / 'auto' / 其它 → 720p（省电模式降一点帧率）
  return { w: 1280, h: 720, fps: cfg.lowPower ? 20 : 25 }
}

/* ───────── 素材库（图片当背景、音频当 BGM；每条必须有备注，AI 靠备注判断何时用） ───────── */
const ASSETS_META = (home) => join(home, 'assets', 'assets.json')
const ASSETS_DIR = (home) => join(home, 'assets')

function guessKind(f = '') {
  const s = String(f).toLowerCase()
  if (/\.(png|jpe?g|webp|gif|bmp)$/.test(s)) return 'image'
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(s)) return 'audio'
  if (/\.(mp4|mov|mkv|webm|avi)$/.test(s)) return 'video'
  return 'other'
}

/** 列出素材（目录里有但没登记的也列出来，提醒补备注） */
export function listAssets(home) {
  if (!home) return []
  let items = []
  try {
    const j = JSON.parse(readFileSync(ASSETS_META(home), 'utf8'))
    items = Array.isArray(j.items) ? j.items : []
  } catch { /* 还没建过 */ }
  // hint：从文件名猜一个默认备注（去掉扩展名、下划线换成空格），
  // 前端拿它当占位提示，用户点「按文件名批量填」就能一键铺满，不用逐个敲（2026-11-1）
  const hintOf = (f) => String(f).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim().slice(0, 60)
  items = items.filter((x) => x && x.file).map((x) => ({
    file: String(x.file),
    note: String(x.note || ''),
    hint: hintOf(x.file),
    kind: x.kind || guessKind(x.file),
  }))
  try {
    const known = new Set(items.map((i) => i.file))
    for (const f of readdirSync(ASSETS_DIR(home))) {
      if (f === 'assets.json') continue
      if (known.has(f)) continue
      items.push({ file: f, note: '', hint: hintOf(f), kind: guessKind(f) })
    }
  } catch { /* 目录还没建 */ }
  return items
}

/** 保存素材备注（只存 file/note/kind） */
export function saveAssets(home, items) {
  if (!home) return false
  const clean = (Array.isArray(items) ? items : [])
    .filter((x) => x && x.file)
    .map((x) => ({ file: String(x.file), note: String(x.note || '').slice(0, 200), kind: x.kind || guessKind(x.file) }))
  try {
    const dir = ASSETS_DIR(home)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(ASSETS_META(home), JSON.stringify({ items: clean }, null, 2))
    return true
  } catch { return false }
}

/** 指定模型就把它排到链首；没指定就用原链（= 和发评论同一条降级链） */
export function orderChain(cfg = {}, chain = []) {
  const pick = String(cfg.videoModel || '').trim()
  if (!pick || !Array.isArray(chain) || !chain.length) return chain
  const hit = chain.find((e) => e && (e.id === pick || e.label === pick || e.model === pick))
  if (!hit) return chain
  return [hit].concat(chain.filter((e) => e !== hit))
}

/**
 * 试听：用当前声线/语速/音调/音量念一句，返回 mp3 的 base64（免费 edge-tts，要联网）
 * 目的就是让你在正式生成前先听一口，不合适直接改，不用等整条视频渲染完。
 */
export async function previewTts({ cfg = {}, home = '', text = '', autoInstall = true } = {}) {
  const voice = cfg.videoVoiceName || 'zh-CN-XiaoxiaoNeural'
  const rate = cfg.videoVoiceRate || '+0%'
  const pitch = cfg.videoVoicePitch || '+0Hz'
  const volume = cfg.videoVoiceVolume || '+0%'
  const say = String(text || '').trim() || '你好，这是我的声音，检查一下语速和音调合不合适'
  const script = [
    'import sys, os, tempfile',
    'out = os.path.join(tempfile.gettempdir(), "dsh_tts_preview.mp3")',
    'try:',
    '    if os.path.exists(out): os.remove(out)',
    'except Exception: pass',
    'try:',
    '    import edge_tts, asyncio',
    'except Exception as e:',
    '    print("ERR:没装 edge-tts"); sys.exit(3)',
    'async def run():',
    '    await edge_tts.Communicate(sys.argv[1], sys.argv[2], rate=sys.argv[3], volume=sys.argv[4], pitch=sys.argv[5]).save(out)',
    'try:',
    '    asyncio.run(run())',
    'except Exception as e:',
    '    print("ERR:" + str(e)[:200]); sys.exit(4)',
  ].join('\n')
  // ⚠️ 必须传 home 拿 Python，不能传空：之前写成 resolvePython(cfg, '') 导致手机上
  //   取到的压根不是插件那个装了 edge-tts 的解释器 → 一直报「没装 edge-tts」（2026-11-1 修）
  const py = resolvePython(cfg, home) || 'python3'
  // 没装就自动补一次（和正式生成走同一套安装逻辑），这样不用让用户先去跑一遍完整生成
  if (autoInstall) {
    try {
      const ok = await ensureVideoDeps(py)
      if (!ok) return { ok: false, error: '配音组件装不上：检查网络后重试' }
    } catch (e) {
      return { ok: false, error: '配音组件安装失败：' + String((e && e.message) || e).slice(0, 120) }
    }
  }
  const args = [py, '-c', script, say, voice, rate, volume, pitch]
  return await new Promise((resolve) => {
    const p = spawn(args[0], args.slice(1), { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => { err += String(d) })
    p.stderr && p.stdout && p.stdout.on('data', (d) => { err += String(d) })
    p.on('error', () => resolve({ ok: false, error: 'Python 起不来' }))
    p.on('close', () => {
      try {
        const f = join(tmpdir(), 'dsh_tts_preview.mp3')
        if (existsSync(f)) {
          const buf = readFileSync(f)
          return resolve({ ok: true, voice, mime: 'audio/mpeg', audio: buf.toString('base64'), size: buf.length })
        }
      } catch { /* noop */ }
      const line = (err || '').split('\n').find((l) => l.startsWith('ERR:'))
      resolve({ ok: false, error: line ? line.slice(4) : '试听失败（edge-tts 要联网）' })
    })
  })
}

/**
 * 视频写稿的模型链（和评论彻底分开，用户 2026-11-1 要求）：
 *   custom = 视频专用自定义模型（设置里单独填接口/模型/Key），绝不与评论混
 *   chain  = 跟评论同一条降级链
 *   dsh（默认）= 只取 DSH 里配的模型，不走评论的自定义部分
 */
export function buildVideoChain(cfg = {}, { buildEndpoints, hostModels = [] } = {}) {
  if (cfg.videoModelSource === 'custom') {
    // ⚠️ 别再拿 videoCustomEnabled 卡了：那个开关界面上根本没暴露过，
    //   导致用户把地址/模型/Key 全填上还是空链 → 一直报「没有可用模型」（2026-11-1 修）
    //   现在只要选了 custom 且填了地址和模型名就能用；Key 留空也算（有些接口不需要密钥）
    if (!cfg.videoCustomBaseUrl || !cfg.videoCustomModel) return []
    return [{
      id: 'video-custom',
      label: cfg.videoCustomName || cfg.videoCustomModel,
          baseUrl: String(cfg.videoCustomBaseUrl).replace(/\/+$/, ''),
          apiKey: cfg.videoCustomKey || '',
          model: cfg.videoCustomModel,
          source: 'custom',
        }]
  }
  if (cfg.videoModelSource === 'chain') return buildEndpoints(cfg, hostModels)
  return buildEndpoints({}, hostModels)
}

/** 画面生成：调 OpenAI 兼容的 /images/generations，成功返回本地 PNG 路径 */
async function genImage(cfg, card, q, dir, idx) {
  const base = String(cfg.videoImageBaseUrl || '').replace(/\/+$/, '')
  const body0 = {
    model: cfg.videoImageModel,
    prompt: ('短视频卡片背景插图：' + (card.title || '') + '。' + ((card.lines || [])[0] || ''))
      .slice(0, 400) + '。扁平插画风格、简洁、无文字、深色底，适合在上面放白色字幕。',
    size: (q.w >= 1080 ? '1024x1024' : '1024x576'),
    n: 1,
    response_format: 'b64_json',
  }
  const post = async (body) => {
    const r = await fetch(base + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.videoImageKey },
      body: JSON.stringify(body),
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      const err = new Error('HTTP ' + r.status + (t ? ('：' + t.slice(0, 120)) : ''))
      err.status = r.status
      throw err
    }
    return r.json()
  }
  let j
  try {
    j = await post(body0)
  } catch (e) {
    // 智谱 CogView 这类不支持 response_format，且部分服务不支持 n 字段 → 去掉重试一次
    if (e.status === 400) {
      const body1 = { ...body0 }
      delete body1.response_format
      delete body1.n
      j = await post(body1)
    } else throw e
  }
  const d = (j.data || [])[0] || {}
  let buf = null
  if (d.b64_json) buf = Buffer.from(d.b64_json, 'base64')
  else if (d.url) {
    const ir = await fetch(d.url)
    if (!ir.ok) throw new Error('图片下载 HTTP ' + ir.status)
    buf = Buffer.from(await ir.arrayBuffer())
  }
  if (!buf || !buf.length) throw new Error('接口没返回图片（可能模型名不对）')
  const p = join(dir, 'gen-' + Date.now() + '-' + idx + '.png')
  writeFileSync(p, buf)
  return p.replace(/\\/g, '/')
}

/**
 * 让模型写口播稿。
 * ⚠️ 必须把「人格卡」塞进 system —— 之前漏了，导致视频文案和人格卡完全不像（用户 2026-10-31 指出）。
 */
async function aiCards(chain, topic, cfg, assets = []) {
  let personaText = ''
  try { personaText = String(resolvePersona(cfg.personaPrompt, cfg.personaMaxLen).text || '').slice(0, MAX_PERSONA) } catch { /* 没配人设 */ }
  const maxCards = Math.max(3, Math.min(8, Number(cfg.videoMaxCards) || 6))
  // 没手写备注也能用：退回文件名（hint）。用户嫌逐条打字麻烦，2026-11-1 改为全量参与
  const noteOf = (a) => (a.note && String(a.note).trim()) || a.hint || String(a.file || '').replace(/\.[^.]+$/, '')
  const imgs = (assets || []).filter((a) => a.kind === 'image')
  const auds = (assets || []).filter((a) => a.kind === 'audio')
  const assetBlock = (cfg.useAssets && (imgs.length || auds.length))
    ? ('\n===== 可用素材（只能从下面选，按备注判断该在哪用；没有合适的就别用）=====\n'
      + imgs.map((a) => '- 图片 ' + a.file + '：' + noteOf(a)).join('\n')
      + (auds.length ? ('\n' + auds.map((a) => '- 音频 ' + a.file + '：' + noteOf(a)).join('\n')) : '')
      + '\n输出时：每张卡片可以带 "asset":"图片文件名"（当背景）；整体可以带 "bgm":"音频文件名"。没合适的就留空。\n')
    : ''
  const sys = '你就是下面这个角色。用「你」的口吻和说话习惯写短视频口播稿。'
    + (personaText ? ('\n===== 你是谁（人格卡，语气必须照这个来）=====\n' + personaText + '\n=====\n') : '\n（没配人格卡，就用自然口语，别用新闻播报腔）\n')
    + assetBlock
    + '输出严格 JSON（不要代码块、不要解释）：{"cards":[{"title":"≤18字","lines":["≤2 条，每条≤40字"],"asset":"可选"}],"bgm":"可选"}'
    + ' 共 ' + maxCards + ' 张卡片；第一张是开场钩子，最后一张收尾；'
    + '措辞、情绪、用词都要像人格卡里的那个人，不要写成通稿；不编造数据、不喊口号。'
    + ' 严禁使用 emoji 表情符号（视频画面里显示不出来会变方框），想表达情绪就用文字。'
    + ' title 要短、有钩子；lines 每条完整成句，别只写两个词。'
  const user = (topic ? ('主题：' + topic) : '主题：用最近 B 站 AI 圈的热点，自己找一个具体角度')
    + '\n要求：每张卡片一行标题 + 最多 2 行正文，整体口播念下来 40~70 秒。'
  const r = await chat(chain, { system: sys, user, maxTokens: 900, temperature: 0.7, thinkingOff: cfg.thinkingOff !== false, level: cfg.thinkLevel || 'off' })
  if (!r.ok) throw new Error(r.lastError || '模型调用失败')
  const m = String(r.text || '').match(/\{[\s\S]*\}/)
  if (!m) throw new Error('模型没按 JSON 输出')
  const obj = JSON.parse(m[0])
  const cards = (obj.cards || []).filter((c) => c && (c.title || c.lines)).slice(0, maxCards).map((c) => ({
    title: String(c.title || '').slice(0, 34),
    lines: (Array.isArray(c.lines) ? c.lines : [c.lines]).filter(Boolean).map((x) => String(x).slice(0, 60)).slice(0, 3),
    seconds: 5,
    asset: String(c.asset || ''),
  }))
  if (!cards.length) throw new Error('模型返回的卡片是空的')
  return { cards, bgm: String(obj.bgm || '') }
}

/**
 * 开始生成。返回 {ok, error?}
 * @param {{home:string, cfg:object, chain:Array, topic?:string}} o
 */
export function startVideoJob({ home = '', cfg = {}, chain = [], topic = '' } = {}) {
  if (job && !job.done && !job.error) return { ok: false, error: '已经在生成了，等它跑完' }
  if (!home) return { ok: false, error: '插件家目录没确定' }
  job = { phase: '准备中', pct: 2, log: [], done: false, error: '', outPath: '', startedAt: Date.now() }
  push('开始生成视频' + (topic ? ('：' + topic) : ''))

  ;(async () => {
    try {
      const py = resolvePython(cfg, home) || 'python3'
      push('Python: ' + py)
      job.phase = '检查渲染依赖'
      job.pct = 6
      const depsOk = await ensureVideoDeps(py)
      if (!depsOk) throw new Error('渲染依赖装不上：检查网络后重试（或先在终端 pip install imageio-ffmpeg edge-tts）')

      job.phase = '写文案'
      job.pct = 12
      const useAI = cfg.videoUseAI !== false
      const chain2 = orderChain(cfg, chain)
      let assets = []
      if (cfg.useAssets) {
        assets = listAssets(home)
        push('素材库：' + assets.length + ' 个文件（没写备注的会用文件名代替，不会漏掉）')
      }
      let cards = null
      let bgm = ''
      if (useAI && Array.isArray(chain2) && chain2.length) {
        try {
          const first = chain2[0]
          push('让模型写口播稿' + (first && first.label ? ('（' + first.label + '）') : '') + '…')
          const gen = await aiCards(chain2, topic, cfg, assets)
          cards = gen.cards
          bgm = gen.bgm
          push('AI 写了 ' + cards.length + ' 张卡片（按人格卡口吻）' + (bgm ? '，选了 BGM：' + bgm : ''))
        } catch (e) {
          push('AI 写稿失败，改用今天的资讯合集：' + String((e && e.message) || e).slice(0, 120))
        }
      } else {
        push(useAI ? '模型链是空的（没配 key），改用今天的资讯合集 —— 不需要 key 也能出片' : '你关掉了「用 AI 写稿」，改用今天的资讯合集')
      }
      if (!cards) cards = templateCards(home, Math.max(1, (Number(cfg.videoMaxCards) || 6) - 1))

      job.phase = '渲染'
      job.pct = 20
      const dir = join(home, '.video')
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const out = join(dir, 'video-' + stamp + '.mp4')
      const specPath = join(dir, 'spec.json')
      const q = pickQuality(cfg)
      const voiceOn = cfg.videoVoice !== false
      // 素材：AI 选中的图片当背景、音频当 BGM（只认有备注的素材）
      const adir = ASSETS_DIR(home)
      const imgByName = new Map(assets.filter((a) => a.kind === 'image').map((a) => [a.file, join(adir, a.file)]))
      const audByName = new Map(assets.filter((a) => a.kind === 'audio').map((a) => [a.file, join(adir, a.file)]))
      const specCards = cards.map((c) => {
        const p = c.asset ? imgByName.get(c.asset) : ''
        return { title: c.title, lines: c.lines, seconds: c.seconds, bg: p && existsSync(p) ? String(p).replace(/\\/g, '/') : '' }
      })
      // 画面生成模型（可选）：没被素材库选中的卡片，用文生图接口补背景图
      if (cfg.videoImageEnabled && cfg.videoImageBaseUrl && cfg.videoImageModel && cfg.videoImageKey) {
        const need = specCards.filter((c) => !c.bg)
        if (need.length) {
          push('画面生成：调文生图接口画 ' + need.length + ' 张背景图（' + cfg.videoImageModel + '）…')
          job.phase = '生成背景图'
          let okCnt = 0
          for (let i = 0; i < specCards.length; i++) {
            const c = specCards[i]
            if (c.bg) continue
            try {
              const png = await genImage(cfg, c, q, dir, i)
              if (png) { c.bg = png; okCnt++ }
            } catch (e) {
              push('第 ' + (i + 1) + ' 张背景图生成失败，这张用纯色：' + String((e && e.message) || e).slice(0, 100))
            }
          }
          push(okCnt ? ('背景图生成了 ' + okCnt + '/' + specCards.length + ' 张') : '背景图一张都没生成出来，全部用纯色卡片')
        }
      } else if (cfg.videoImageEnabled) {
        push('开了画面生成但接口/模型/Key 没填全，跳过（用纯色卡片）')
      }
      const bgmPath = bgm && audByName.get(bgm) && existsSync(audByName.get(bgm)) ? String(audByName.get(bgm)).replace(/\\/g, '/') : ''
      push('画质 ' + q.w + 'x' + q.h + '@' + q.fps + 'fps · ' + (voiceOn ? '配音开（需联网）' : '配音关（渲染不联网）') + (bgmPath ? ' · BGM ✓' : ''))
      const spec = {
        out: out.replace(/\\/g, '/'),
        width: q.w,
        height: q.h,
        fps: q.fps,
        cards: specCards,
        bgm: bgmPath,
        layout: cfg.videoLayout || 'auto',   // 版式：auto 轮换 / 0~4 固定某一种
        lowPower: !!(cfg.lowPower || process.platform === 'linux'), // 省电/手机：ffmpeg 单线程 + ultrafast
        voice: {
          enabled: voiceOn,
          engine: cfg.videoTtsEngine || 'edge',
          url: cfg.videoTtsUrl || '',
          voice: cfg.videoVoiceName || 'zh-CN-XiaoxiaoNeural',
          rate: cfg.videoVoiceRate || '+0%',
          pitch: cfg.videoVoicePitch || '+0Hz',
          volume: cfg.videoVoiceVolume || '+0%',
        },
      }
      writeFileSync(specPath, JSON.stringify(spec, null, 2))

      await new Promise((resolve, reject) => {
        const p = spawn(py, [SCRIPT, specPath], { windowsHide: true })
        let buf = ''
        let errBuf = ''
        p.stdout.on('data', (d) => {
          buf += d.toString('utf8')
          let i
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim()
            buf = buf.slice(i + 1)
            if (!line) continue
            const m = line.match(/^PROGRESS\s+(\d+)$/)
            if (m) { job.pct = Math.max(job.pct, Math.min(99, Number(m[1]))); continue }
            push(line)
          }
        })
        p.stderr.on('data', (d) => { errBuf += d.toString('utf8') })
        p.on('error', (e) => reject(e))
        p.on('close', (code) => {
          if (code === 0 && existsSync(out)) resolve()
          else reject(new Error('渲染失败（退出码 ' + code + '）' + (errBuf ? '：' + errBuf.slice(-300) : '')))
        })
      })

      job.outPath = out
      job.done = true
      job.pct = 100
      job.phase = '完成'
      push('生成完成：' + out)
      // 渲染过程中会缓存大量帧/图片，手机内存紧张，跑完立刻放掉（2026-11-1）
      try {
        const { freeMemory } = await import('./memsave.mjs')
        const before = process.memoryUsage().rss
        freeMemory({ aggressive: true })
        const savedKb = Math.round((before - process.memoryUsage().rss) / 1024)
        if (savedKb > 1024) push('渲染完顺手释放了约 ' + Math.round(savedKb / 1024) + 'MB 内存')
      } catch { /* 释放失败不影响结果 */ }
    } catch (e) {
      job.error = String((e && e.message) || e).slice(0, 300)
      job.phase = '失败'
      push('失败：' + job.error)
    }
  })()

  return { ok: true }
}

/**
 * 渲染一张预览图（跟着当前版式设置走），返回 PNG 路径。
 * 用途：设置页选版式时立刻能看到长什么样，不用真生成一整条视频（2026-11-1）。
 */
export async function renderPreviewPng({ home = '', cfg = {}, style = '' } = {}) {
  const q = pickQuality(cfg)
  const dir = join(home, '.video')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const out = join(dir, 'preview-' + Date.now() + '.png')
  const specPath = join(tmpdir(), 'dshvideo_preview_' + Date.now() + '.json')
  const spec = {
    out: out.replace(/\\/g, '/'),
    width: q.w || 854,
    height: q.h,
    cards: [
      { title: '这一页长这样', lines: ['副标题一行，想换成你自己的风格就选别的'] },
      { title: '第二种版式', lines: ['换个版式看看效果'] },
      { title: '第三张', lines: ['随手看看'] },
    ],
    layout: style || cfg.videoLayout || 'auto',
    previewIndex: style && /^[0-4]$/.test(String(style)) ? Number(style) : 0,
  }
  writeFileSync(specPath, JSON.stringify(spec, null, 2))
  const py = resolvePython(cfg, home) || 'python3'
  const script = SCRIPT
  await new Promise((resolve) => {
    try {
      const p = spawn(py, [script, '--preview', specPath], { stdio: 'ignore', windowsHide: true })
      const t = setTimeout(() => { try { p.kill() } catch {} resolve(false) }, 30000)
      p.on('exit', () => { clearTimeout(t); resolve(true) })
      p.on('error', () => { clearTimeout(t); resolve(false) })
    } catch { resolve(false) }
  })
  try { rmSync(specPath, { force: true }) } catch {}
  return existsSync(out) ? out : ''
}

/**
 * 测一下文生图能不能用：真的生成一张小图，验证地址/模型名/Key 都对。
 * 智谱 CogView-3-Flash 免费，但接口细节和 OpenAI 不同（不支持 response_format），这里走同一套兼容逻辑。
 */
export async function testImageGen(cfg = {}) {
  const tmp = join(tmpdir(), 'dshimgtest-' + Date.now() + '.png')
  try {
    const p = await genImage(
      { ...cfg, videoImageBaseUrl: cfg.videoImageBaseUrl, videoImageKey: cfg.videoImageKey, videoImageModel: cfg.videoImageModel },
      { title: '测试', lines: ['一张简单插图'] },
      { w: 854, h: 480 },
      tmpdir(),
      0,
    )
    if (!p || !existsSync(p)) return { ok: false, error: '接口没返回图片' }
    const size = statSync(p).size
    try { rmSync(p, { force: true }) } catch { /* noop */ }
    return { ok: true, size }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) }
  } finally {
    try { rmSync(tmp, { force: true }) } catch { /* noop */ }
  }
}
