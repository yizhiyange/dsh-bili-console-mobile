/**
 * lib/round.mjs —— 每日值守引擎（真正去 B站干活的那个）
 * ============================================================================
 * 一轮要做的事（对齐 prompts/duty.md）：
 *   1) 守门：安全模式/风控冷却/未登录/谷时窗口/每日上限 —— 不满足就老实跳过并说明
 *   2) 按关键词搜视频 → 判重（seen.md）→ 挑 N 条（受 perDay 与 commentPerRound 限制）
 *   3) 每条：取字幕+评论采样 → 拼"人设+章程" → 调模型链写评论 → 发出
 *   4) 风控码命中（验证码/限流/今天收工）→ 按 guardian 进入冷却并停手
 *   5) 写 seen.md 判重、更新 state.json、追加 out/<日期>.md 日报
 *
 * 边界（用户特别强调过的）：
 *   - 判重表读不到 → 当"空"继续，但记一条日志，绝不因为少个文件就崩
 *   - 安全模式（评论与私信都关）→ 不真发，只说明无可执行动作
 *   - LLM/网络抖动 → 降级或跳过本条，不断整轮
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadConfig, loadState, saveState, parseSeen, readReport, dayKey, inWindow,
} from './state.mjs'
import { resolvePersona, MAX_PERSONA } from './persona.mjs'
import { resolvePython } from './pyenv.mjs'
import { Cooldown, decide, classify } from './guardian.mjs'
import { buildEndpoints, applyDefaultModelToDsh } from './chain.mjs'
import { chat } from './llm.mjs'
import {
  newClient, syncCredToVendor, loginStatus, searchVideos, getSubtitle, getComments, postComment, receivedReplies,
  videoInfo, audioUrl, addFavorite,
} from './bili.mjs'
import { appendTurn, threadContextText, loadReplied, markReplied } from './memory.mjs'
import { recordPost } from './retract.mjs'
import { describeImage, visionReady } from './vision.mjs'
import { transcribeFile, asrStatus, transcribeCloud, asrReadiness } from './asr.mjs'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const DUTY = (() => {
  try { return readFileSync(join(SELF_DIR, '..', 'prompts', 'duty.md'), 'utf8') } catch { return '你是B站值班助手。' }
})()

/** 从搜索结果里抠 BV 号（先试 JSON 字段，再退化到全文正则） */
function extractBvids(thing) {
  const found = new Set()
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (typeof o.bvid === 'string' && /^BV[0-9A-Za-z]+$/.test(o.bvid)) found.add(o.bvid)
    if (typeof o.bv === 'string' && /^BV[0-9A-Za-z]+$/.test(o.bv)) found.add(o.bv)
    if (Array.isArray(o)) o.forEach(walk)
    else for (const k of Object.keys(o)) walk(o[k])
  }
  try { walk(thing) } catch { /* noop */ }
  if (found.size) return [...found]
  const raw = typeof thing === 'string' ? thing : JSON.stringify(thing)
  return [...new Set((raw.match(/BV[0-9A-Za-z]+/g) || []))]
}

export function appendSeen(home, bvid, rpid = 0, tag = '') {
  const f = join(home, 'seen.md')
  let existing = ''
  try { existing = readFileSync(f, 'utf8') } catch { /* 第一次 */ }
  const id = String(bvid || '').replace(/^BV/i, '')   // 统一存成 BVxxx，避免 BVBVxxx
  if (!id) return
  // 已经记过就不再写第二遍——判重表是"刷过"的名单，同一个视频只该有一行（2026-10-31 修）
  const lines = []
  if (!existing.includes('BV' + id)) lines.push('- [ ] BV' + id + (tag ? ' · ' + tag : ''))
  if (rpid) lines.push('- [ ] rpid:' + rpid)
  if (lines.length) { try { appendFileSync(f, lines.join('\n') + '\n') } catch { /* 写不出不致命 */ } }
}

/**
 * 读「所有刷过的 BV」——三个来源合起来，少读一个都会重复刷（2026-10-31 修）：
 *   ① seen.md 判重表（最直接）
 *   ② out/ 里**所有日期**的日报（老版本只在"真发出去"时才写 seen.md，试跑/失败/未发布的只有日报留了记录）
 *   ③ posted.json 评论记录（真发过的评论都在这，双保险）
 * 以前只读今天的日报，等于把昨天的历史全忘了 —— 用户看到的就是"又在刷以前刷过的"。
 */
export function loadSeenSet(home) {
  const out = new Set()
  const addFrom = (text) => { for (const m of String(text || '').match(/BV[0-9A-Za-z]+/g) || []) out.add(m) }
  try { addFrom(readFileSync(join(home, 'seen.md'), 'utf8')) } catch { /* 第一次 */ }
  try {
    const dir = join(home, 'out')
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue
      try { addFrom(readFileSync(join(dir, f), 'utf8')) } catch { /* 单个文件读不到就跳过 */ }
    }
  } catch { /* 还没写过日报 */ }
  try {
    const p = JSON.parse(readFileSync(join(home, 'posted.json'), 'utf8'))
    for (const it of (p.items || [])) if (it && it.bvid) addFrom(it.bvid)
  } catch { /* 还没发过评论 */ }
  return out
}

/**
 * 今天日报里「已经正式处理过」的 BV。
 * 试跑块（带 `状态：试跑`）**不算**——试跑只是预览，不该吃掉当天的候选，
 * 否则你试跑几次之后，正式跑就会"没得挑"。
 */
function loadReportBvSet(home, day) {
  try {
    const t = readFileSync(join(home, 'out', `${day}.md`), 'utf8')
    const blocks = t.split(/\n(?=###\s)/).filter((b) => b.trim())
    const out = new Set()
    for (const b of blocks) {
      if (/状态[:：]\s*试跑/.test(b)) continue          // 预览，不算已处理
      const m = b.match(/^###\s+(BV[0-9A-Za-z]+)/)
      if (m) out.add(m[1])
    }
    return out
  } catch { return new Set() }
}

/** 写日报：同一个 BV 只保留一块（试跑改正式时直接替换，不留重复） */
function upsertReportBlock(home, day, bvid, block) {
  const dir = join(home, 'out')
  const f = join(dir, `${day}.md`)
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }) } catch { /* noop */ }
  let blocks = []
  try {
    const t = readFileSync(f, 'utf8')
    blocks = t.split(/\n(?=###\s)/).filter((b) => b.trim())
  } catch { /* 还没有文件 */ }
  const id = String(bvid || '')
  blocks = blocks.filter((b) => {
    const m = b.match(/^###\s+(BV[0-9A-Za-z]+)/)
    return !(m && m[1] === id)
  })
  blocks.push(String(block || '').trim())
  try { writeFileSync(f, blocks.join('\n\n') + '\n') } catch { /* 写不出不致命 */ }
}

function appendReport(home, day, block) {
  const dir = join(home, 'out')
  const f = join(dir, `${day}.md`)
  try {
    if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }) }
  } catch { /* noop */ }
  try { appendFileSync(f, block + '\n') } catch { /* noop */ }
}

/** 从搜索结果里抽出结构化候选（bvid/标题/作者/播放/评论数/时长/简介） */
function extractVideos(thing) {
  const out = []
  const seen = new Set()
  const push = (o) => {
    const bv = o && (o.bvid || o.bv)
    if (typeof bv !== 'string' || !/^BV[0-9A-Za-z]+$/.test(bv) || seen.has(bv)) return
    seen.add(bv)
    out.push({
      bvid: bv,
      title: String(o.title || o.name || bv),
      author: String(o.author || o.owner || o.up || ''),
      play: Number(o.play ?? o.view ?? 0) || 0,
      review: Number(o.review ?? o.comment ?? 0) || 0,
      duration: String(o.duration || ''),
      description: String(o.description || o.desc || ''),
    })
  }
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { o.forEach(walk); return }
    if (typeof (o.bvid || o.bv) === 'string') { push(o); return }
    for (const k of Object.keys(o)) walk(o[k])
  }
  try { walk(thing) } catch { /* noop */ }
  if (out.length) return out
  // 兜底：只有裸文本时，至少保住 BV 号
  const raw = typeof thing === 'string' ? thing : JSON.stringify(thing)
  return [...new Set(raw.match(/BV[0-9A-Za-z]+/g) || [])].map((bvid) => ({ bvid, title: bvid, author: '', play: 0, review: 0, duration: '', description: '' }))
}

/**
 * 把「@ 谁」拼到评论末尾。
 * 注意：这是**文字形式的 @**，B站 不一定会给对方发提醒（真正的 at 控件需要
 * 接口支持 at 段，MCP 的 bili_reply 没有这个参数）。界面上已注明。
 */
function withMention(text, name) {
  const t = String(text || '').trim()
  const n = String(name || '').trim().replace(/^@+/, '')
  if (!t || !n) return t
  if (t.indexOf('@' + n) >= 0) return t
  return (t + ' @' + n).slice(0, 1000)
}

/** 从模型回复里抠出 {grade, reason, comment} */
function parseJudge(text, fallbackTitle) {
  const t = String(text || '').trim()
  let obj = null
  const m = t.match(/\{[\s\S]*\}/)
  if (m) { try { obj = JSON.parse(m[0]) } catch { /* 不是标准 JSON */ } }
  const gradeOf = (s) => {
    if (/不值当/.test(s)) return '不值当'
    if (/可以看/.test(s)) return '可以看'
    if (/值得看/.test(s)) return '值得看'
    return ''
  }
  const grade = (obj && gradeOf(obj.grade || obj.verdict || '')) || gradeOf(t) || '可以看'
  let reason = (obj && (obj.reason || obj.why)) || ''
  if (!reason) {
    // 去掉 JSON / 评级词，剩下的当理由
    reason = t.replace(/\{[\s\S]*\}/, '').replace(/值得看|可以看|不值当/g, '').replace(/^[\s:：,，\-—]+/, '').trim()
  }
  if (!reason) reason = '模型没有给出理由'
  const comment = (obj && (obj.comment || obj.reply)) || ''
  return { grade, reason: reason.slice(0, 120), comment: String(comment || '').trim(), title: fallbackTitle }
}

/**
 * 跑一轮。
 * @param {object}  opt { home, cfg?, force?, hostModels?, dryRun?, log? }
 *   dryRun=true → 「试跑」：真去搜索、真用 AI 挑、真写日报，但**绝不发评论/私信**
 * @returns {Promise<{ran:boolean, why:string, scanned:number, picked:number, posted:number, errors:string[], degraded:boolean, dryRun:boolean}>}
 */
export async function runRound({ home, force = false, hostModels = [], dryRun = false, shouldStop = () => false, python = '', log = () => {} }) {
  const cfg = loadConfig(home)
  let pyPath = python
  try { pyPath = pyPath || resolvePython(cfg, home) } catch { /* 用默认 */ }
  const guardian = new Cooldown(home)
  const summary = { ran: false, why: '', scanned: 0, picked: 0, posted: 0, errors: [], degraded: false, dryRun, stopped: false, skippedSeen: 0 }
  /** 用户点了「停止」：在任何一步之前都能体面退出，不会发到一半 */
  const halted = () => { if (shouldStop()) { summary.stopped = true; return true } return false }

  // 1) 守门
  if (guardian.active()) {
    summary.why = `风控冷却中（还剩约 ${Math.ceil(guardian.remaining() / 60000)} 分钟），先歇着`
    return summary
  }
  const safeMode = !cfg.autoComment && cfg.dmMode === 'off'
  // 安全模式默认不跑；但「试跑（只挑不发）」明确要来，就放行——只是绝对不发任何东西
  if (safeMode && !dryRun) {
    summary.why = '安全模式：自动评论与私信都关着，没有可执行的动作。想先看它怎么挑，点「试跑（只挑不发）」；想真发，去"设置"里打开自动评论或私信。'
    return summary
  }
  const login = loginStatus(home)
  if (!login.loggedIn) {
    summary.why = '还没登录B站：先去"登录"页扫码登录，再跑值守。'
    return summary
  }
  if (!force && cfg.peakValley && !inWindow({ noon: cfg.noon, night: cfg.night }, new Date())) {
    summary.why = '现在是高峰时段，且你开了"谷时值守"，本时辰不动作。'
    return summary
  }
  if (!Array.isArray(cfg.keywords) || cfg.keywords.length === 0) {
    summary.why = '还没设关键词：去"设置"里加几个要刷的领域关键词。'
    return summary
  }

  // 2) 每日上限
  const st = loadState(home)
  const day = dayKey()
  if (st.day !== day) { st.day = day; st.count = 0; st.picked = 0 }
  const remainQuota = Math.max(0, (cfg.perDay || 0) - (st.count || 0))
  if (remainQuota <= 0) {
    summary.why = `今天 ${cfg.perDay} 条配额已用完，收工。`
    return summary
  }

  // 3) 起 MCP 客户端 + 同步凭证
  syncCredToVendor(home)
  const client = newClient(cfg, home)
  const chain = buildEndpoints(cfg, hostModels)
  const persona = resolvePersona(cfg.personaPrompt, cfg.personaMaxLen)

  const seen = loadSeenSet(home)
  const inReport = loadReportBvSet(home, day)   // 今天日报里已有的，不再重复判
  const seenSet = new Set()  // 本轮内防重复
  const useThread = cfg.contextMode === 'thread'   // 是否保留每条视频的对话上下文
  let stoppedByRisk = false

  // 本轮最多挑几条：试跑按 perDay，真发按 commentPerRound 与剩余配额
  const limit = Math.max(1, Math.min(
    dryRun ? (cfg.perDay || 5) : (cfg.commentPerRound || 5),
    remainQuota || 1,
  ))

  /** 让模型判一条：值得看 / 可以看 / 不值当 + 理由（+ 可选评论） */
  const judge = async (v) => {
    let subtitle = ''
    try { const s = await getSubtitle(client, v.bvid); subtitle = typeof s === 'string' ? s : JSON.stringify(s) } catch { /* 没字幕 */ }
    // 没字幕的两条兜底：① 本地转写（要装 faster-whisper）② 识图看封面
    let asrNote = ''
    if (!subtitle && cfg.transcribe) {
      // 本地（要装 faster-whisper）还是云端（填个 API 就能用）由 asrMode 决定
      const st = await asrReadiness(cfg, pyPath || 'python').catch(() => ({ ready: false, mode: 'local', reason: '探测失败' }))
      if (!st.ready) asrNote = '转写没开起来：' + (st.reason || '')
      else {
        try {
          const a = await audioUrl(client, v.bvid)
          if (a && a.success && a.url) {
            const tmp = join(tmpdir(), 'bili-' + v.bvid + '.m4a')
            const buf = Buffer.from(await (await fetch(a.url)).arrayBuffer())
            writeFileSync(tmp, buf)
            const tr = st.mode === 'cloud'
              ? await transcribeCloud({ apiUrl: cfg.asrCloudUrl, apiKey: cfg.asrCloudKey, model: cfg.asrCloudModel, audioPath: tmp })
              : await transcribeFile(pyPath || 'python', tmp, cfg.asrModel || 'small')
            try { unlinkSync(tmp) } catch { /* noop */ }
            if (tr.ok) subtitle = (st.mode === 'cloud' ? '（云端转写）' : '（本地转写）') + tr.text
            else asrNote = '转写失败：' + (tr.error || '')
          } else asrNote = '拿不到音频地址：' + ((a && a.error) || '')
        } catch (e) { asrNote = '转写异常：' + String(e?.message || e).slice(0, 100) }
      }
      if (asrNote) log('  ' + asrNote)
    }
    let look = ''
    if (!subtitle && visionReady(cfg)) {
      try {
        const info = await videoInfo(client, v.bvid)
        const pic = (info && (info.pic || (info.data && info.data.pic))) || ''
        if (pic) {
          const d = await describeImage(cfg, pic, '这是视频封面。用一句话说清画面内容和它想表达什么（30字内）。')
          if (d.ok) look = d.text
          else log('  识图失败：' + d.error)
        }
      } catch (e) { log('  识图异常：' + String(e?.message || e).slice(0, 80)) }
    }
    const sys = DUTY + '\n\n===== 你的人设（角色卡）=====\n' + (persona.text || '').slice(0, MAX_PERSONA) + '\n=====\n'
      + '你的任务是「挑视频」：判断这条视频值不值得花时间看。严格只输出一行 JSON，不要代码块、不要解释：\n'
      + '{"grade":"值得看|可以看|不值当","reason":"一句话理由，30字内","comment":"如果要留言，写1句话，40字内；不想留言就空字符串"}'
    const user = [
      '标题：' + v.title,
      v.author ? ('UP主：' + v.author) : '',
      v.duration ? ('时长：' + v.duration) : '',
      v.play ? ('播放：' + v.play) : '',
      v.review ? ('评论数：' + v.review) : '',
      v.description ? ('简介：' + v.description.slice(0, 300)) : '',
      subtitle ? ('字幕要点：' + subtitle.slice(0, 600)) : (look ? ('（没字幕）封面画面：' + look) : '（没有字幕，也没拿到画面）'),
      // thread 模式：把这条视频下的历史对话带上，避免自相矛盾；isolated 模式什么都不带
      useThread ? (() => { const c = threadContextText(home, v.bvid); return c ? ('\n===== 你在这个视频下的历史发言（接着上面的说，别自相矛盾）=====\n' + c) : '' })() : '',
    ].filter(Boolean).join('\n')
    const r = await chat(chain, { system: sys, user, maxTokens: 700, temperature: 0.7, thinkingOff: cfg.thinkingOff !== false })
    if (r.degraded) summary.degraded = true
    if (!r.ok) return { ok: false, err: r.lastError }
    const judged = parseJudge(r.text, v.title)
    judged.comment = withMention(judged.comment, cfg.mentionName)
    return { ok: true, ...judged, modelUsed: r.modelUsed }
  }

  try {
    // 1) 按关键词搜，攒候选（**每个词单独一个桶**，最后交替合并）
    //    为什么分桶：以前直接 candidates.push，最后 slice(0, limit) 会把第一个词的前 N 条全吃掉，
    //    后面几个词等于白搜（用户实测：填了 3 个词，10 条全来自第一个词。2026-10-31 修）
    const buckets = []
    let rawTotal = 0
    let skippedSeen = 0
    for (const kw of cfg.keywords) {
      if (stoppedByRisk || halted()) break
      log('搜「' + kw + '」…')
      const bucket = []
      let skipped = 0
      /** 把一批搜索结果塞进桶里：刷过的直接跳过。
       *  ⚠️ 判重必须在「送给 AI 判之前」做 —— 刷过的视频根本不会出现在 AI 面前，
       *  所以不存在"提示看过了→它又挑同一个→卡死"的循环。 */
      const collect = (list) => {
        for (const v of list) {
          if (seenSet.has(v.bvid) || seen.has(v.bvid) || inReport.has(v.bvid)) { skipped++; continue }
          seenSet.add(v.bvid)
          v.kw = kw
          bucket.push(v)
        }
      }
      let res
      try { res = await searchVideos(client, kw, 20) } catch (e) { summary.errors.push('搜索「' + kw + '」失败：' + (e?.message || e)); buckets.push(bucket); continue }
      const vids = extractVideos(res)
      rawTotal += vids.length
      log('「' + kw + '」拿到 ' + vids.length + ' 条结果')
      collect(vids)
      // 这个关键词前 20 条全刷过 → 再按「最新发布」多要一批（最多 50 条），
      // 免得看起来"没视频了"。只补一次，绝不递归重试（防死循环）。
      if (!bucket.length && vids.length) {
        try {
          log('「' + kw + '」这 ' + vids.length + ' 条都刷过了，按最新发布再找一批…')
          const res2 = await searchVideos(client, kw, 50, 'pubdate')
          const vids2 = extractVideos(res2)
          rawTotal += vids2.length
          collect(vids2)
        } catch { /* 补搜失败不影响主流程 */ }
      }
      if (skipped) log('「' + kw + '」跳过 ' + skipped + ' 条以前刷过的' + (bucket.length ? ('，剩 ' + bucket.length + ' 条新的') : '，没有新的'))
      skippedSeen += skipped
      buckets.push(bucket)
    }
    summary.skippedSeen = skippedSeen
    // 交替合并：第 1 轮各词各出 1 条，第 2 轮再各出 1 条……保证每个关键词都有机会被判断
    const candidates = interleaveBuckets(buckets)
    summary.scanned = candidates.length

    // 2) 逐条让 AI 判（受 limit 限制）
    for (const v of candidates.slice(0, limit)) {
      if (stoppedByRisk || halted()) break
      log('判 ' + v.bvid + '「' + v.title.slice(0, 24) + '」…')
      const j = await judge(v)
      if (!j.ok) { summary.errors.push('判 ' + v.bvid + ' 失败：' + j.err); continue }

      summary.picked++
      // 判过就算"刷过"——**试跑也算**，落了盘以后永远不会再送到 AI 面前。
      // 以前试跑不写判重表，导致点几次试跑每次都把同一批 20 条重新判一遍（用户实测的"老刷同一些视频"就是它，2026-10-31 修）
      appendSeen(home, v.bvid, 0, dryRun ? '试跑' : '')
      // 试跑不占"今日进度"（那是真发配额的口径），只在真跑时累加
      if (!dryRun) st.picked = (st.picked || 0) + 1

      // 先算"要发什么"，等真发完再写日报 —— 日报必须如实反映"到底发出去没有"
      const repLevel = cfg.reportLevel || 'full'
      const head = '### ' + v.bvid + ' · ' + j.grade
      const lines = [head, j.reason]
      if (repLevel === 'full') {
        const meta = [v.author && ('UP：' + v.author), v.duration && ('时长 ' + v.duration), v.play && ('播放 ' + v.play), v.review && ('评论 ' + v.review)].filter(Boolean)
        if (meta.length) lines.push('- ' + meta.join(' · '))
        lines.push('- 标题：' + v.title + '（关键词：' + v.kw + '）')
        if (j.comment) lines.push('- 拟评论：' + j.comment)
      }

      log(v.bvid + ' → ' + j.grade + '：' + j.reason)

      // 发之前最后确认一次：点了停止就一条都不发
      if (halted()) { lines.push('- 状态：已中断，未发布'); upsertReportBlock(home, day, v.bvid, lines.join('\n')); break }

      let status = ''
      // 3) 真发（只有明确开了自动评论、且不是试跑才发）
      if (dryRun) {
        status = '试跑，未发布'
      } else if (!cfg.autoComment) {
        status = '未发布：自动评论关着'
        appendSeen(home, v.bvid, 0)
      } else if (!j.comment) {
        status = '未发布：模型没给出评论'
        appendSeen(home, v.bvid, 0)
      } else {
        let r = null
        try { r = await postComment(client, v.bvid, j.comment) }
        catch (e) {
          status = '未发布：请求失败（' + (e?.message || e) + '）'
          summary.errors.push('发评论失败(' + v.bvid + ')：' + (e?.message || e))
        }
        if (r) {
          const rt = typeof r === 'string' ? r : JSON.stringify(r)
          // 先看接口到底收没收：success:false / 没有 rpid 都算没发出去
          const accepted = Boolean(r && (r.success === true || r.rpid || r.rpid_str))
          if (!accepted) {
            const why = (r.error || r.message) || rt.slice(0, 120)
            status = '未发布：被 B站 拒了（' + why + '）'
            summary.errors.push('发评论被拒(' + v.bvid + ')：' + why)
            log('没发出去 ' + v.bvid + '：' + why)
          } else {
            const c = classify(rt)
            if (c) {
              const d = decide(c, { cooldownMinutes: cfg.cooldownMinutes })
              guardian.engage(d.minutes, v.bvid + ' 命中风控 ' + c)
              stoppedByRisk = true
              status = '已发但命中风控 ' + c + '（已停手）'
              summary.errors.push(v.bvid + ' 命中风控码 ' + c + '：' + d.reason)
            } else {
              const ourRpid = r.rpid || r.rpid_str || 0
              // 记账：撤回要靠它（没 rpid 就撤不回来，记一条警告）
              if (ourRpid) recordPost(home, { bvid: v.bvid, rpid: ourRpid, text: j.comment, kind: 'comment', title: v.title })
              else summary.errors.push(v.bvid + ' 发出去但回执没带 rpid，以后撤不回这条')
              status = '已发布' + (ourRpid ? ('（rpid ' + ourRpid + '）') : '')
              appendSeen(home, v.bvid, 0)
              st.count = (st.count || 0) + 1
              summary.posted++
              if (useThread) appendTurn(home, v.bvid, { role: 'us', text: j.comment, rpid: Number(ourRpid) || 0, ourRpid: Number(ourRpid) || 0, title: v.title })
              log('已发 ' + v.bvid + '：' + j.comment)
              if (Number(cfg.favFolderId) > 0 && j.grade === '值得看') {
                try {
                  const fr = await addFavorite(client, v.bvid, cfg.favFolderId)
                  if (fr && fr.success) log('  已收藏到 ' + cfg.favFolderId)
                  else summary.errors.push('收藏失败(' + v.bvid + ')：' + ((fr && fr.error) || '未知'))
                } catch (e) { summary.errors.push('收藏异常(' + v.bvid + ')：' + (e?.message || e)) }
              }
              if (useThread && !ourRpid) summary.errors.push(v.bvid + ' 发出去了但没拿到 rpid，后续回复可能接不上')
            }
          }
        }
      }
      lines.push('- 状态：' + status)
      if (repLevel !== 'none' && repLevel !== 'off') upsertReportBlock(home, day, v.bvid, lines.join('\n'))
      if (stoppedByRisk) break
    }

    /* ── 4) 回评论：别人回复了我们的评论，接一句 ── */
    if (!dryRun && cfg.replyToComments && !stoppedByRisk) {
      let maxReply = Math.max(1, Number(cfg.replyPerRound) || 1)
      let data = null
      try { data = await receivedReplies(client) } catch (e) { summary.errors.push('取"回复我的"失败：' + (e?.message || e)) }
      const items = (data && Array.isArray(data.items)) ? data.items : []
      const handled = loadReplied(home)
      log('收到回复通知 ' + items.length + ' 条，待处理里最多回 ' + maxReply + ' 条')
      for (const it of items) {
        if (maxReply <= 0 || stoppedByRisk || halted()) break
        const id = String(it && it.id || '')
        if (!id || handled.has(id)) continue
        const item = (it && it.item) || {}
        const m = String(item.uri || item.native_uri || '').match(/BV[0-9A-Za-z]+/)
        const bvid = m ? m[0] : ''
        const theirText = String(item.source_content || '').trim()   // 对方写的那句
        const theirName = (it.user && it.user.nickname) || ''
        if (!bvid || !theirText) continue
        // 回复的锚点：优先 reply 目标，其次楼层根
        const target = Number(item.target_id || item.root_id || 0)
        const root = Number(item.root_id || 0)

        const sysR = DUTY + '\n\n===== 你的人设（角色卡）=====\n' + (persona.text || '').slice(0, MAX_PERSONA) + '\n=====\n'
          + '现在有人在你留过言的视频下回复你。写一句自然的回应（1 句，≤40 字）：不引战、不透露隐私、不复读对方的话、不解释自己是 AI。只输出这句话本身。'
        const userR = [
          '视频标题：' + (item.title || '(不知道)'),
          theirName ? ('对方昵称：' + theirName) : '',
          '对方说：' + theirText.slice(0, 200),
          useThread ? (() => { const c = threadContextText(home, bvid); return c ? ('\n===== 你在这个视频下说过的话 =====\n' + c) : '' })() : '',
        ].filter(Boolean).join('\n')
        const g = await chat(chain, { system: sysR, user: userR, maxTokens: 300, temperature: 0.8, thinkingOff: cfg.thinkingOff !== false })
        if (g.degraded) summary.degraded = true
        if (!g.ok) { summary.errors.push('回评论生成失败(' + bvid + ')：' + g.lastError); continue }
        const text = String(g.text || '').trim().replace(/^["'「]|["'」]$/g, '').slice(0, 120)
        if (!text) { summary.errors.push('回评论生成为空(' + bvid + ')'); continue }
        let rr
        try { rr = await postComment(client, bvid, text, target, root) } catch (e) { summary.errors.push('回评论失败(' + bvid + ')：' + (e?.message || e)); continue }
        const rrt = typeof rr === 'string' ? rr : JSON.stringify(rr)
        const okReply = Boolean(rr && (rr.success === true || rr.rpid || rr.rpid_str))
        if (!okReply) {
          const why = (rr && (rr.error || rr.message)) || rrt.slice(0, 120)
          summary.errors.push('回评论被拒(' + bvid + ')：' + why)
          log('回评论没发出去 ' + bvid + '：' + why)
          continue
        }
        const cc = classify(rrt)
        if (cc) {
          const d = decide(cc, { cooldownMinutes: cfg.cooldownMinutes })
          guardian.engage(d.minutes, bvid + ' 回评论命中风控 ' + cc)
          stoppedByRisk = true
          summary.errors.push(bvid + ' 回评论命中风控码 ' + cc + '：' + d.reason)
          break
        }
        if (rr.rpid || rr.rpid_str) recordPost(home, { bvid, rpid: rr.rpid || rr.rpid_str, text, kind: 'reply', title: item.title || '' })
        else summary.errors.push(bvid + ' 回复发出但回执没带 rpid，以后撤不回这条')
        markReplied(home, id)
        maxReply--
        summary.replied = (summary.replied || 0) + 1
        if (useThread) {
          appendTurn(home, bvid, { role: 'them', text: theirText, uid: it.user && it.user.mid })
          appendTurn(home, bvid, { role: 'us', text })
        }
        log('已回 ' + bvid + ' 给 ' + (theirName || '对方') + '：' + text)
      }
    }
  } catch (e) {
    summary.errors.push('轮次异常：' + (e?.message || e))
  } finally {
    try { client.close() } catch { /* noop */ }
  }

  st.lastRunAt = new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })
  const tail = summary.stopped
    ? ('已手动中断（这一轮挑中 ' + summary.picked + ' 条、发出 ' + summary.posted + ' 条）')
    : stoppedByRisk
    ? '风控冷却，已停手'
    : (dryRun
      ? ('试跑：挑了 ' + summary.picked + ' 条，未发布')
      : ((summary.posted || summary.replied)
        ? ('发出 ' + summary.posted + ' 条评论、回了 ' + (summary.replied || 0) + ' 条回复')
        : (rawTotal === 0
          ? '搜索没拿到结果：关键词可能太窄，或 B站 那边限流了'
          : (summary.scanned === 0
            ? ('搜到 ' + rawTotal + ' 条，但全都以前刷过（判重挡住 ' + skippedSeen + ' 条）——没有新视频可刷。换几个关键词，或等新内容出现')
            : '挑了但都没成，看专业日志里的报错'))))
  st.lastWhy = tail
  saveState(home, st)
  summary.ran = true
  summary.why = tail

  return summary
}/**
 * 把「每个关键词一组候选」交替合并。
 * 目标：limit=10、3 个词时，判断机会应该大致均分，而不是被第一个词吃满。
 * 纯函数，便于单测。
 */
export function interleaveBuckets(buckets) {
  const out = []
  const arrs = (buckets || []).filter(Array.isArray)
  const max = arrs.reduce((m, b) => Math.max(m, b.length), 0)
  for (let i = 0; i < max; i++) for (const b of arrs) if (b[i]) out.push(b[i])
  return out
}


