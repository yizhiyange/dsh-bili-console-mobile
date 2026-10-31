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

  const sessionId = String(o.sessionId || 'bili-console')
  const text = String(o.text || '').slice(0, 4000)
  if (!text.trim()) return { ok: false, stage: 'input', error: '没有要发的内容' }

  // ① 先找现成的（复用已有会话，不再重复 create）
  let agent = null
  let via = ''
  const existed = await findExistingAgent(agents, sessionId)
  if (existed) { agent = existed.agent; via = existed.via }

  // ② 没有才新建；create 报"已存在"就再找一次（可能刚好被上一轮建好）
  if (!agent) {
    try {
      const handle = await agents.create({
        sessionId,
        meta: { cwd: String(o.cwd || o.home || '.') },
        agentOptions: {},
        setup: async () => {},
      })
      agent = agentOf(handle)
      via = 'create'
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 240)
      if (/already exists|已存在/i.test(msg)) {
        const again = await findExistingAgent(agents, sessionId)
        if (again) { agent = again.agent; via = 'get-after-exists' }
        else return { ok: false, stage: 'create', error: msg + '（会话已存在，但没找到可复用的 agent）', detail: { methods: listMethods(agents) } }
      } else {
        return { ok: false, stage: 'create', error: msg }
      }
    }
  }

  if (!agent) {
    return {
      ok: false, stage: 'handle',
      error: '没拿到能用的 agent（create / 复用都没成功）',
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
