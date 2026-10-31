/**
 * lib/logread.mjs —— 原始日志读取 + 大白话翻译
 * ============================================================================
 * 两个职责，都是纯函数（好单测）：
 *   ① parseLine：duty.log 的 "2026-10-25T07:24:36.064Z  消息" → **本地时间** + 消息
 *      （🔴 老坑：直接切片 ISO 串拿到的是 UTC，用户"十点在睡觉却有九点记录"——必须 astimezone）
 *   ② translate：把原始消息翻成大白话（总览页用）；翻不出的原样返回并标 info
 * ============================================================================
 */

/** @returns {{t:string, msg:string}} t 是本地时间 HH:MM:SS */
export function parseLine(ln) {
  const m = /^(\S+)\s+(.*)$/.exec(String(ln || ''))
  if (m && /^\d{4}-\d{2}-\d{2}T/.test(m[1])) {
    let t = m[1].slice(11, 19)
    try {
      const dt = new Date(m[1].replace('Z', '+00:00'))
      if (!Number.isNaN(dt.getTime())) {
        // 固定按北京时间（UTC+8）显示：手机/容器时区常是 UTC，跟着设备时区会差 8 小时（2026-10-30 修）
        t = new Date(dt.getTime() + 8 * 3600000).toISOString().slice(11, 19)
      }
    } catch { /* 保持切片结果 */ }
    return { t, msg: m[2] }
  }
  return { t: '', msg: String(ln || '') }
}

/** 原始日志行的等级（专业日志页三色用） */
export function levelOf(msg) {
  const s = String(msg || '')
  const low = s.toLowerCase()
  // ① 「缺配置被挡住」不是故障：轮次没跑（ran:false）且原因是没关键词/没登录/安全模式等 → 警告
  //    （以前这条会因为有 "errors":[] 被判成 ERROR，红字吓人，2026-10-31 修）
  if (/"ran"\s*:\s*false/.test(s) && /还没设关键词|还没登录|安全模式|额度|谷时|未登录/.test(s)) return 'WARN'
  // ② JSON 结果里的 "errors":[] 是空数组，不代表出错；只有非空才算
  const realJsonErr = /"errors"\s*:\s*\[[^\]]/.test(s)
  if (low.includes('no_adapter') || s.includes('失败') || s.includes('错误') || s.includes('异常')
      || realJsonErr || /code=[1-9]/.test(s)) return 'ERROR'
  // ③ 纯文本里出现 error，但只是 "errors":[] 这种字段名 → 不算错
  if (low.includes('error') && !/"errors"\s*:\s*\[\s*\]/.test(s)) return 'ERROR'
  if (low.includes('warn') || s.includes('超时') || s.includes('重试') || s.includes('跳过')) return 'WARN'
  return 'INFO'
}

/**
 * 大白话翻译。返回 [图标, 人话, 级别]；级别 ∈ info/ok/warn/err/run。
 * 翻不出来 → 原样 + info（专业日志页有全文，这里不装懂）。
 */
export function translate(msg) {
  const low = String(msg || '').toLowerCase()
  if (low.includes('no_adapter')) return ['⚠️', 'AI 起不来：模型没配对，本轮失败', 'err']
  if (low.includes('刷b站开跑') || low.includes('开跑')) return ['▶️', '开始新一轮，AI 上场挑视频', 'run']
  if (low.includes('刷b站结束') || low.includes('结束')) {
    return /code=0/.test(msg) ? ['✅', '这一轮顺利结束', 'ok'] : ['❌', '这一轮没成功（退出码非 0）', 'err']
  }
  if (msg.includes('登录成功')) return ['🔑', 'B站 登录成功', 'ok']
  if (msg.includes('出码') || low.includes('qrcode')) return ['📱', '弹出登录二维码，等你用手机扫', 'info']
  if (msg.includes('装依赖结束')) {
    const ok = msg.includes('venvready=true')
    return ['🛠️', ok ? '运行环境装好了' : '环境安装好像有问题', ok ? 'ok' : 'warn']
  }
  if (msg.includes('已挂载')) return ['🧩', '插件已就绪并挂载', 'ok']
  if (msg.includes('已铺好值班章程')) return ['📜', '铺好值班章程', 'info']
  if (msg.includes('已铺好')) return ['📄', '铺好脚本文件', 'info']
  if (msg.includes('私信监听') || msg.includes('私信监察')) {
    if (msg.includes('还不知道回给谁') || msg.includes('没填')) {
      return ['💬', '私信监察转了一圈：还没配「私信发给谁」，现在只是看看、不动', 'warn']
    }
    return ['💬', '私信监察：发现有新私信', 'info']
  }
  if (msg.includes('评论复核开始')) return ['🔍', '开始检查之前发过的评论', 'info']
  if (msg.includes('评论复核结束')) return ['🔍', '评论复核完成', 'info']
  if (msg.includes('风控') || msg.includes('验证码') || msg.includes('限流')) {
    return ['🛑', '撞上风控了：按规则冷却/收工，不硬顶', 'warn']
  }
  if (msg.includes('判重')) return ['📒', '更新判重表：看过的视频不再重复打扰', 'info']
  return ['•', msg, 'info']
}

/** 取日志尾部 n 行（按字符数粗截，避免整读大文件） */
export function tailLines(text, n = 200, maxChars = 400000) {
  const s = String(text || '')
  const cut = s.length > maxChars ? s.slice(s.length - maxChars) : s
  const lines = cut.split(/\r?\n/).filter(Boolean)
  return lines.slice(Math.max(0, lines.length - n))
}
