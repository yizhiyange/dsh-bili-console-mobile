/**
 * lib/llm.mjs —— 调模型链生成文本（OpenAI 兼容 /chat/completions）
 * ============================================================================
 * 输入一条有序端点链（来自 lib/chain.mjs buildEndpoints），按顺序尝试：
 *   - 成功 → 返回文本 + 用到的模型
 *   - 命中配额/无适配器信号 → 降级到下一节（并记录 degraded）
 *   - 其他网络错 → 也试下一节，但最多试完全部
 * 全部失败 → 返回 { text:'', ok:false, lastError }
 * 任何异常都就地消化，绝不向上抛（值守循环不能因一次 LLM 抖动挂掉）。
 * ============================================================================
 */
import { isQuotaError } from './chain.mjs'

/**
 * 「关思考 / 降到最低」的几种参数口味，按性价比排序：
 *   1) off+low ：真正关掉思考，同时 effort=low（DeepSeek 这种支持关的最省）
 *   2) low     ：只能调低不能关（GLM 5.x 就是这种，实测 85→4 tokens）
 *   3) off     ：只传 thinking=disabled
 *   4) none    ：都不传（老接口/自建服务兜底）
 * 每路「baseUrl|model」第一次成功用哪个就记住，之后直接用，不会反复试探。
 */
const FLAVORS = [
  { name: 'off+low', extra: { reasoning_effort: 'low', thinking: { type: 'disabled' } } },
  { name: 'low', extra: { reasoning_effort: 'low' } },
  { name: 'off', extra: { thinking: { type: 'disabled' } } },
  { name: 'none', extra: {} },
]
const _flavorCache = new Map()   // `${baseUrl}|${model}` -> flavor 下标

/** 清掉「接口方言」试探结果缓存（手机省内存用；清了只是下次调用多试一两个请求体格式，不影响正确性） */
export function clearFlavorCache() {
  const n = _flavorCache.size
  _flavorCache.clear()
  return n
}

async function oneCall(ep, { system, user, maxTokens = 400, temperature = 0.8, thinkingOff = true }) {
  const url = ep.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const key = ep.baseUrl + '|' + ep.model

  /** 从返回里取正文（兼容 content 是字符串 / 数组两种情况） */
  const pick = (data) => {
    const m = data && data.choices && data.choices[0] && data.choices[0].message
    if (!m) return ''
    let c = m.content
    if (Array.isArray(c)) c = c.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('')
    return typeof c === 'string' ? c.trim() : ''
  }

  const call = async (tokens, extra) => {
    const body = {
      model: ep.model,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: user },
      ],
      max_tokens: tokens,
      temperature,
      ...extra,
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 60000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(ep.apiKey ? { Authorization: `Bearer ${ep.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      const txt = await res.text()
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`)
        err.quota = isQuotaError(txt) || res.status === 429
        err.status = res.status
        err.body = txt
        throw err
      }
      let data
      try { data = JSON.parse(txt) } catch { throw new Error('返回不是 JSON：' + txt.slice(0, 200)) }
      return { content: pick(data), finish: (data.choices && data.choices[0] && data.choices[0].finish_reason) || '', data }
    } finally { clearTimeout(timer) }
  }

  // 判断这次 400 是不是「参数不被接受」（可以换口味重试），而不是鉴权/余额问题
  const paramRejected = (e) => {
    if (!e || e.status !== 400) return false
    const t = String(e.body || e.message || '')
    return /思考|thinking|reasoning|invalid|unknown|unrecognized|不支持|参数|param/i.test(t)
  }

  // 选起始口味：记住过就用记住的；没记住且用户要省 token 就从最省的开始试
  const saved = _flavorCache.get(key)
  let idx = saved != null ? saved : (thinkingOff ? 0 : FLAVORS.length - 1)
  let lastErr = null
  let emptyRetry = 0

  while (idx < FLAVORS.length) {
    const flavor = FLAVORS[idx]
    try {
      let r = await call(maxTokens, flavor.extra)
      // 思维链模型可能把预算花光，正文空 → 放大预算再来一次
      if (!r.content && (r.finish === 'length' || r.finish === '') && emptyRetry < 1) {
        emptyRetry++
        r = await call(Math.max(maxTokens * 4, 1200), flavor.extra)
      }
      if (!r.content) {
        const m = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message
        const rc = m && typeof m.reasoning_content === 'string' ? m.reasoning_content.trim() : ''
        const last = rc ? (rc.split(/\n+/).filter(Boolean).slice(-1)[0] || '') : ''
        if (last && last.length <= 200) { _flavorCache.set(key, idx); return last }
        throw new Error('返回里没有 content（思维链吃完了预算）')
      }
      _flavorCache.set(key, idx)
      return r.content
    } catch (e) {
      lastErr = e
      if (paramRejected(e)) { idx++; continue }   // 这个口味不被接受 → 换下一个（并记住最终成功的）
      throw e
    }
  }
  throw lastErr || new Error('所有请求口味都失败')
}

/**
 * 按链顺序生成一次文本。
 * @returns {Promise<{ok:boolean,text:string,modelUsed?:string,index?:number,degraded:boolean,lastError?:string,tries:number}>}
 */
export async function chat(chain, prompt) {
  const out = { ok: false, text: '', degraded: false, tries: 0 }
  if (!Array.isArray(chain) || chain.length === 0) {
    out.lastError = '链上空：没有可调用模型（请在"模型与密钥"里加一个并加入降级链）'
    return out
  }
  for (let i = 0; i < chain.length; i++) {
    const ep = chain[i]
    out.tries++
    try {
      const text = await oneCall(ep, prompt)
      out.ok = true
      out.text = text
      out.modelUsed = ep.label || ep.model
      out.index = i
      return out
    } catch (e) {
      out.lastError = e?.message || String(e)
      if (e?.quota || isQuotaError(out.lastError)) out.degraded = true
      // 继续试下一节
    }
  }
  return out
}
