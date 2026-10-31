/**
 * memsave.mjs —— 真正的「运行内存」优化（2026-11-1 加）
 * ============================================================================
 * ⚠️ 分清两件事（用户 2026-11-1 纠正过我一次，别再混）：
 *   · 磁盘/存储：duty.log 裁剪、删旧备份 → 在 index.js / state.mjs 里，不是这个文件
 *   · 运行内存 RAM：这里管的事 —— 让插件少占「进程活着就一直占着」的那部分内存
 *
 * 为什么重要：插件挂在宿主进程上，Node 进程内存一大，手机系统会把后台杀掉
 *（你切出去聊个微信回来插件就被回收了），所以这块在手机上很实在。
 *
 * ⚠️ 电脑版默认什么也不做：不会自动清理，只有用户手动点才动。
 */

import { readFileSync } from 'node:fs'
import { clearFlavorCache } from './llm.mjs'
import { trimDepCache } from './pyenv.mjs'

/** Node 进程实际占用的物理内存 RSS（字节） */
export function processRss() {
  try { return process.memoryUsage().rss } catch { return 0 }
}

/**
 * 系统内存概况（手机上还能读到 swap / zram）。
 * 这也是用来回答「能不能拿存储空间当内存」的：SwapTotal>0 表示系统已经在用交换内存了，
 * 我们再自作主张搞一份只会帮倒忙（还费闪存寿命）。
 */
export function systemMem() {
  try {
    if (process.platform !== 'linux') return null
    const t = readFileSync('/proc/meminfo', 'utf8')
    const pick = (k) => {
      const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(t)
      return m ? Number(m[1]) * 1024 : 0
    }
    const total = pick('MemTotal')
    const avail = pick('MemAvailable')
    return {
      total,
      available: avail,
      used: Math.max(0, total - avail),
      swapTotal: pick('SwapTotal'),
      swapFree: pick('SwapFree'),
    }
  } catch { return null }
}

/**
 * 释放能释放的内存。
 * @param {object} [opts]
 * @param {boolean} [opts.aggressive] true 时连长期缓存也清（腾得更干净，代价是下次调用稍微多试一次）
 */
export function freeMemory({ aggressive = false } = {}) {
  const out = { before: processRss(), freed: {}, gc: false }
  try {
    // ① LLM 的「接口方言」试探结果：每个 接口+模型 一条，模型多时会攒不少
    out.freed.flavorCache = aggressive ? clearFlavorCache() : 0
    // ② 依赖探测里「失败」的记录（成功记录留着，避免反复 spawn Python）
    out.freed.depCacheFailures = trimDepCache()
  } catch (e) {
    out.error = String((e && e.message) || e)
  }
  // ③ 建议 Node 收一遍垃圾（宿主没加 --expose-gc 就静默跳过）
  try {
    if (typeof global !== 'undefined' && typeof global.gc === 'function') { global.gc(); out.gc = true }
  } catch { /* 没开就算了 */ }
  out.after = processRss()
  return out
}

/**
 * 省电/省内存的各项参数（手机 vs 电脑）——集中一处判断，别散落在各处 if 里。
 * 电脑永远拿到默认值，所以电脑行为不会被悄悄改掉。
 */
export function powerSaving(cfg = {}) {
  const isPhone = process.platform === 'linux'
  const low = !!cfg.lowPower
  const saving = low || isPhone
  return {
    isPhone,
    lowPower: low,
    saving,
    pollMs: saving ? 6000 : 2000,
    logPollMs: saving ? 8000 : 3000,
    repPollMs: saving ? 15000 : 5000,
    rawlogLines: low ? 60 : 240,
    ffmpegSingleThread: saving,
  }
}
