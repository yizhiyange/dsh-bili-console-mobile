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

/**
 * 往 DSH 会话里发一条消息。
 * @param {object} ctx 插件上下文（apply 时拿到的那个）
 * @param {{home:string, text:string, sessionId?:string, cwd?:string}} o
 * @returns {Promise<{ok:boolean, error?:string, stage?:string, detail?:any}>}
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

  let handle
  try {
    handle = await agents.create({
      sessionId,
      meta: { cwd: String(o.cwd || o.home || '.') },
      agentOptions: {},
      setup: async () => {},
    })
  } catch (e) {
    return { ok: false, stage: 'create', error: String((e && e.message) || e).slice(0, 240) }
  }

  const agent = handle && (handle.agent || handle)
  if (!agent || typeof agent.prompt !== 'function') {
    return {
      ok: false, stage: 'handle',
      error: 'create 成功了，但返回对象里没有 prompt 方法',
      detail: { keys: Object.keys(handle || {}), agentKeys: agent ? listMethods(agent) : [] },
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
    return { ok: true, sessionId }
  } catch (e) {
    return { ok: false, stage: 'prompt', error: String((e && e.message) || e).slice(0, 240) }
  } finally {
    // 会话建完别急着 dispose：DSH 要留着它显示在列表里
    void 0
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
