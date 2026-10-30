/**
 * lib/vision.mjs —— 识图（可选能力）
 * ============================================================================
 * 什么时候用：视频**没有字幕**时，让识图模型看一眼封面，给判断补一点信息。
 * 用的是配置里的 visionModel（apiUrl / apiKey / modelName），可以跟主模型不是同一个。
 * 没配、或者调用失败 → 返回 {ok:false}，调用方当"没有这条信息"继续，绝不阻塞轮次。
 * ============================================================================
 */
export function visionReady(cfg) {
  const v = (cfg && cfg.visionModel) || {}
  return Boolean(v.apiUrl && v.apiKey && v.modelName)
}

/**
 * 让识图模型描述一张图。
 * @param {object} cfg 插件配置（取 cfg.visionModel）
 * @param {string} imageUrl 公网可访问的图片地址（B站 封面就是）
 * @param {string} question 你想问什么
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function describeImage(cfg, imageUrl, question) {
  const v = (cfg && cfg.visionModel) || {}
  if (!visionReady(cfg)) return { ok: false, error: '没配识图模型' }
  if (!imageUrl) return { ok: false, error: '没有图片地址' }
  try {
    const res = await fetch(v.apiUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + v.apiKey },
      body: JSON.stringify({
        model: v.modelName,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: question || '用一句话描述这张图（30字内），别客套。' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        }],
        max_tokens: 200,
        temperature: 0.3,
      }),
      signal: AbortSignal.timeout(60000),
    })
    const txt = await res.text()
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status + '：' + txt.slice(0, 120) }
    let data
    try { data = JSON.parse(txt) } catch { return { ok: false, error: '返回不是 JSON' } }
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {}
    let c = msg.content
    if (Array.isArray(c)) c = c.map((x) => (x && x.text) || '').join('')
    const text = String(c || '').trim()
    return text ? { ok: true, text: text.slice(0, 300) } : { ok: false, error: '返回空内容' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  }
}
