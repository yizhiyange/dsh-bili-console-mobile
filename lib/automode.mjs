/**
 * lib/automode.mjs —— 「自动模式」一键配置（2026-11-1 初版，2026-11-4 重做）
 * ============================================================================
 * 用户要的是：像跑个机器人一样，配一次就不用管，24 小时自己转。
 *
 * ⚠️ 2026-11-4 重做的原因（两个真 bug，用户问「会不会和安防冲突」时查出来的）：
 *   1. 旧版把 `cooldownMinutes` 当成「每轮间隔」写进配置。其实那个字段是
 *      **风控冷却时间**（触发验证码/429 后停手多久），默认 1440 分钟 = 24 小时。
 *      套「稳妥」档会把它改成 8 分钟 → **风控保护从 24 小时缩到 10 分钟**，非常危险。
 *   2. 调度器本来就没有「两轮之间隔多久」的判断，旧版 UI 上写的「间隔 ≥ 8 分钟」
 *      是假的：实际每 5 分钟就跑一轮。
 *   现在分清楚了：
 *      · roundIntervalMinutes → 每轮间隔（本次新加，真正生效）
 *      · cooldownMinutes      → 风控冷却，自动模式**永远不碰**
 *
 * 另一个设计原则：**自动模式只管「频率和时段」，不管「对外动作」。**
 *   点赞 / 投币 / 回评论 / 私信 / 自动评论这些开关在「安全防护」页，是用户的安全底线。
 *   自动模式默认一个都不改，只在界面上把「这个档位建议怎么开」列出来，由用户自己决定。
 *
 * 参数不是拍脑袋来的，是照社区里那些长期挂着的 B站 自动号的做法总结的：
 *   · 低频优先：一天 6~20 条，比"一小时刷几十条"活得久得多（B站 有频控）
 *   · 保留人类作息：半夜集体活动最容易进风险名单
 *   · 互动克制：点赞可以有，投币谨慎（花自己的币），私信只回熟人
 *   · 随机抖动：不要整点整分照表跑（调度器每轮前随机等 0~3 分钟）
 */

import { rangeHours, valleyHours, loadConfig, saveConfig } from './state.mjs'

/** 预设：都偏保守，因为这是挂在你真实账号上的 */
export const PRESETS = {
  safe: {
    label: '稳妥',
    desc: '一天 6 条，每轮 3 条，间隔 30 分钟，只跑 9:00–23:00，每轮看 30 条候选',
    values: {
      schedulerOn: true,
      perDay: 6,
      commentPerRound: 3,
      roundIntervalMinutes: 30,
      scanPerRound: 30,
      scheduleMode: 'window',
      activeStart: '09:00',
      activeEnd: '23:00',
      peakValley: false,
      noon: true,
      night: false,
      useHomeFeed: true,
      useKeywordSearch: true,
      lowPower: true,
      useAssets: true,
    },
    // 只是「建议」，默认不写进配置（见文件头的设计原则）
    suggest: { autoComment: true, autoLike: true, autoCoin: false, replyToComments: false, dmMode: 'off' },
  },
  balanced: {
    label: '平衡',
    desc: '一天 12 条，每轮 5 条，间隔 15 分钟，全天跑（夜间也跑），每轮看 40 条候选',
    values: {
      schedulerOn: true,
      perDay: 12,
      commentPerRound: 5,
      roundIntervalMinutes: 15,
      scanPerRound: 40,
      scheduleMode: 'any',
      activeStart: '09:00',
      activeEnd: '23:00',
      peakValley: false,
      noon: true,
      night: true,
      useHomeFeed: true,
      useKeywordSearch: true,
      lowPower: true,
      useAssets: true,
    },
    suggest: { autoComment: true, autoLike: true, autoCoin: true, replyToComments: true, dmMode: 'off' },
  },
  aggressive: {
    label: '激进',
    desc: '一天 20 条，每轮 8 条，间隔 8 分钟，全天跑，每轮看 60 条候选。⚠️ 频率高，容易被限流',
    values: {
      schedulerOn: true,
      perDay: 20,
      commentPerRound: 8,
      roundIntervalMinutes: 8,
      scanPerRound: 60,
      scheduleMode: 'any',
      activeStart: '00:00',
      activeEnd: '23:59',
      peakValley: false,
      noon: true,
      night: true,
      useHomeFeed: true,
      useKeywordSearch: true,
      lowPower: true,
      useAssets: true,
    },
    suggest: { autoComment: true, autoLike: true, autoCoin: true, replyToComments: true, dmMode: 'only' },
  },
  custom: {
    label: '自定义',
    desc: '每一项都自己填：每天几条、每轮几条、隔多久、每轮看多少条视频、跑哪个时段',
    values: {
      schedulerOn: true,
      perDay: 8,
      commentPerRound: 4,
      roundIntervalMinutes: 20,
      scanPerRound: 40,
      scheduleMode: 'window',
      activeStart: '09:00',
      activeEnd: '23:00',
      peakValley: false,
      noon: true,
      night: false,
      useHomeFeed: true,
      useKeywordSearch: true,
      lowPower: true,
      useAssets: true,
    },
    suggest: { autoComment: true, autoLike: false, autoCoin: false, replyToComments: false, dmMode: 'off' },
  },
}

/**
 * 自动模式能改的字段（频次 / 时段 / 数据来源）。
 * ⚠️ 故意**不含**：autoComment / autoLike / autoCoin / replyToComments / dmMode / cooldownMinutes
 *   —— 前五个归「安全防护」页管，最后一个是风控冷却，都不能让"套个档位"顺手改掉。
 */
export const FREQ_KEYS = new Set(Object.keys(PRESETS.safe.values))
/** 兼容旧名字（万一别处引用了） */
export const AUTOMODE_KEYS = FREQ_KEYS

/** 归「安全防护」管的开关：自动模式默认一个都不动，只展示建议值 */
export const INTERACTION_KEYS = ['autoComment', 'autoLike', 'autoCoin', 'replyToComments', 'dmMode']
export const INTERACTION_LABELS = {
  autoComment: '自动评论并 @',
  autoLike: '顺手点赞',
  autoCoin: '投币',
  replyToComments: '回复评论',
  dmMode: '私信投递',
}

/** 只保底、不封顶：负数/NaN/Infinity 才处理，正数多大都照收（2026-11-4 用户要求） */
const clampLow = (v, lo, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.max(lo, Math.floor(n))
}
const T_RE = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * 计算最终配置：预设 → 覆盖 → 兜底夹取
 * @param {string} preset safe|balanced|aggressive|custom
 * @param {object} overrides 用户自定义项（只认 FREQ_KEYS 里的键）
 * @param {{allDay?:boolean}} opt allDay 是旧版参数，等价于 scheduleMode='any'
 */
export function computeAutoConfig(preset = 'safe', overrides = {}, opt = {}) {
  const base = PRESETS[preset] || PRESETS.safe
  const out = { ...base.values }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (FREQ_KEYS.has(k) && v !== undefined && v !== null && v !== '') out[k] = v
  }
  if (opt.allDay === true) out.scheduleMode = 'any'

  // **没有上限**（2026-11-4 用户要求：别人可能不在乎钱也不在乎性能）
  // 只挡"负数/NaN/Infinity"这种手滑，不替用户决定最多能跑多少
  out.perDay = clampLow(out.perDay, 1, 6)
  out.commentPerRound = clampLow(out.commentPerRound, 1, 3)
  out.roundIntervalMinutes = clampLow(out.roundIntervalMinutes, 1, 5)
  out.scanPerRound = clampLow(out.scanPerRound, 0, 0)
  // 安全兜底：每轮不能大于每天（否则第一轮就把额度用光，没有"持续感"）
  if (out.commentPerRound > out.perDay) out.commentPerRound = out.perDay

  out.scheduleMode = ['any', 'window', 'valley'].includes(String(out.scheduleMode)) ? String(out.scheduleMode) : 'any'
  out.activeStart = T_RE.test(String(out.activeStart)) ? String(out.activeStart) : '09:00'
  out.activeEnd = T_RE.test(String(out.activeEnd)) ? String(out.activeEnd) : '23:00'
  // 开始=结束 在 inRange 里等于"整天"，这里明确按 24 小时处理，别让人以为是 0 小时
  out.peakValley = out.scheduleMode === 'valley'
  return out
}

/** 这个档位建议怎么设「对外动作」的开关（只用于展示/用户勾选后应用） */
export function suggestInteractions(preset = 'safe') {
  return { ...((PRESETS[preset] || PRESETS.safe).suggest || {}) }
}

/**
 * 对比「建议值」和「当前值」，给界面提示用。
 * 用途：用户勾「连互动一起改」之前，先看清会覆盖掉哪些安全防护设置。
 */
export function interactionDiff(preset = 'safe', current = {}) {
  const sug = suggestInteractions(preset)
  return INTERACTION_KEYS
    .filter((k) => sug[k] !== undefined)
    .map((k) => ({
      key: k,
      label: INTERACTION_LABELS[k] || k,
      current: current[k],
      next: sug[k],
      same: current[k] === sug[k],
    }))
}

/** 应用后的一句话说明，给界面/日志用 */
export function describeAuto(cfg = {}) {
  const parts = [
    '每天最多 ' + cfg.perDay + ' 条',
    '每轮 ' + cfg.commentPerRound + ' 条',
    '间隔 ≥ ' + cfg.roundIntervalMinutes + ' 分钟',
    '每轮最多看 ' + (cfg.scanPerRound ? (cfg.scanPerRound + ' 条视频') : '默认量视频'),
    '时段：' + scheduleLabel(cfg),
  ]
  return parts.join('；')
}

/** 时段的人话标签 */
export function scheduleLabel(cfg = {}) {
  const mode = String(cfg.scheduleMode || 'any')
  if (mode === 'window') return '每天 ' + (cfg.activeStart || '09:00') + '–' + (cfg.activeEnd || '23:00')
  if (mode === 'valley') return '只在官方谷时'
  return '全天 7×24'
}

/** 这套配置一天真正能跑多少小时 */
export function activeHours(cfg = {}) {
  const mode = String(cfg.scheduleMode || 'any')
  if (mode === 'window') return rangeHours(cfg.activeStart || '09:00', cfg.activeEnd || '23:00')
  if (mode === 'valley') return valleyHours(cfg)
  return 24
}

/**
 * 估算"一天大概跑几轮、发几条、要看多少视频"——让用户应用前心里有数。
 * 只做算术，不发请求。
 */
export function estimateDay(cfg = {}) {
  const perDay = Math.max(1, Number(cfg.perDay) || 6)
  const perRound = Math.max(1, Math.min(Number(cfg.commentPerRound) || 3, perDay))
  const gap = Math.max(1, Number(cfg.roundIntervalMinutes) || 5)
  const hours = activeHours(cfg)
  const maxRoundsByTime = Math.max(0, Math.floor((hours * 60) / gap))
  const rounds = Math.min(maxRoundsByTime, Math.ceil(perDay / perRound))
  const scanPerRound = Math.max(0, Number(cfg.scanPerRound) || 0)
  return {
    rounds,
    perRound,
    comments: Math.min(perDay, rounds * perRound),
    effGapMinutes: gap,
    windowHours: hours,
    scanPerRound,
    // 一天大概要看多少条视频（scanPerRound=0 时按默认 30 估算，给个量级感）
    videosPerDay: rounds * (scanPerRound || 30),
  }
}

/**
 * 真正落盘：预设值 + 用户覆盖 → 写进配置。
 * 为什么要单独一个函数（而不是塞在 HTTP 路由里）：路由没法单独跑测试，
 * 而"有没有动到安全防护的开关"这种事必须能验证（2026-11-4）。
 *
 * @param {string} home 插件数据目录
 * @param {string} preset 档位
 * @param {object} overrides 用户改的频次/时段
 * @param {{allDay?:boolean, applyInteractions?:boolean}} opt
 */
export function applyAutoMode(home, preset = 'safe', overrides = {}, opt = {}) {
  const c = loadConfig(home)
  const values = computeAutoConfig(preset, overrides, opt)
  const next = { ...c, ...values }
  const notes = []

  // 「对外动作」归安全防护页管：只有显式勾选才一起写
  const wantInteraction = opt.applyInteractions === true
  if (wantInteraction) {
    Object.assign(next, suggestInteractions(preset))
    notes.push('已按档位设置互动开关（覆盖了「安全防护」页的对应项）')
  } else {
    notes.push('互动开关（评论/点赞/投币/回评论/私信）保持「安全防护」页原样，没有改动')
  }

  // 修复 v0.3.61 的坑：旧版把「风控冷却」当成每轮间隔写成了 8 分钟，
  // 风控保护从 24 小时缩到 10 分钟。低于 1 小时的一律拉回 24 小时。
  const cd = Number(c.cooldownMinutes)
  if (Number.isFinite(cd) && cd > 0 && cd < 60) {
    next.cooldownMinutes = 1440
    notes.push('顺手修好了风控冷却：' + cd + ' 分钟 → 1440 分钟（之前被旧版自动模式误改，太短了）')
  }

  saveConfig(home, next)
  return {
    ok: true,
    values,
    estimate: estimateDay(values),
    summary: describeAuto(values),
    notes,
    warnings: warningsFor(values),
    adjustments: adjustmentsFor(overrides, values),
    interactionsApplied: wantInteraction,
    schedule: scheduleLabel(values),
  }
}

/**
 * 「这样会被封号吗」提醒（不阻止，只提醒）
 * ============================================================================
 * 用户明确要求：上限几乎不设，别人可能不差钱也不差性能。
 * 所以这里**不做硬限制**，只把风险讲清楚——决定权在用户手里。
 */
export function warningsFor(cfg = {}) {
  const w = []
  const perDay = Number(cfg.perDay) || 0
  const per = Number(cfg.commentPerRound) || 0
  const gap = Number(cfg.roundIntervalMinutes) || 0
  const scan = Number(cfg.scanPerRound) || 0
  if (perDay > 100) w.push('一天 ' + perDay + ' 条：远超正常账号频率，被限流/风控的概率很高（真被限了会自动停 24 小时）')
  if (per > 25) w.push('每轮 ' + per + ' 条：单轮动作太密，很容易触发频率限制')
  if (gap > 0 && gap < 2) w.push('间隔 ' + gap + ' 分钟：基本等于连续操作，是风险最高的一档')
  if (scan > 300) w.push('每轮翻 ' + scan + ' 条：会很慢、很费 token（每条都要过一遍粗筛）')
  return w
}

/**
 * 「你填的值和实际存的值差在哪」——明着告诉你，绝不静默改。
 * 用户 2026-11-4 要求：不要有偷偷砍掉的操作，改了就说。
 */
export function adjustmentsFor(overrides = {}, values = {}) {
  const out = []
  const LABEL = {
    perDay: '每天上限', commentPerRound: '每轮发', roundIntervalMinutes: '每轮间隔', scanPerRound: '每轮看多少条',
  }
  for (const key of ['perDay', 'commentPerRound', 'roundIntervalMinutes', 'scanPerRound']) {
    if (overrides[key] === undefined || overrides[key] === '' || overrides[key] === null) continue
    const want = Number(overrides[key])
    const got = Number(values[key])
    if (Number.isFinite(want) && Number.isFinite(got) && Math.floor(want) !== Math.floor(got)) {
      const why = !Number.isFinite(want) ? '不是有效数字' : (want < got ? '低于允许的最小值' : '受其他项限制')
      out.push('「' + (LABEL[key] || key) + '」你填的是 ' + overrides[key] + '，实际按 ' + got + ' 处理（' + why + '）')
    }
  }
  if (overrides.commentPerRound !== undefined && values.commentPerRound !== undefined) {
    const per = Number(values.commentPerRound), day = Number(values.perDay)
    if (Number.isFinite(per) && Number.isFinite(day) && per > day) {
      out.push('「每轮发」不能大于「每天上限」，已收到 ' + day + ' 条')
    }
  }
  const T_RE = /^([01]\d|2[0-3]):[0-5]\d$/
  for (const [k, label, dflt] of [['activeStart', '开始时间', '09:00'], ['activeEnd', '结束时间', '23:00']]) {
    if (overrides[k] === undefined || overrides[k] === '') continue
    if (!T_RE.test(String(overrides[k]))) out.push('「' + label + '」格式不对（要 HH:MM），已按 ' + dflt + ' 处理')
  }
  if (overrides.scheduleMode !== undefined && !['any', 'window', 'valley'].includes(String(overrides.scheduleMode))) {
    out.push('「运行时段」取值不认识，已按「全天 7×24」处理')
  }
  return out
}
