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
import { execFile } from 'node:child_process'

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
