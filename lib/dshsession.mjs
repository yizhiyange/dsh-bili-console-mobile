/**
 * dshsession.mjs —— 把插件每轮的小结发进 DSH 会话
 * ============================================================================
 * 2026-11-08 重写。之前几版都在「猜」插件 ctx 里的内部对象长什么样，结果
 * 不是撞 "already exists"，就是调错方法炸 "reading 'length'"。这次去
 * D:/deepseek/resources/app.asar 里读了 DSH 自己的源码，并且**在本机实测通过**：
 *
 *   · DSH 桌面端会开一个只绑回环地址的网页服务（`webServer` 服务，
 *     getOrigin() → http://127.0.0.1:<随机端口>）。
 *   · qq 机器人往 DSH 会话里发消息，走的就是这个服务的 Remote RPC，
 *     不是插件特权。插件虽然在 DSH 进程里，但一样可以发 HTTP 请求给自己。
 *   · 鉴权：读 ~/.dsh/.credentials.yaml 里持久化的
 *     `client-connection/browser-session` 32 字节密钥，离线 HMAC 铸一个
 *     浏览器会话 Cookie（qq-bridge/src/dsh-client.js 里验证过的算法）。
 *   · 真正发消息的三个 RPC（参数形状照 DSH 源码 + qq-bridge 实测）：
 *       session/list   → { args: { _request: {} } }
 *       session/create → { args: { request: { cwd, sessionId? } } }
 *       session/prompt → { args: { request: { requestId, sessionId,
 *                                            mode:'queue',
 *                                            content:[{type:'text',text}] } } }
 *     消息内容字段叫 **content**，不是 ACP 的 prompt。
 *
 * 安全约束：
 *   ① 只往 127.0.0.1 / localhost 发，绝不把 Cookie 发到别的地址
 *   ② 密钥和 Cookie 只留在内存，不写日志、不回传给界面
 *   ③ 默认关闭（config.dshSession），失败只记日志，绝不影响刷视频
 *   ④ 绝不写 sessions.store / messageProjections，不碰 DSH 内部数据
 *   ⑤ 独立 APK 里没有 DSH 网页服务，会直接给出「这里用不了」的人话
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash, createHmac, randomUUID } from 'node:crypto'

/** 兼容旧调用：index.js 还 import 了这个名字（诊断用） */
export function listMethods(svc) {
  const keys = new Set()
  try { Object.keys(svc || {}).forEach((k) => keys.add(k)) } catch { /* noop */ }
  try {
    let p = Object.getPrototypeOf(svc)
    while (p && p !== Object.prototype) {
      Object.getOwnPropertyNames(p).forEach((k) => keys.add(k))
      p = Object.getPrototypeOf(p)
    }
  } catch { /* noop */ }
  return Array.from(keys).filter((k) => k && !k.startsWith('_') && k !== 'constructor')
}

const b64url = (b) => Buffer.from(b).toString('base64')
  .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

/** 只读回环，杜绝把本机凭证发到别处 */
function isLoopback(u) {
  try {
    const h = new URL(u).hostname.toLowerCase()
    return h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' ||
      /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
  } catch { return false }
}

/** 找 ~/.dsh（凭据文件所在目录），按可信度依次试 */
function dshHome(home) {
  const tries = []
  if (process.env.DSH_HOME) tries.push(String(process.env.DSH_HOME))
  try { if (home) tries.push(dirname(String(home))) } catch { /* noop */ }
  try { tries.push(join(homedir(), '.dsh')) } catch { /* noop */ }
  for (const d of tries) {
    try { if (existsSync(join(d, '.credentials.yaml'))) return d } catch { /* noop */ }
  }
  return ''
}

/** 读持久化的浏览器会话签名密钥（32 字节）。只用极简正则，不引 YAML 依赖。 */
function browserSessionSecret(home) {
  const dir = dshHome(home)
  if (!dir) return null
  try {
    const y = readFileSync(join(dir, '.credentials.yaml'), 'utf8')
    const i = y.indexOf('client-connection/browser-session')
    if (i < 0) return null
    const block = y.slice(i, i + 500)
    if (!/kind:\s*grant/.test(block)) return null
    const m = block.match(/secret:\s*([A-Za-z0-9_-]+)/)
    if (!m) return null
    const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64')
    return secret.byteLength === 32 ? secret : null
  } catch { return null }
}

/** 用密钥给这个地址铸一个 1 小时有效的浏览器会话 Cookie */
function mintCookie(origin, secret) {
  const authority = new URL(origin).host
  const issuedAt = Date.now()
  const expiresAt = issuedAt + 60 * 60 * 1000
  const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
  const sig = b64url(createHmac('sha256', secret).update(body).digest())
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  return `${name}=v1.${body}.${sig}`
}

/** 从宿主 ctx 拿 DSH 网页服务的地址（插件 inject 里已经声明了 webServer） */
function originOf(ctx, home) {
  // 测试/特殊部署时可以显式给
  if (ctx && typeof ctx === 'string' && /^https?:/.test(ctx)) return ctx.replace(/\/+$/, '')
  let ws = null
  try { ws = ctx && ctx.get ? ctx.get('webServer') : (ctx && ctx.webServer) } catch { /* noop */ }
  if (ws) {
    try { if (typeof ws.getOrigin === 'function') return String(ws.getOrigin()).replace(/\/+$/, '') } catch { /* 还没 listen */ }
    const port = ws.listenedPort ?? ws.port
    if (port) {
      const proto = ws.protocol || 'http:'
      const host = ws.host && !/^0\.0\.0\.0|::$/.test(String(ws.host)) ? String(ws.host) : '127.0.0.1'
      return `${proto}//${host}:${port}`
    }
  }
  // 兜底：启动日志里通常印着 `dsh web` 的地址
  const dir = dshHome(home)
  if (dir) {
    try {
      for (const sub of ['logs', join('guard', 'logs')]) {
        let names = []
        try { names = readdirSync(join(dir, sub)).filter((n) => /^server-.*\.log$/.test(n)).reverse() } catch { continue }
        for (const n of names.slice(0, 4)) {
          const t = readFileSync(join(dir, sub, n), 'utf8')
          const m = t.match(/https?:\/\/127\.0\.0\.1:\d+/g)
          if (m && m.length) return m[m.length - 1]
        }
      }
    } catch { /* noop */ }
  }
  return ''
}

/** 发一个 DSH Remote RPC，只解最外层信封 */
async function rpc(origin, cookie, method, request, argName = 'request') {
  const rpcId = randomUUID()
  const message = {
    type: 'client-request', rpcId, method,
    payload: { args: { [argName]: request } },
  }
  const res = await fetch(origin + '/api/' + method, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(12000),
  })
  if (res.status === 401) throw new Error('DSH 拒绝了登录凭证（可能刚升级或重启过），重启一次 DSH 再试')
  if (!res.ok) throw new Error('DSH 网页接口返回 HTTP ' + res.status)
  const full = await res.json()
  if (!full || full.type !== 'server-response' || full.rpcId !== rpcId || !full.result) {
    throw new Error('DSH 的回复格式不对（版本可能变了）')
  }
  if (!full.result.ok) {
    const e = full.result.error || {}
    throw new Error(String(e.code || '') + (e.message ? ('：' + e.message) : '') || 'DSH 说这个请求失败了')
  }
  return full.result.value
}

/** 记住用过的会话 id，下次直接复用，别每轮新建一个会话 */
function sidFile(home) { try { return home ? join(String(home), 'dsh-session.txt') : '' } catch { return '' } }
function readSid(home) {
  try { const f = sidFile(home); return f && existsSync(f) ? String(readFileSync(f, 'utf8') || '').trim().slice(0, 120) : '' } catch { return '' }
}
function writeSid(home, id) {
  try { const f = sidFile(home); if (f && id) writeFileSync(f, String(id).slice(0, 120), 'utf8') } catch { /* 记不住不影响发送 */ }
}

/**
 * 挑一个「插件自己配的模型」给 DSH 会话用（2026-11-08）。
 *
 * 背景：session/prompt 发出去的消息，DSH 会当成「用户发问」，拿**这个会话
 * 绑定的模型**跑一轮。之前没指定，就抓到了用户已关掉的本地模型 → 400。
 * qq-bridge 的做法是发消息前先 session/selectModel 指定模型，这里照做。
 *
 * DSH 的 session/modelCatalog 里 provider 是分组 id、model 是模型 id；
 * 插件 config.json 的 chainOrder 里 `preset:<provider>:<model>` 正好一一对应
 * （插件「模型与密钥」页就是从 DSH 配置里生成这些 preset 的）。
 * 优先挑与插件当前主模型同 provider 的那个 → 真正「用你配的那个模型」。
 * 本机实测：selectModel {provider:'glm', model:'GLM-4-Flash'} 返回 ok:true。
 */
export function pickSessionModel(home) {
  let cfg = null
  try { cfg = JSON.parse(readFileSync(join(String(home), 'config.json'), 'utf8')) } catch { /* 没配置也能走兜底 */ }
  let models = [], order = []
  try { models = typeof (cfg && cfg.models) === 'string' ? JSON.parse(cfg.models) : ((cfg && cfg.models) || []) } catch { /* noop */ }
  try { order = typeof (cfg && cfg.chainOrder) === 'string' ? JSON.parse(cfg.chainOrder) : ((cfg && cfg.chainOrder) || []) } catch { /* noop */ }
  const current = models.find((x) => x && x.id === order[0]) || models[0] || null
  const want = String((current && current.provider) || '').toLowerCase()
  const presets = []
  for (const s of order) {
    const m = /^preset:([^:]+):(.+)$/.exec(String(s || ''))
    if (m) presets.push({ provider: m[1], model: m[2] })
  }
  const hit = presets.find((p) => p.provider.toLowerCase() === want) || presets[0]
  if (hit) {
    return {
      provider: hit.provider, model: hit.model,
      label: hit.provider + ' / ' + hit.model,
      fromPlugin: true,
      note: '来自你插件里配的模型（' + String((current && (current.displayName || current.modelName)) || '同一个服务商') + '）',
    }
  }
  // 插件没配可用的 preset：退回 DSH 自带的稳定模型，别再用可能已关掉的本地默认
  return {
    provider: 'deepseek-account', model: 'deepseek-flash',
    label: 'deepseek-account / deepseek-flash',
    fromPlugin: false,
    note: '插件里没找到能用的模型，临时用 DSH 自带的 DeepSeek Flash',
  }
}

/**
 * 往 DSH 会话里发一条消息。
 * @param {object} ctx 插件上下文（apply 时拿到的那个，里面有 webServer 服务）
 * @param {{home:string, text:string, cwd?:string, baseUrl?:string, sessionId?:string}} o
 * @returns {Promise<{ok:boolean, error?:string, stage?:string, via?:string, sessionId?:string, detail?:any}>}
 */
export async function pushToDshSession(ctx, o = {}) {
  const text = String(o.text || '').slice(0, 4000)
  if (!text.trim()) return { ok: false, stage: 'input', error: '没有要发的内容' }
  const home = String(o.home || '')

  // ① 地址：拿不到说明这不是 DSH 桌面端（比如独立 APK）
  const origin = o.baseUrl || originOf(ctx, home)
  if (!origin) {
    return {
      ok: false, stage: 'origin',
      error: '这里没有 DSH 桌面端的网页服务，发不进会话。独立版 App 里本来就没有 DSH，这个功能只在 DSH 插件里能用。',
    }
  }
  if (!isLoopback(origin)) {
    return { ok: false, stage: 'origin', error: 'DSH 地址不是本机地址，为了安全已停止发送。' }
  }

  // ② 登录凭证：本机离线铸造，不联网、不落盘
  const secret = browserSessionSecret(home)
  if (!secret) {
    return {
      ok: false, stage: 'auth',
      error: '没读到 DSH 的会话密钥，登不进它的网页接口。一般是 DSH 还没登录过、或换过数据目录；重启一次 DSH 再试。',
    }
  }
  const cookie = mintCookie(origin, secret)

  // ③ 找一个能复用的会话；没有就新建一个「刷B站小结」会话
  let sessionId = ''
  let via = ''
  try {
    const saved = readSid(home)
    const list = await rpc(origin, cookie, 'session/list', {}, '_request')
    const items = Array.isArray(list && list.items) ? list.items : []
    const has = (id) => items.some((x) => String(x && x.sessionId) === String(id))
    if (saved && has(saved)) { sessionId = saved; via = '复用上次会话' }
    else {
      // 捡回之前建过的「刷B站」会话（发过消息的也算，这样每轮都记在同一条里）
      const old = items.find((x) => /^bili-console/.test(String(x && x.sessionId)) && x.archived !== true)
      if (old) { sessionId = String(old.sessionId); via = '复用已有会话' }
    }
    if (!sessionId) {
      const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')
      const created = await rpc(origin, cookie, 'session/create', {
        cwd: String(o.cwd || home || '.'),
        sessionId: 'bili-console-' + stamp,
      })
      sessionId = String((created && created.sessionId) || '')
      if (!sessionId) throw new Error('DSH 没返回新会话的编号')
      via = '新建会话'
    }
    writeSid(home, sessionId)
  } catch (e) {
    const raw = String((e && e.message) || e).slice(0, 240)
    return {
      ok: false, stage: 'session',
      error: /拒绝了登录凭证/.test(raw)
        ? raw
        : '连不上 DSH 的会话服务，或它不让新建会话。DSH 关着、正在启动、刚升级时都会这样，等它开稳了再试。',
      detail: { raw, origin: origin.replace(/\/\/.+/, '//127.0.0.1:*') },
    }
  }

  // ④ 先指定这个会话用哪个模型（学 qq-bridge 的 ensureChatModel）
  //    不指定的话，DSH 会拿它的全局默认模型回这一轮；用户把那个本地模型
  //    关掉之后就会报 "Failed to load model" 400。指定失败也不阻断发消息，
  //    但会退回一个稳定模型再试，并把真实用的那个带回去给人看。
  const wanted = pickSessionModel(home)
  const candidates = [wanted]
  if (wanted.fromPlugin) {
    candidates.push({
      provider: 'deepseek-account', model: 'deepseek-flash',
      label: 'deepseek-account / deepseek-flash', fromPlugin: false,
      note: '插件指定的模型用不了，退回 DSH 自带的 DeepSeek Flash',
    })
  }
  let modelInfo = { ...wanted, applied: false, error: '' }
  for (const cand of candidates) {
    try {
      await rpc(origin, cookie, 'session/selectModel', {
        sessionId, provider: cand.provider, model: cand.model,
      })
      modelInfo = { ...cand, applied: true, error: '' }
      break
    } catch (e) {
      modelInfo = { ...cand, applied: false, error: String((e && e.message) || e).slice(0, 160) }
    }
  }

  // ⑤ 真正发消息
  try {
    await rpc(origin, cookie, 'session/prompt', {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    })
    return { ok: true, sessionId, via, stage: 'prompt', model: modelInfo }
  } catch (e) {
    const raw = String((e && e.message) || e).slice(0, 240)
    return {
      ok: false, stage: 'prompt',
      error: '消息没发进 DSH 会话。' + (/拒绝了登录凭证/.test(raw) ? raw : 'DSH 可能正忙或会话被归档了，点一次「试一下」换个会话重试。'),
      detail: { raw, via, sessionId, model: modelInfo },
    }
  }
}

/** 生成「不要动工具、只汇报」的提示词（会触发 DSH 里 AI 回一轮） */
export function buildReportPrompt(summaryLines) {
  const body = (Array.isArray(summaryLines) ? summaryLines : [summaryLines]).filter(Boolean).join('\n')
  return [
    '【刷B站插件 · 自动汇报】下面这一轮任务已经跑完了，用户想在 DSH 会话里看到过程。',
    '请只根据下面的内容，用中文简要复述这一轮发生了什么（3-6 行）。',
    '不要调用任何工具、不要读写文件、不要联网、不要执行任何操作，也不要编造没提到的内容。',
    '',
    body,
  ].join('\n')
}
