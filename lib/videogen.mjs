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
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
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

/** 清晰度：auto = 电脑 720p / 手机 480p（手机自己降档，不影响电脑） */
export function pickQuality(cfg = {}) {
  const q = String(cfg.videoQuality || 'auto')
  if (q === '720') return { w: 1280, h: 720, fps: 25 }
  if (q === '480') return { w: 854, h: 480, fps: 20 }
  const isMobile = process.platform === 'linux' // 安卓 / proot
  return isMobile ? { w: 854, h: 480, fps: 20 } : { w: 1280, h: 720, fps: 25 }
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
 * 让模型写口播稿。
 * ⚠️ 必须把「人格卡」塞进 system —— 之前漏了，导致视频文案和人格卡完全不像（用户 2026-10-31 指出）。
 */
async function aiCards(chain, topic, cfg) {
  let personaText = ''
  try { personaText = String(resolvePersona(cfg.personaPrompt, cfg.personaMaxLen).text || '').slice(0, MAX_PERSONA) } catch { /* 没配人设 */ }
  const maxCards = Math.max(3, Math.min(8, Number(cfg.videoMaxCards) || 6))
  const sys = '你就是下面这个角色。用「你」的口吻和说话习惯写短视频口播稿。'
    + (personaText ? ('\n===== 你是谁（人格卡，语气必须照这个来）=====\n' + personaText + '\n=====\n') : '\n（没配人格卡，就用自然口语，别用新闻播报腔）\n')
    + '输出严格 JSON（不要代码块、不要解释）：{"cards":[{"title":"≤18字","lines":["≤2 条，每条≤40字"]}]}'
    + ' 共 ' + maxCards + ' 张卡片；第一张是开场钩子，最后一张收尾；'
    + '措辞、情绪、用词都要像人格卡里的那个人，不要写成通稿；不编造数据、不喊口号。'
  const user = (topic ? ('主题：' + topic) : '主题：用最近 B 站 AI 圈的热点，自己找一个具体角度')
    + '\n要求：每张卡片一行标题 + 最多 2 行正文，整体口播念下来 40~70 秒。'
  const r = await chat(chain, { system: sys, user, maxTokens: 900, temperature: 0.7, thinkingOff: cfg.thinkingOff !== false })
  if (!r.ok) throw new Error(r.lastError || '模型调用失败')
  const m = String(r.text || '').match(/\{[\s\S]*\}/)
  if (!m) throw new Error('模型没按 JSON 输出')
  const obj = JSON.parse(m[0])
  const cards = (obj.cards || []).filter((c) => c && (c.title || c.lines)).slice(0, maxCards).map((c) => ({
    title: String(c.title || '').slice(0, 34),
    lines: (Array.isArray(c.lines) ? c.lines : [c.lines]).filter(Boolean).map((x) => String(x).slice(0, 60)).slice(0, 3),
    seconds: 5,
  }))
  if (!cards.length) throw new Error('模型返回的卡片是空的')
  return cards
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
      let cards = null
      if (useAI && Array.isArray(chain2) && chain2.length) {
        try {
          const first = chain2[0]
          push('让模型写口播稿' + (first && first.label ? ('（' + first.label + '）') : '') + '…')
          cards = await aiCards(chain2, topic, cfg)
          push('AI 写了 ' + cards.length + ' 张卡片（已按人格卡的口吻）')
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
      push('画质 ' + q.w + 'x' + q.h + '@' + q.fps + 'fps · ' + (voiceOn ? '配音开（需联网）' : '配音关（渲染不联网）'))
      const spec = {
        out: out.replace(/\\/g, '/'),
        width: q.w,
        height: q.h,
        fps: q.fps,
        cards,
        voice: { enabled: voiceOn, voice: 'zh-CN-XiaoxiaoNeural', rate: '+0%' },
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
    } catch (e) {
      job.error = String((e && e.message) || e).slice(0, 300)
      job.phase = '失败'
      push('失败：' + job.error)
    }
  })()

  return { ok: true }
}
