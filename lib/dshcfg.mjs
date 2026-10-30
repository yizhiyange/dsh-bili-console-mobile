/**
 * lib/dshcfg.mjs —— 读 DSH 真实配置，提取「带密钥的模型」
 * ============================================================================
 * DSH（DeepSeek Harness）现在把配置存在：
 *   ~/.dsh/profiles/<profile>/cordis.patch.yml   ← 模块化 YAML（providers / models）
 *   ~/.dsh/.credentials.yaml                     ← refs: <ENV_NAME>: <明文密钥>
 *
 * 关键结构（一个 provider = 一个 key = 多个模型）：
 *   - id: llm-pi-ai
 *     config:
 *       providers:
 *         astrbot-bigmodel-1:
 *           displayName: AstrBot BigModel 1
 *           apiKeyEnv: ASTRBOT_BIGMODEL_KEY_1
 *           baseURL: https://open.bigmodel.cn/api/paas/v4
 *           models:
 *             - id: glm-5.3-flashx
 *               name: GLM 5.3 FlashX AstrBot 1
 *             - id: glm-5.3-flash
 *             ...
 *
 * 所以「一个 key 用多个模型」是天然支持的：提取时按 (provider, model) 展开成多条，
 * 而不是只取 provider 上的某一个 model 字段。
 *
 * 规则（用户明确要求）：**没有密钥的 provider 一律不提取**。
 * ============================================================================
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/* ───────────── 极简 YAML（够用即可：map / list / scalar）───────────── */

function stripComment(line) {
  let q = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) { if (c === q) q = null; continue }
    if (c === '"' || c === "'") { q = c; continue }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

function scalar(v) {
  let s = String(v).trim()
  if (!s) return null
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1)
  if (s === 'true') return true
  if (s === 'false') return false
  if (s === 'null' || s === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  return s
}

/** 把 YAML 文本解析成 JS 值（只支持项目里出现的子集） */
export function parseYaml(text) {
  const items = []
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue
    const noC = stripComment(raw)
    if (!noC.trim()) continue
    const indent = (noC.match(/^ */) || [''])[0].length
    items.push({ indent, text: noC.trim() })
  }
  let i = 0

  const isSeqItem = (t) => t === '-' || t.startsWith('- ')

  function parseNode(indent) {
    if (i >= items.length) return null
    const cur = items[i]
    if (cur.indent < indent) return null
    return isSeqItem(cur.text) ? parseSeq(cur.indent) : parseMap(cur.indent)
  }

  function parseSeq(ind) {
    const arr = []
    while (i < items.length && items[i].indent === ind && isSeqItem(items[i].text)) {
      const rest = items[i].text === '-' ? '' : items[i].text.slice(2).trim()
      i++
      if (!rest) { arr.push(parseNode(ind + 1)); continue }
      if (/^[^:'"]+:\s/.test(rest) || /^[^:'"]+:$/.test(rest)) {
        // "- key: value" → 该项是个 map，把剩余部分当作缩进更深的 map 首行
        items.splice(i, 0, { indent: ind + 2, text: rest })
        arr.push(parseMap(ind + 2))
      } else {
        arr.push(scalar(rest))
      }
    }
    return arr
  }

  function parseMap(ind) {
    const obj = {}
    while (i < items.length && items[i].indent === ind && !isSeqItem(items[i].text)) {
      const t = items[i].text
      const m = t.match(/^("(?:[^"]*)"|'(?:[^']*)'|[^:]+):\s*(.*)$/)
      if (!m) { i++; continue }
      const key = String(scalar(m[1]) ?? m[1])
      const val = m[2].trim()
      i++
      if (val === '') {
        const nx = items[i]
        if (!nx) { obj[key] = null; continue }
        if (nx.indent > ind) obj[key] = parseNode(nx.indent)
        else if (nx.indent === ind && isSeqItem(nx.text)) obj[key] = parseSeq(ind)
        else obj[key] = null
      } else obj[key] = scalar(val)
    }
    return obj
  }

  const root = parseNode(items.length ? items[0].indent : 0)
  return root
}

/* ───────────── 读 DSH 的 provider / 密钥 ───────────── */

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 读 .credentials.yaml 的 refs（明文 env→key） */
export function readCredentialRefs(home = dshHome()) {
  const out = {}
  try {
    const f = join(home, '.credentials.yaml')
    if (!existsSync(f)) return out
    const doc = parseYaml(readFileSync(f, 'utf8'))
    const refs = doc && doc.refs
    if (refs && typeof refs === 'object') {
      for (const k of Object.keys(refs)) {
        const v = refs[k]
        if (typeof v === 'string' && v.trim()) out[k] = v.trim()
      }
    }
  } catch { /* 读不到就当没有 */ }
  return out
}

/** 递归找出所有 providers 映射（cordis 模块里可能有多处） */
function collectProviders(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) { for (const x of node) collectProviders(x, out); return out }
  for (const k of Object.keys(node)) {
    const v = node[k]
    if (k === 'providers' && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const pid of Object.keys(v)) {
        const p = v[pid]
        if (p && typeof p === 'object') out.push({ id: pid, ...p })
      }
    } else collectProviders(v, out)
  }
  return out
}

/**
 * 提取 DSH 里「有密钥」的模型，按 (provider, model) 展开。
 * 返回 [{ provider, providerLabel, apiUrl, apiKey, apiKeyEnv, modelId, modelName, label, hasKey }]
 */
export function extractDshModels(home = dshHome()) {
  const refs = readCredentialRefs(home)
  const seen = new Set()
  const out = []
  try {
    for (const profile of ['desktop', 'headless', 'web']) {
      const f = join(home, 'profiles', profile, 'cordis.patch.yml')
      if (!existsSync(f)) continue
      const doc = parseYaml(readFileSync(f, 'utf8'))
      for (const p of collectProviders(doc)) {
        const apiUrl = String(p.baseURL || p.baseUrl || p.apiBase || '').replace(/\/+$/, '')
        const inlineKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : ''
        const envName = String(p.apiKeyEnv || p.apiKeyEnvName || '')
        const apiKey = inlineKey || refs[envName] || ''
        if (!apiUrl) continue
        if (!apiKey) continue            // ← 没有密钥的不提取
        const provLabel = String(p.displayName || p.id)
        const models = Array.isArray(p.models) ? p.models : []
        for (const m of models) {
          if (!m) continue
          const mid = String(m.id || m.model || m.name || '').trim()
          if (!mid) continue
          const key = p.id + '|' + mid + '|' + apiUrl
          if (seen.has(key)) continue
          seen.add(key)
          out.push({
            provider: String(p.id),
            providerLabel: provLabel,
            apiUrl,
            apiKey,
            apiKeyEnv: envName,
            modelId: mid,
            modelName: mid,
            label: String(m.name || mid),
            hasKey: true,
          })
        }
      }
    }
  } catch { /* 纯尽力，绝不抛 */ }
  return out
}

/** 给前端看的 provider 分组（只含有密钥的；模型列表按 provider 归拢） */
export function listDshProviders(home = dshHome()) {
  const models = extractDshModels(home)
  const map = new Map()
  for (const m of models) {
    const k = m.provider + '|' + m.apiUrl
    if (!map.has(k)) map.set(k, { provider: m.provider, label: m.providerLabel, apiUrl: m.apiUrl, models: [] })
    map.get(k).models.push({ id: m.modelId, name: m.label })
  }
  return Array.from(map.values())
}
