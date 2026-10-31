/**
 * lib/chain.mjs —— 模型降级链（解析 + 监视 + 尽力切 DSH 默认模型）
 * ============================================================================
 * 链上每一节 = 一个可调用端点 { id, label, baseUrl, apiKey, model }。
 * 来源两类：
 *   ① 自定义模型（cfg.models，用户在网页/DSH 填的，可加进链、可拖动调序）
 *   ② DSH 预设（hostModels，由 host 侧从 DSH 提取、**只取带密钥的**，没密钥不提取）
 *
 * 降级触发：LLM 调用报错且命中配额/无适配器信号（429、NO_ADAPTER、额度、rate limit）
 *   → 自动跳到链上下一节；并把 DSH 默认模型尽力切过去（写 headless/desktop 补丁）。
 *   切不动就只记日志，**绝不抛异常拖死值守**。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** 默认链里，单个 provider 最多放几个模型（超过就只放第一个，其余靠手动点） */
export const DEFAULT_CHAIN_MAX_PER_PROVIDER = 6

/** 命中即判定为"该降级"的错误特征（大小写不敏感） */
export const QUOTA_HINTS = [
  /no[_\s-]?adapter/i, /429/, /rate[\s_-]?limit/i, /quota/i, /额度/i,
  /exceed/i, /too many requests/i, /frequency/i, /频繁/i, /限流/i, /余额/i, /insufficient/i,
]

export function isQuotaError(text = '') {
  return QUOTA_HINTS.some((re) => re.test(String(text)))
}

/** 把一个自定义模型 cfg.models[i] 解析成端点（密钥按 apiKeySource 决定） */
function customEndpoint(m, hostModels) {
  let apiKey = ''
  if (m.apiKeySource === 'preset') {
    const h = (hostModels || []).find((x) => x.provider === m.provider)
    apiKey = h?.apiKey || ''
  } else if (m.apiKeySource === 'custom') {
    apiKey = m.customKey || ''
  }
  const baseUrl = (m.apiUrl || '').replace(/\/+$/, '')
  const model = m.modelName || ''
  if (!baseUrl || !model) return null
  return {
    id: m.id || `custom:${m.provider || 'x'}`,
    label: m.displayName || m.modelName || m.provider || '自定义模型',
    baseUrl, apiKey, model, source: 'custom',
  }
}

/** 把 DSH 预设（带密钥的）解析成端点；一个 provider 下的每个模型都是一节 */
function hostEndpoint(h) {
  const baseUrl = (h.apiUrl || '').replace(/\/+$/, '')
  if (!baseUrl || !h.modelName) return null
  return {
    id: `preset:${h.provider}:${h.modelName}`,
    label: h.label || h.modelName || h.provider,
    baseUrl, apiKey: h.apiKey || '', model: h.modelName, source: 'preset',
    provider: h.provider,
  }
}

/**
 * 解析有序端点链。
 * @param {object} cfg 插件配置（含 models / chainOrder）
 * @param {Array}  hostModels DSH 提取的预设（带密钥才进链）
 * @returns {Array<{id,label,baseUrl,apiKey,model,source}>}
 */
export function buildEndpoints(cfg = {}, hostModels = []) {
  const custom = (cfg.models || [])
    .filter((m) => m && m.addToChain)
    .map((m) => customEndpoint(m, hostModels))
    .filter(Boolean)
  const preset = (hostModels || [])
    .filter((h) => h && h.hasKey)
    .map(hostEndpoint)
    .filter(Boolean)

  const byId = new Map()
  for (const e of [...preset, ...custom]) byId.set(e.id, e)

  const order = (cfg.chainOrder || []).map(String)
  const ordered = []
  for (const id of order) if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id) }

  if (ordered.length) {
    // 排过序就以排序为准：只额外追加「自定义但没排进去」的
    // （以前是把所有没排进去的都追加 → 一旦手动调过顺序，链会瞬间涨到几百节，
    //   比如 qwen 一个 key 挂 262 个模型就全塞进来了。2026-10-29 修）
    for (const e of byId.values()) if (e.source === 'custom') ordered.push(e)
    return withStrength(ordered, cfg)
  }

  // 从没手动选过：按 provider 分组，**模型少的整组都进链**（你配了几个就进几个），
  // 只有模型特别多的（比如 qwen 一个 key 挂 262 个）才只取第一个，避免链被撑爆。
  // 真要用别的，去「模型与密钥」点一下 chip 即可。
  const picked = []
  for (const e of custom) picked.push(e)
  const groups = new Map()
  for (const e of preset) {
    const key = e.provider || e.id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }
  for (const list of groups.values()) {
    if (list.length <= DEFAULT_CHAIN_MAX_PER_PROVIDER) picked.push(...list)
    else picked.push(list[0])
  }
  return withStrength(picked, cfg)
}

/** 给每个端点挂上「它自己的思考强度」（没单独设就留空，由全局档位决定） */
function withStrength(list, cfg = {}) {
  const map = (cfg && typeof cfg.chainStrength === 'object' && cfg.chainStrength) || {}
  return (list || []).map((e) => ({ ...e, strength: map[e.id] || '' }))
}

/** 选下一个可用端点（降级）；返回 { endpoint, index } 或 null */
export function nextHealthy(chain, failedIndex) {
  if (!Array.isArray(chain) || chain.length === 0) return null
  const start = (failedIndex == null ? -1 : failedIndex) + 1
  for (let i = start; i < chain.length; i++) return { endpoint: chain[i], index: i }
  return null
}

/**
 * 尽力把 DSH 默认模型切到指定模型（headless + desktop 补丁）。
 * 纯尽力：任何异常都吞掉，只返回 { ok, tried:[], errors:[] } 供日志。
 */
export function applyDefaultModelToDsh(modelId, modelName) {
  const tried = []
  const errors = []
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const target = modelName || modelId || ''
  if (!target) return { ok: false, tried, errors: ['没有可用模型名'] }
  for (const profile of ['headless', 'desktop']) {
    const file = join(dshHome, 'profiles', profile, 'config.json')
    tried.push(file)
    try {
      if (!existsSync(file)) { errors.push(`${profile}: 文件不存在`); continue }
      const cfg = JSON.parse(readFileSync(file, 'utf8'))
      // DSH 不同版本字段名不一样，常见是 model / chat.model / defaultModel
      const cand = ['model', 'chat.model', 'defaultModel', 'llm.model']
      let hit = false
      for (const k of cand) {
        const parts = k.split('.')
        let o = cfg
        let ok = true
        for (let i = 0; i < parts.length - 1; i++) { if (o && typeof o === 'object') o = o[parts[i]]; else { ok = false; break } }
        if (ok && o && parts[parts.length - 1] in o) { o[parts[parts.length - 1]] = target; hit = true; break }
      }
      if (!hit) cfg.model = target  // 兜底：直接挂一个 model 字段
      const tmp = file + '.tmp'
      writeFileSync(tmp, JSON.stringify(cfg, null, 2))
      renameSync(tmp, file)
    } catch (e) { errors.push(`${profile}: ${e?.message || e}`) }
  }
  return { ok: errors.length === 0, tried, errors }
}
