/**
 * lib/remote.mjs —— QQ 遥控「门卫」（2026-11-08）
 * ============================================================================
 * 它是什么：给 AstrBot（跑在 Switch / Ubuntu 上的 QQ 机器人）留一扇带锁的小门。
 *
 *   QQ 里发「/bili 状态」
 *     → AstrBot 插件 astrbot_plugin_bili_console
 *     → HTTP POST http://<装插件的机器>:8792/cmd  （带口令）
 *     → 本文件这扇门
 *     → 直接调 index.js 的 handle()（不二次发 HTTP、不用管 DSH 那个随机端口）
 *     → 挑几个安全字段翻成大白话，回给 QQ
 *
 * 三条铁律（别改）：
 *   ① 默认关。不开就完全不监听端口，跟没这功能一样，电脑版的性能/行为一个字节不变。
 *   ② 只认白名单动作。外面永远碰不到 /config、/settings(任意写)、/export、
 *      /login/start、/open、/video/* 这些能拿密钥、改设置、开文件的接口。
 *   ③ 不回传原始 JSON。/state 里带着模型 Key 明文，透传等于把密钥发进 QQ 群。
 *      所以每个动作只挑几个安全字段，翻成人话再回（data 默认是空对象）。
 *
 * 为什么直接喂 handle() 而不是自己再发一次 HTTP：
 *   - 电脑版挂在 DSH 的 webServer 上，端口每次启动都变，还得铸 Cookie；
 *   - 独立版是 127.0.0.1:8790，端口可改。
 *   两边统一走 handle()，一份代码通吃，也不会把钥匙写进日志。
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Readable } from 'node:stream'
import { networkInterfaces } from 'node:os'
import { loadConfig, saveConfig } from './state.mjs'
import { VERSION } from './version.mjs'

const API_PREFIX = '/api/bili-console'
const MAX_BODY = 16 * 1024

/** 给 QQ 看的帮助（AstrBot 插件里也有一份中文指令对照，这里是兜底） */
const HELP = [
  '刷B站遥控 · 能干这些：',
  '查：状态 / 日报 / 登录 / 评论 / 动态 / 看过 / 待审',
  '干活：跑一轮 / 试跑 / 停 / 查私信 / 撤回',
  '发东西：发动态 内容 / 通过 编号 / 跳过 编号 / 立刻发 编号',
  '自动投稿：自动开 / 自动关 / 自动审核 / 自动全自动',
].join('\n')

/** 把内部接口的结果喂给 handle()，用假的 req / 捕获型 res，不碰网络 */
function callHandle(handle, method, path, body) {
  return new Promise((resolve) => {
    let code = 200
    let done = false
    const finish = (data) => { if (done) return; done = true; resolve({ code, data }) }
    const res = {
      writeHead(c) { code = c; return this },
      setHeader() { return this },
      getHeader() { return undefined },
      write() { return true },
      end(b) {
        let data = {}
        try { data = JSON.parse(String(b ?? '{}')) } catch { data = { ok: false, error: '返回不是 JSON' } }
        finish(data)
      },
    }
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.url = API_PREFIX + path
    req.method = method
    req.headers = {}
    Promise.resolve(handle(req, res))
      .then(() => finish({ ok: true }))
      .catch((e) => finish({ ok: false, error: String(e?.message ?? e) }))
  })
}

/** 只留人话里要用到的安全字段，绝不把配置 / 密钥带出去 */
const num = (v) => Number(v || 0) || 0
const cut = (s, n = 60) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)

const ACTIONS = {
  help: {
    level: 'read',
    reply: () => HELP,
  },
  ping: {
    level: 'read',
    reply: () => '在，刷B站插件在线',
  },
  // 用 /status 不用 /state：/state 会顺带探一次转写环境（可能起 Python），
  // Switch 那台小机器经不起每条指令都来这么一下。/status 只读配置文件，毫秒级。
  status: {
    level: 'read',
    call: { method: 'GET', path: '/status' },
    reply: (d) => {
      if (d.ok === false) return '状态没读到：' + cut(d.error, 80)
      const lim = num((d.config || {}).perDay)
      return [
        `插件 v${d.version || '?'} · ${process.env.BILI_STANDALONE ? '独立版' : '电脑版'}`,
        `B站登录：${d.loggedIn ? '已登录' : '没登录（去面板扫码）'}`,
        `今天：挑了 ${num(d.pickedToday)}${lim ? '/' + lim : ''} 条，跑了 ${num(d.ranToday)} 轮`,
        `运行环境：${d.venvReady ? '就绪' : '还没装好'}`,
      ].join('\n')
    },
  },
  report: {
    level: 'read',
    call: { method: 'GET', path: '/report' },
    reply: (d) => {
      const t = String(d.markdown || d.text || '').trim()
      if (!t) return '今天还没有日报（跑过一轮才会有）'
      return '今日小结：\n' + t.slice(0, 700) + (t.length > 700 ? '\n…（后面去面板看）' : '')
    },
  },
  login: {
    level: 'read',
    call: { method: 'GET', path: '/login/status' },
    reply: (d) => d.loggedIn ? `B站已登录${d.uname ? '：' + cut(d.uname, 20) : ''}` : 'B站还没登录。去插件面板点「扫码登录」，QQ 这边不传二维码（怕被别人扫走）',
  },
  auto: {
    level: 'read',
    call: { method: 'GET', path: '/publish/auto' },
    reply: (d) => {
      if (d.ok === false) return '没读到：' + cut(d.error, 80)
      const q = Array.isArray(d.queue) ? d.queue : []
      const wait = q.filter((x) => x.status === 'pending' || x.status === 'approved')
      const head = [
        `自动发视频：${d.on ? '开着' : '关着'} · ${d.mode === 'review' ? 'AI 写好等我确认' : '全自动'}`,
        `今天已发 ${num(d.todayCount)}/${num(d.perDay)} 条 · 间隔 ${num(d.gapHours)} 小时`,
      ]
      if (!wait.length) return head.join('\n') + '\n待审队列是空的'
      return head.join('\n') + '\n待审：\n' + wait.slice(0, 5).map((x, i) => `${i + 1}. [${cut(x.id, 8)}] ${cut(x.title || x.video || '未命名', 28)}`).join('\n')
    },
    pick: (d) => ({
      on: !!d.on, mode: d.mode, todayCount: num(d.todayCount), perDay: num(d.perDay),
      queue: (Array.isArray(d.queue) ? d.queue : []).slice(0, 20).map((x) => ({
        id: String(x.id || ''), title: cut(x.title || x.video || '', 40), status: String(x.status || ''),
      })),
    }),
  },
  auto_on: {
    level: 'write',
    call: { method: 'POST', path: '/settings', body: () => ({ apOn: true }) },
    reply: () => '自动发视频已打开。第一次打开不会把以前的老视频补发出去，只管之后新做出来的',
  },
  auto_off: {
    level: 'write',
    call: { method: 'POST', path: '/settings', body: () => ({ apOn: false }) },
    reply: () => '自动发视频已关掉，之后再有新片也不会自己发',
  },
  auto_review: {
    level: 'write',
    call: { method: 'POST', path: '/settings', body: () => ({ apOn: true, apMode: 'review' }) },
    reply: () => '改成「AI 写好标题简介，你在 QQ 里说通过才发」',
  },
  auto_full: {
    level: 'write',
    call: { method: 'POST', path: '/settings', body: () => ({ apOn: true, apMode: 'auto' }) },
    reply: () => '改成「全自动」。注意：不用你确认就会发出去，间隔和每日上限仍然拦着',
  },
  auto_approve: {
    level: 'danger',
    call: { method: 'POST', path: '/publish/auto/approve', body: (a) => ({ id: String(a.id || ''), title: a.title ? cut(a.title, 80) : undefined }) },
    reply: (d, a) => d.ok === false ? '没通过：' + cut(d.error, 80) : `已通过 [${cut(a.id, 8)}]，等自动档或说「立刻发」`,
  },
  auto_skip: {
    level: 'write',
    call: { method: 'POST', path: '/publish/auto/approve', body: (a) => ({ id: String(a.id || ''), act: 'remove' }) },
    reply: (d, a) => d.ok === false ? '没跳过：' + cut(d.error, 80) : `已跳过 [${cut(a.id, 8)}]，这条不会发了`,
  },
  auto_now: {
    level: 'danger',
    call: { method: 'POST', path: '/publish/auto/now', body: (a) => ({ id: String(a.id || '') }) },
    reply: (d, a) => d.ok === false
      ? `没发出去：${cut(d.error, 100)}`
      : `投稿成功 [${cut(a.id, 8)}]${d.bvid ? ' · ' + d.bvid : ''}\n记得去创作中心手动勾「含 AI 生成内容」，接口暂时勾不了`,
  },
  run: {
    level: 'danger',
    call: { method: 'POST', path: '/run/now', body: () => ({ force: false, dryRun: false }) },
    reply: (d) => d.started === false ? '没开始：' + cut(d.message, 80) : '已开始跑一轮（会真的发评论），过会儿说「状态」或「日报」看结果',
  },
  dry: {
    level: 'write',
    call: { method: 'POST', path: '/run/now', body: () => ({ force: false, dryRun: true }) },
    reply: (d) => d.started === false ? '没开始：' + cut(d.message, 80) : '已开始试跑：只挑视频、不写也不发，看看它挑得准不准',
  },
  stop: {
    level: 'write',
    call: { method: 'POST', path: '/run/stop', body: () => ({}) },
    reply: (d) => d.stopped === false ? '当前没有在跑的轮次' : '已叫停，正在把手里这一条做完，不会发半句',
  },
  dynamic: {
    level: 'danger',
    call: { method: 'POST', path: '/publish/dynamic', body: (a) => ({ text: String(a.text || '').slice(0, 800) }) },
    reply: (d, a) => {
      if (d.ok === false) return '没发出去：' + cut(d.error || d.message, 100)
      return `动态已发：${cut(a.text, 40)}`
    },
  },
  dm: {
    level: 'write',
    call: { method: 'POST', path: '/dm/check', body: () => ({}) },
    reply: () => '已开始查私信（有未读才会按人设回，且不重复回）',
  },
  comments: {
    level: 'read',
    call: { method: 'GET', path: '/comments' },
    reply: (d) => {
      const it = Array.isArray(d.items) ? d.items : []
      if (!it.length) return '还没发过评论'
      return '最近发出的评论：\n' + it.slice(0, 5).map((x, i) => `${i + 1}. ${cut(x.text || x.content || x.msg || x.bvid, 46)}`).join('\n')
    },
  },
  posted: {
    level: 'read',
    call: { method: 'GET', path: '/posted' },
    reply: (d) => {
      const it = Array.isArray(d.items) ? d.items : []
      if (!it.length) return '还没发过动态'
      return '最近发过的动态：\n' + it.slice(0, 5).map((x, i) => `${i + 1}. ${cut(x.text || x.content || x.id, 46)}`).join('\n')
    },
  },
  watched: {
    level: 'read',
    call: { method: 'GET', path: '/watched' },
    reply: (d) => {
      const it = Array.isArray(d.rows) ? d.rows : []
      if (!it.length) return '还没看过视频'
      return `一共看过 ${num(d.total)} 条，最近：\n` + it.slice(0, 5).map((x, i) => `${i + 1}. ${cut(x.title || x.bvid, 40)}`).join('\n')
    },
  },
  retract: {
    level: 'danger',
    call: { method: 'POST', path: '/retract', body: (a) => ({ count: Math.max(1, Math.min(5, num(a.count) || 1)) }) },
    reply: (d) => d.ok === false ? '没撤成：' + cut(d.error, 80) : `正在撤回最近 ${num(d.count) || 1} 条（只撤插件自己发的）`,
  },
  // 为所欲为（wild）：QQ 里一声令下，让它自己逛 B站、自己评论/点赞/投币/发动态。
  // 注意：① 仍受「只看不干」门禁约束（runAction 里 level!=='read' 会被拦）；② 没人下令它自己不会动（只有这一种手动触发）。
  wild: {
    level: 'danger',
    call: { method: 'POST', path: '/run/wild', body: () => ({}) },
    reply: (d) => d.started === false ? '没开始：' + cut(d.message, 80) : '已在 QQ 下令「为所欲为」跑一轮（随它自己逛去 B站 干点啥），过会儿说「状态」看结果',
  },
}

export const REMOTE_ACTIONS = Object.keys(ACTIONS)

function safeEq(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8')
  const B = Buffer.from(String(b || ''), 'utf8')
  if (!B.length || A.length !== B.length) return false
  try { return timingSafeEqual(A, B) } catch { return false }
}

function json(res, code, obj) {
  const body = JSON.stringify(obj)
  try {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'Content-Type, X-Bili-Token',
    })
    res.end(body)
  } catch { /* 客户端断了就算了 */ }
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (v) => { if (done) return; done = true; resolve(v) }
    req.on('data', (c) => {
      if (done) return
      size += c.length
      if (size > MAX_BODY) { fail({}); try { req.destroy() } catch {} ; return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (done) return
      try { fail(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { fail({}) }
    })
    req.on('error', () => fail({}))
  })
}

/** 局域网里能拿来填进 AstrBot 的地址 */
export function lanUrls(port) {
  const out = []
  try {
    for (const list of Object.values(networkInterfaces() || {})) {
      for (const it of list || []) {
        if (it && it.family === 'IPv4' && !it.internal) out.push(`http://${it.address}:${port}`)
      }
    }
  } catch { /* 拿不到就算了 */ }
  return [...new Set(out)]
}

/** 给界面显示用：开关、地址、口令、当前有没有真在监听 */
export function remoteSnapshot(home, extra = {}) {
  const c = loadConfig(home)
  return {
    on: !!c.remoteOn,
    port: num(c.remotePort) || 8792,
    host: String(c.remoteHost || '0.0.0.0'),
    token: String(c.remoteToken || ''),
    readOnly: !!c.remoteReadOnly,
    urls: lanUrls(num(c.remotePort) || 8792),
    listening: !!extra.listening,
    error: String(extra.error || ''),
    actions: REMOTE_ACTIONS.length,
  }
}

/**
 * 启动门卫。返回一个控制器，插件卸载时调 stop()。
 * 配置改了不用重启插件：每 5 秒比一次，开关/端口/监听地址变了就自己重开。
 */
export function startRemote({ home, handle, log = () => {}, noListen = false }) {
  let server = null
  let signature = ''
  let listening = false
  let lastErr = ''
  const note = (m) => { try { log(m) } catch {} }

  function current() {
    const c = loadConfig(home)
    // 第一次开、又没填口令 → 自动铸一把，省得用户自己想密码
    if (c.remoteOn && !c.remoteToken) {
      const t = randomBytes(18).toString('base64url')
      try { saveConfig(home, { remoteToken: t }) } catch { /* 写不进去就本次先不启 */ }
      c.remoteToken = t
    }
    return c
  }

  function stop() {
    if (server) {
      try { server.close() } catch {}
      try { server.closeAllConnections?.() } catch {}
    }
    server = null
    listening = false
  }

  async function runAction(body) {
    const action = String(body.action || '').trim().toLowerCase()
    const args = (body.args && typeof body.args === 'object') ? body.args : {}
    const a = ACTIONS[action]
    if (!a) return { ok: false, action, reply: `不认识「${cut(action, 20)}」。说「帮助」看能干啥`, data: {} }
    const c = loadConfig(home)
    if (c.remoteReadOnly && a.level !== 'read') {
      return { ok: false, action, reply: '这扇门现在是「只看不干」模式，干活得去面板把只读关掉', data: {} }
    }
    let data = {}
    if (a.call) {
      const b = a.call.body ? a.call.body(args) : undefined
      // 清掉 undefined，免得 JSON.stringify 塞进 null 让后端判断跑偏
      if (b && typeof b === 'object') for (const k of Object.keys(b)) if (b[k] === undefined) delete b[k]
      const r = await callHandle(handle, a.call.method, a.call.path, b)
      data = r.data || {}
      if (r.code >= 400) return { ok: false, action, reply: `插件那边返回 ${r.code}，先去面板看看`, data: {} }
    }
    let reply = ''
    try { reply = a.reply ? String(a.reply(data, args)) : String(data.message || '好了') } catch { reply = '做完了，但结果没翻译出来，去面板看' }
    note(`QQ遥控：${action}（${a.level}）${data.ok === false ? ' 失败：' + cut(data.error, 60) : ''}`)
    return { ok: data.ok !== false, action, reply, data: a.pick ? a.pick(data) : {} }
  }

  function onRequest(req, res) {
    let pathname = '/'
    try { pathname = new URL(req.url, 'http://x').pathname } catch { /* 保持 / */ }
    if (req.method === 'OPTIONS') { json(res, 204, {}); return }
    const c = current()
    const got = String(req.headers['x-bili-token'] || (() => { try { return new URL(req.url, 'http://x').searchParams.get('token') } catch { return '' } })() || '')
    if (!safeEq(got, c.remoteToken)) { json(res, 401, { ok: false, reply: '口令不对。去插件面板「QQ 遥控」那张卡抄口令' }); return }
    if (req.method === 'GET' && pathname === '/ping') {
      json(res, 200, { ok: true, reply: '在，刷B站插件在线', version: VERSION || '0.0.0', standalone: !!process.env.BILI_STANDALONE, actions: REMOTE_ACTIONS })
      return
    }
    if (req.method === 'GET' && pathname === '/state') {
      json(res, 200, { ok: true, ...remoteSnapshot(home, { listening, error: lastErr }) })
      return
    }
    if (req.method !== 'POST' || pathname !== '/cmd') { json(res, 404, { ok: false, reply: '只有 /ping、/state、/cmd 三个口' }); return }
    readJson(req).then(async (body) => {
      let out
      try { out = await runAction(body) } catch (e) { out = { ok: false, reply: '插件这边出错了：' + cut(e?.message ?? e, 80), data: {} } }
      json(res, 200, out)
    })
  }

  function sync() {
    const c = current()
    const sig = [c.remoteOn, c.remotePort, c.remoteHost].join('|')
    if (sig === signature) return
    signature = sig
    stop()
    lastErr = ''
    if (!c.remoteOn) { note('QQ遥控：已关闭，不再监听端口'); return }
    // 独立版(standalone)模式：门卫由 DSH 进程独占监听，本进程只管配置读写，不起端口
    if (noListen) { note('QQ遥控：门卫由 DSH 进程独占监听，本进程只管理配置'); listening = false; return }
    const port = num(c.remotePort) || 8792
    const host = String(c.remoteHost || '0.0.0.0')
    try {
      server = createServer(onRequest)
      server.on('error', (e) => {
        lastErr = String(e?.message ?? e)
        listening = false
        note('QQ遥控：端口起不来 —— ' + lastErr)
        signature = '' // 下一轮再试一次
      })
      server.listen(port, host, () => {
        listening = true
        note(`QQ遥控：已开在 ${host}:${port}（口令已生成，去面板抄）`)
      })
    } catch (e) {
      lastErr = String(e?.message ?? e)
      note('QQ遥控：启动失败 —— ' + lastErr)
    }
  }

  sync()
  const timer = setInterval(sync, 5000)
  try { timer.unref?.() } catch {}

  return {
    stop() { try { clearInterval(timer) } catch {} ; stop() },
    sync,
    snapshot: () => remoteSnapshot(home, { listening: noListen ? !!loadConfig(home).remoteOn : listening, error: lastErr }),
    runAction,   // 本地测试用，不开端口也能测动作翻译
  }
}
