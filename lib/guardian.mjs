/**
 * lib/guardian.mjs —— 风控规则库
 * ============================================================================
 * 综合网上实测（评论区助手、矩阵运营安全清单、风控码讨论）整理出的已知风控码表，
 * 以及分级处置策略。原则（网上原话）：没有任何工具能零风险——所以默认保守、
 * 命中了就停，不硬顶、不无限重试。
 *
 * 分级：
 *   cooldown     长冷却（默认 24h，可在设置里调，最低 10 分钟）——验证码 / 限流 / 风控码
 *   stop-day     今天收工——当日互动上限
 *   stop-round   本轮停止——频率过快（下一轮恢复正常）
 * 冷却状态落盘（home/guardian.json），重启不丢。
 * ============================================================================
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 已知风控码表：key 是会在日志/报错里出现的字符串 */
export const CODES = {
  '-412':     { level: 'block',    label: '风控拦截（-412）',     action: 'cooldown' },
  '-352':     { level: 'block',    label: '风控拦截（-352）',     action: 'cooldown' },
  '-403':     { level: 'block',    label: '风控拦截（-403）',     action: 'cooldown' },
  '12045':    { level: 'captcha',  label: '触发验证码（12045）',  action: 'cooldown' },
  '12008':    { level: 'daylimit', label: '达到当日上限（12008）', action: 'stop-day' },
  '12002':    { level: 'freq',     label: '频率过快（12002）',    action: 'stop-round' },
  '429':      { level: 'ratelimit', label: '被限流（429）',       action: 'cooldown' },
  '21007':    { level: 'dm-limit', label: '私信超长被拒（21007）', action: 'stop-round' },
}

export const DEFAULTS = {
  cooldownMinutes: 1440,   // 24 小时：网上矩阵运营者的铁律——触发验证码/429 停手 24h 以上
  minCooldownMinutes: 10,  // 设置里允许调到的下限
}

/** 从一段文本里找出命中的风控码 */
export function classify(text) {
  const s = String(text || '')
  for (const code of Object.keys(CODES)) {
    if (s.includes(code)) return { code, ...CODES[code] }
  }
  // 兜底：措辞匹配
  if (/验证码/.test(s)) return { code: 'captcha-text', level: 'captcha', label: '遇到验证码', action: 'cooldown' }
  if (/风控/.test(s)) return { code: 'risk-text', level: 'block', label: '风控相关报错', action: 'cooldown' }
  return null
}

/**
 * 决定怎么处置。cfg.cooldownMinutes 可调（分钟）。
 * @returns {{action:'cooldown'|'stop-day'|'stop-round'|'none', label:string, until?:number}}
 */
export function decide(text, cfg = {}) {
  const hit = classify(text)
  if (!hit) return { action: 'none', label: '' }
  if (hit.action === 'cooldown') {
    const mins = Math.max(DEFAULTS.minCooldownMinutes, Number(cfg.cooldownMinutes) || DEFAULTS.cooldownMinutes)
    return { action: 'cooldown', label: hit.label, until: Date.now() + mins * 60000, minutes: mins }
  }
  return { action: hit.action, label: hit.label }
}

/** 冷却状态：落盘、可查、可手动解除 */
export class Cooldown {
  constructor(home) {
    this.file = join(home, 'guardian.json')
    this.state = this._load()
  }
  _load() {
    try {
      if (existsSync(this.file)) {
        const d = JSON.parse(readFileSync(this.file, 'utf8'))
        return { until: Number(d.until) || 0, reason: String(d.reason || '') }
      }
    } catch { /* 读不到就当没冷却 */ }
    return { until: 0, reason: '' }
  }
  _save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.state, null, 2))
    } catch { /* 落盘失败不致命：内存里仍然生效 */ }
  }
  /** 命中风控 → 进入冷却 */
  engage(decision, at = Date.now()) {
    if (decision.action !== 'cooldown') return false
    this.state = { until: decision.until || at + DEFAULTS.cooldownMinutes * 60000, reason: decision.label || '风控冷却' }
    this._save()
    return true
  }
  active(now = Date.now()) { return this.state.until > now }
  remaining(now = Date.now()) { return Math.max(0, this.state.until - now) }
  clear() { this.state = { until: 0, reason: '' }; this._save() }
}
