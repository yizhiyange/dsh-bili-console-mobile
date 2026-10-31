/**
 * lib/asr.mjs —— 本地语音转写（可选能力）
 * ============================================================================
 * 现状：**这是插件里唯一需要你自己装依赖的功能**。
 *   pip install faster-whisper          （还要 ffmpeg 在 PATH 里）
 * 没装也能跑——只是「没字幕的视频」会直接跳过，不会卡住整轮。
 *
 * 这个模块只做两件事：
 *   1) 诚实探测：本机到底有没有可用的转写后端（不猜、不假装）
 *   2) 有就用：把音频文件转成文字（由调用方负责拿到音频文件）
 * 探测结果会出现在界面的「运行环境」里，你知道自己开没开起来。
 * ============================================================================
 */
import { execFile, spawnSync } from 'node:child_process'

let cached = null

/**
 * 探测转写后端是否可用。
 * @param {string} python 解释器路径（用插件已经选好的那个，不另找）
 * @returns {Promise<{ready:boolean, backend?:string, reason?:string}>}
 */
/** 装完转写后端后清缓存，让界面立刻变成"就绪" */
export function resetAsrCache() { cached = null }

export function asrStatus(python) {
  if (cached && cached.python === python) return Promise.resolve(cached.value)
  // 注意：Windows 下 execFile 传多行 -c 代码会被截断，所以一个模块一条命令地探
  const probe = (mod) => new Promise((resolve) => {
    execFile(python, ['-c', 'import ' + mod], { timeout: 20000 }, (err) => resolve(!err))
  })
  return (async () => {
    for (const mod of ['faster_whisper', 'whisper']) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(mod)) {
        const value = { ready: true, backend: mod }
        cached = { python, value }
        return value
      }
    }
    const value = { ready: false, reason: '没装 faster-whisper（装法：pip install faster-whisper，并确保 ffmpeg 在 PATH 里）' }
    cached = { python, value }
    return value
  })()
}


/**
 * 云端转写：把音频 POST 给 OpenAI 兼容的 /audio/transcriptions 接口。
 * 为什么加这条：手机上装 faster-whisper（onnxruntime/av/numpy 一堆）经常装不下或装不动，
 *             云端只花几分钱、不用装东西，是更现实的选择（2026-10-31 用户实测装失败后加）。
 * @param {{apiUrl:string, apiKey:string, model:string, audioPath:string}} o
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function transcribeCloud(o = {}) {
  const { apiUrl, apiKey, model, audioPath } = o
  if (!apiUrl || !apiKey) return { ok: false, error: '云端转写没配地址或 Key' }
  if (!audioPath) return { ok: false, error: '没有音频文件' }
  const base = String(apiUrl).trim().replace(/\/+$/, '')
  const url = /\/audio\/transcriptions$/.test(base) ? base : base + '/audio/transcriptions'
  const ctrl = new AbortController()
  const timer = setTimeout(() => { try { ctrl.abort() } catch {} }, 180000)
  try {
    // 动态 import：只在真用到云端时才加载 fs，避免影响插件启动
    const { readFileSync } = await import('node:fs')
    const buf = readFileSync(audioPath)
    const fd = new FormData()
    fd.append('file', new Blob([buf], { type: 'audio/mp4' }), 'audio.m4a')
    fd.append('model', String(model || 'whisper-1'))
    fd.append('response_format', 'json')
    const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + apiKey }, body: fd, signal: ctrl.signal })
    const raw = await r.text()
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + '：' + raw.slice(0, 160) }
    let text = ''
    try { text = String((JSON.parse(raw) || {}).text || '') } catch { text = String(raw || '') }
    text = text.trim()
    return text ? { ok: true, text } : { ok: false, error: '云端返回空结果' }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 160) }
  } finally { clearTimeout(timer) }
}

/**
 * 综合判断"转写能不能用"——按模式分流，界面和跑轮都用它，避免两处判断不一致。
 * @returns {Promise<{ready:boolean, mode:'local'|'cloud', backend:string, reason:string}>}
 */
export async function asrReadiness(cfg = {}, python = 'python') {
  const mode = cfg.asrMode === 'cloud' ? 'cloud' : 'local'
  if (mode === 'cloud') {
    const ok = Boolean(cfg.asrCloudUrl && cfg.asrCloudKey)
    return {
      ready: ok, mode,
      backend: ok ? ('云端 · ' + (cfg.asrCloudModel || 'whisper-1')) : '',
      reason: ok ? '' : '云端转写还没填 API 地址 / Key',
    }
  }
  const st = await asrStatus(python)
  return { ready: st.ready, mode, backend: st.backend || '', reason: st.reason || '' }
}


/**
 * 转写自检：真的去 import 一次，告诉用户"装了什么版本、能不能用"。
 * 为什么要它：卡片显示"就绪"只代表能 import，用户看不到证据；给个按钮点一下出结果，最实在。
 * @returns {Promise<{ok:boolean, backend?:string, version?:string, ffmpeg?:boolean, error?:string}>}
 */
export function asrDiag(python) {
  const code = [
    'import json, sys',
    'out = {}',
    'try:',
    '    import faster_whisper',
    '    out["backend"] = "faster_whisper"',
    '    try:',
    '        import importlib.metadata as m',
    '        out["version"] = m.version("faster-whisper")',
    '    except Exception:',
    '        out["version"] = getattr(faster_whisper, "__version__", "未知")',
    'except Exception as e1:',
    '    try:',
    '        import whisper',
    '        out["backend"] = "whisper"',
    '        out["version"] = getattr(whisper, "__version__", "未知")',
    '    except Exception:',
    '        out["error"] = "没装 faster-whisper（" + str(e1)[:120] + "）",',
    'print(json.dumps(out, ensure_ascii=False))',
  ].join('\n')
  return new Promise((resolve) => {
    execFile(python, ['-c', code], { timeout: 30000 }, (err, stdout) => {
      const ffmpegOk = (() => {
        try {
          const r = spawnSync('ffmpeg', ['-version'], { timeout: 5000, windowsHide: true })
          return r.status === 0
        } catch { return false }
      })()
      if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 160), ffmpeg: ffmpegOk })
      let j = {}
      try { j = JSON.parse(String(stdout || '{}')) } catch {}
      if (j.backend) return resolve({ ok: true, backend: j.backend, version: j.version || '未知', ffmpeg: ffmpegOk })
      return resolve({ ok: false, error: j.error || '装不上：import 失败', ffmpeg: ffmpegOk })
    })
  })
}

/**
 * 转写一个音频文件。
 * 真正的解码/模型推理在 Python 侧做，这里只负责把文件喂过去、拿回文字。
 * @returns {Promise<{ok:boolean, text?:string, error?:string}>}
 */
export async function transcribeFile(python, audioPath, modelSize = 'small') {
  const st = await asrStatus(python)
  if (!st.ready) return { ok: false, error: st.reason || '转写后端不可用' }
  if (!audioPath) return { ok: false, error: '没有音频文件' }
  const code = [
    'import sys, json',
    'from faster_whisper import WhisperModel',
    'm = WhisperModel(sys.argv[2] or "small", device="cpu", compute_type="int8")',
    'segs, _ = m.transcribe(sys.argv[1], vad_filter=True)',
    'print(json.dumps({"text": "".join(s.text for s in segs)}, ensure_ascii=False))',
  ].join('\n')
  return new Promise((resolve) => {
    execFile(python, ['-c', code, audioPath, String(modelSize || 'small')], { timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: String(err.message || err).slice(0, 160) })
      try {
        const j = JSON.parse(String(stdout || '{}'))
        const text = String(j.text || '').trim()
        return resolve(text ? { ok: true, text } : { ok: false, error: '转写结果为空' })
      } catch { return resolve({ ok: false, error: '转写输出无法解析' }) }
    })
  })
}
