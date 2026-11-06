/**
 * dshsession.mjs —— 把插件的过程"投"进 DSH 会话（实验性）
 * ============================================================================
 * 原理（从 DSH 自身的 ACP 实现里反推出来）：
 *   ctx.agents.create({ sessionId, meta:{cwd}, agentOptions, setup })
 *     → { agent, dispose() }
 *   agent.prompt({ sessionId, prompt:[{type:'text', text}] }, client)
 *     → 会话里出现一条用户消息，agent 跑完把回复写进会话；DSH 的会话列表/聊天界面就有了。
 *
 * 安全约束（很重要）：
 *   ① 默认关闭，只有用户自己开才用
 *   ② 全部 try/catch，失败只回错误信息，绝不影响跑轮
 *   ③ 提示词里明确要求"只汇报，不要调用任何工具"——避免它在你的账号上乱动
 *   ④ 接口没有公开文档，字段名可能随版本变，所以任何异常都要原样抛给界面看
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 只读列出某个服务的方法名（诊断用） */
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

/** 拿 agents 服务（拿不到就 null） */
function agentsOf(ctx) {
  try { return ctx && ctx.get ? ctx.get('agents') : null } catch { return null }
}

/** 从各种可能的返回形态里抠出一个「能 prompt」的 agent */
function agentOf(x) {
  const a = x && (x.agent || x)
  return (a && typeof a.prompt === 'function') ? a : null
}

/**
 * 找一个「已经存在」的会话 agent。
 * 为什么需要：以前每次都直接 create，第二次必定报 `session "bili-console" already exists`
 * （用户 2026-10-31 实测就是这个错）。DSH 给插件开放的 agents 上有 get / resume / list，
 * 三条路都试一遍，拿到能复用的就不新建。
 */
async function findExistingAgent(agents, sessionId) {
  // ① agents.get(sessionId)
  try {
    if (typeof agents.get === 'function') {
      const a = agentOf(await agents.get(sessionId))
      if (a) return { agent: a, via: 'get' }
    }
  } catch { /* 试下一条 */ }
  // ② agents.resume(...)（不同版本签名可能是 id 或 {sessionId}）
  try {
    if (typeof agents.resume === 'function') {
      let r = null
      try { r = await agents.resume(sessionId) } catch { r = await agents.resume({ sessionId }) }
      const a = agentOf(r)
      if (a) return { agent: a, via: 'resume' }
    }
  } catch { /* 试下一条 */ }
  // ③ agents.list() 里按 sessionId 找
  try {
    if (typeof agents.list === 'function') {
      const all = await agents.list()
      const arr = Array.isArray(all) ? all : ((all && (all.items || all.list || all.sessions)) || [])
      for (const it of arr) {
        const id = it && (it.sessionId || it.id || it.name)
        if (String(id) !== String(sessionId)) continue
        const a = agentOf(it)
        if (a) return { agent: a, via: 'list' }
      }
    }
  } catch { /* 放弃 */ }
  return null
}

/**
 * 记住「上次真正建成功的 sessionId」。
 * 为什么：DSH 的 agents.get / resume / list 三条复用路都可能拿不到能 prompt 的 agent，
 * 于是每次 create 都撞 "already exists"，用户屏幕上就是一条永远发不出去的错误（2026-11-06）。
 * 现在的策略：优先用上次成功的 id；主名撞了就换一个带时间戳的新名字，成功就记下来。
 */
function sidFile(home) {
  try { return home ? join(String(home), 'dsh-session.txt') : '' } catch { return '' }
}
function readSid(home) {
  try {
    const f = sidFile(home)
    if (!f || !existsSync(f)) return ''
    return String(readFileSync(f, 'utf8') || '').trim().slice(0, 80)
  } catch { return '' }
}
function writeSid(home, id) {
  try {
    const f = sidFile(home)
    if (f && id) writeFileSync(f, String(id).slice(0, 80), 'utf8')
  } catch { /* 记不住不影响发送 */ }
}

/**
 * 往 DSH 会话里发一条消息。
 * @param {object} ctx 插件上下文（apply 时拿到的那个）
 * @param {{home:string, text:string, sessionId?:string, cwd?:string}} o
 * @returns {Promise<{ok:boolean, error?:string, stage?:string, via?:string, detail?:any}>}
 */
export async function pushToDshSession(ctx, o = {}) {
  const agents = agentsOf(ctx)
  if (!agents) return { ok: false, stage: 'lookup', error: '这套 DSH 没把 agents 服务给插件（ctx.get("agents") 为空）' }
  if (typeof agents.create !== 'function') {
    return { ok: false, stage: 'lookup', error: 'agents 存在但没有 create 方法，接口和预期不一致', detail: listMethods(agents) }
  }

  const baseId = String(o.sessionId || 'bili-console')
  const text = String(o.text || '').slice(0, 4000)
  if (!text.trim()) return { ok: false, stage: 'input', error: '没有要发的内容' }

  const home = o.home || ''
  const saved = readSid(home)              // 上次真正建成功的 id
  const tries = []
  if (saved) tries.push(saved)             // 优先复用上次那个
  if (!tries.includes(baseId)) tries.push(baseId)
  // 名字都撞了就现造一个：宁可多一个会话，也别让功能永远发不出去
  const stamp = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '')
  tries.push(baseId + '-' + stamp)

  let agent = null
  let via = ''
  let sessionId = baseId
  let lastErr = ''

  for (const sid of tries) {
    // ① 先试复用
    const existed = await findExistingAgent(agents, sid)
    if (existed) { agent = existed.agent; via = existed.via; sessionId = sid; break }
    // ② 再试新建
    try {
      const handle = await agents.create({
        sessionId: sid,
        meta: { cwd: String(o.cwd || o.home || '.') },
        agentOptions: {},
        setup: async () => {},
      })
      const a = agentOf(handle)
      if (a) { agent = a; via = 'create'; sessionId = sid; break }
      lastErr = 'create 没返回可用的 agent'
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200)
      lastErr = msg
      if (!/already exists|已存在/i.test(msg)) break   // 不是重名就别再换名字试了
      // 是重名 → 再找一次（可能刚被别人建好），还不行就试下一个名字
      const again = await findExistingAgent(agents, sid)
      if (again) { agent = again.agent; via = 'get-after-exists'; sessionId = sid; break }
    }
  }

  if (agent && sessionId !== saved) writeSid(home, sessionId)

  if (!agent) {
    return {
      ok: false, stage: 'handle',
      error: '没拿到能用的 agent（create / 复用都没成功）：' + (lastErr || '未知') + '；试过的名字：' + tries.join(' / '),
      detail: { methods: listMethods(agents) },
    }
  }

  try {
    await agent.prompt(
      { sessionId, prompt: [{ type: 'text', text }] },
      {
        // ACP 客户端接口：我们只要它别报错，不消费流式更新
        sessionUpdate: () => {},
        requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      },
    )
    return { ok: true, sessionId, via }
  } catch (e) {
    return { ok: false, stage: 'prompt', error: String((e && e.message) || e).slice(0, 240), detail: { via } }
  }
}

/** 生成"不要动工具、只汇报"的提示词 */
export function buildReportPrompt(summaryLines) {
  const body = (Array.isArray(summaryLines) ? summaryLines : [summaryLines]).filter(Boolean).join('\n')
  return [
    '【插件自动汇报】下面这一轮 B站 刷视频任务已经跑完了，用户想在这里看到过程。',
    '请**只根据下面的内容**用中文简要复述这一轮发生了什么（3-6 行），不要调用任何工具、不要执行任何操作、不要编造没提到的内容。',
    '',
    body,
  ].join('\n')
}
