/**
 * lib/automode.mjs —— 「自动模式」一键配置（2026-11-1 加）
 * ============================================================================
 * 用户要的是：像跑个机器人一样，配一次就不用管，24 小时自己转。
 *
 * 参数不是拍脑袋来的，是照社区里那些长期挂着的 B站 自动号的做法总结的：
 *   · **低频优先**：一天 6~15 条，比"一小时刷几十条"活得久得多（B站 有频控，触发就限流/风控）
 *   · **评论要短、要像人**：这条在提示词里管，这里只管频次
 *   · **保留人类作息**：默认只在你设的时段跑（半夜集体活动最容易进风险名单）
 *   · **互动要克制**：点赞可以有，投币谨慎（投币要花你的币），私信只回熟人
 *   · **随机抖动**：不要整点整分照表跑，加一点随机偏移更像人
 *
 * 三档都是"能自定义"的：先套预设，再改任意一项，最后写入配置。
 */

/** 预设：都偏保守，因为这是挂在你真实账号上的 */
export const PRESETS = {
  safe: {
    label: '稳妥（推荐长期挂）',
    desc: '一天 6 条，每轮 3 条，评论间隔 8 分钟，只在白天活跃时段跑，不投币、不自动私信',
    values: {
      schedulerOn: true,
      autoComment: true,
      perDay: 6,
      commentPerRound: 3,
      cooldownMinutes: 8,
      peakValley: true,
      noon: true,
      night: false,
      autoLike: true,
      autoCoin: false,
      replyToComments: false,
      dmMode: 'off',
      useHomeFeed: true,
      useKeywordSearch: true,
      lowPower: true,
      useAssets: true,
    },
  },
  balanced: {
    label: '平衡（有点存在感）',
    desc: '一天 12 条，每轮 5 条，间隔 5 分钟，白天夜间都跑，点赞 + 少量投币，回自己视频下的评论',
    values: {
      schedulerOn: true,
      autoComment: true,
      perDay: 12,
      commentPerRound: 5,
      cooldownMinutes: 5,
      peakValley: false,
      noon: true,
      night: true,
      autoLike: true,
      autoCoin: true,
      replyToComments: true,
      dmMode: 'off',
      useHomeFeed: true,
      useKeywordSearch: true,
      lowPower: true,
      useAssets: true,
    },
  },
  aggressive: {
    label: '激进（不建议长期用）',
    desc: '一天 20 条，每轮 8 条，间隔 3 分钟，全天跑，点赞 + 投币 + 回评论。⚠️ 频率高，容易被限流甚至风控',
    values: {
      schedulerOn: true,
      autoComment: true,
      perDay: 20,
      commentPerRound: 8,
      cooldownMinutes: 3,
      peakValley: false,
      noon: true,
      night: true,
      autoLike: true,
      autoCoin: true,
      replyToComments: true,
      dmMode: 'only',
      useHomeFeed: true,
      useKeywordSearch: true,
      lowPower: true,
      useAssets: true,
    },
  },
}

/** 允许自动模式改的字段（白名单，别的配置不碰） */
export const AUTOMODE_KEYS = new Set(Object.keys(PRESETS.safe.values))

/**
 * 计算最终配置：预设 → 覆盖 → 全天开关
 * @param {string} preset safe|balanced|aggressive
 * @param {object} overrides 用户自定义项（只允许白名单内）
 * @param {{allDay?:boolean}} opt
 */
export function computeAutoConfig(preset = 'safe', overrides = {}, opt = {}) {
  const base = PRESETS[preset] || PRESETS.safe
  const out = { ...base.values }
  for (const [k, v] of Object.entries(overrides || {})) {
    if (AUTOMODE_KEYS.has(k) && v !== undefined) out[k] = v
  }
  // 24 小时：关掉时段限制（任何时间都允许跑）
  if (opt.allDay) { out.peakValley = false }
  // 数字兜底，防止手滑写个 9999
  out.perDay = Math.max(1, Math.min(50, Number(out.perDay) || 6))
  out.commentPerRound = Math.max(1, Math.min(15, Number(out.commentPerRound) || 3))
  out.cooldownMinutes = Math.max(1, Math.min(240, Number(out.cooldownMinutes) || 8))
  // 安全兜底：每轮不能大于每天（否则第一轮就把额度用光，没有"持续感"）
  if (out.commentPerRound > out.perDay) out.commentPerRound = out.perDay
  return out
}

/** 应用后的一句话说明，给界面/日志用 */
export function describeAuto(cfg = {}, allDay = false) {
  const parts = [
    '每天最多 ' + cfg.perDay + ' 条',
    '每轮 ' + cfg.commentPerRound + ' 条',
    '间隔 ≥ ' + cfg.cooldownMinutes + ' 分钟',
    allDay || !cfg.peakValley ? '全天都能跑' : '只在设定时段跑',
  ]
  if (cfg.autoLike) parts.push('点赞')
  if (cfg.autoCoin) parts.push('投币')
  if (cfg.replyToComments) parts.push('回评论')
  if (cfg.dmMode !== 'off') parts.push('私信=' + cfg.dmMode)
  return parts.join('；')
}

/**
 * 估算"一天大概跑几轮、发几条"——让用户应用前心里有数。
 * 只做算术，不发请求。
 */
export function estimateDay(cfg = {}, allDay = false) {
  const perDay = Math.max(1, Number(cfg.perDay) || 6)
  const perRound = Math.max(1, Math.min(Number(cfg.commentPerRound) || 3, perDay))
  const gap = Math.max(1, Number(cfg.cooldownMinutes) || 8)
  // 调度器每 5 分钟看一次；实际间隔 = max(5 分钟, 冷却时间)
  const effGap = Math.max(5, gap)
  const windowHours = allDay || !cfg.peakValley ? 24 : 12   // 只白天大约 12 小时
  const maxRoundsByTime = Math.floor((windowHours * 60) / effGap)
  const rounds = Math.min(maxRoundsByTime, Math.ceil(perDay / perRound))
  return {
    rounds,
    perRound,
    comments: Math.min(perDay, rounds * perRound),
    effGapMinutes: effGap,
    windowHours,
  }
}
