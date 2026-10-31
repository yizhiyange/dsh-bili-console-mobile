/**
 * lib/assistant.mjs —— 「助手」会话（2026-11-1 加）
 * ============================================================================
 * 用户要的不是"把小结投进聊天框"，而是**一个能真的帮他操作插件的对话**：
 * 说一句"把思考强度都调到低"、"试跑一轮"、"把视频都删掉"，它就去点按钮。
 *
 * 做法：不让模型直接跑代码，而是让它输出**结构化动作**，由插件白名单执行。
 *   模型只回一个 JSON：{"say": "要说的话", "actions": [{"tool": "工具名", "args": {...}}]}
 *   好处：① 模型不支持 function-calling 也能用；② 动作受白名单限制，删不了配置；
 *        ③ 每个动作都有返回值，能如实反馈给用户。
 */
export const TOOL_HELP = `
可用工具（tool 只能填这些，其他一律无效）：
1. getSettings()                     读当前设置摘要（模型链、上限、开关状态）
2. setSetting({key, value})          改一项设置。key 只能是：perDay, commentPerRound, autoComment, dmMode,
                                     replyToComments, useHomeFeed, useKeywordSearch, keywords(string[]),
                                     videoVoice, videoVoiceName, videoVoiceRate, videoVoicePitch,
                                     videoLayout, videoCogVideo, videoCogVideoMode, videoImageEnabled,
                                     thinkLevel, mentionName, mentionMode, lowPower, useAssets,
                                     autoLike, autoCoin, transcribe, dshSession
3. setModelStrength({model, level})  给某个模型单独设思考强度。level: off|low|medium|high（'' 表跟随全局）
4. resetQuota()                      把今天已用额度清零（不想改上限想重来的时候用）
5. analyzeAssets()                   本地识别音乐素材，自动写 BGM 备注（免费、不联网）
6. autoNoteAssets()                  AI 看图给图片素材写备注（要有识图模型）
7. clearVideos()                     删掉所有已生成的视频（省手机空间）
8. runRound({mode})                  mode=dry 只挑不发（安全）；mode=real 会真发评论（需用户确认）
9. generateVideo({topic})            生成一条短视频。topic 可空
`.trim()

export function buildSystemPrompt(stateBrief = '') {
  return [
    '你是「刷B站插件」的操作助手，用户用大白话提要求，你负责把它翻成具体动作。',
    '风格：像同事说话，短句，别写"好的，我将为您…"这种客套。',
    '',
    TOOL_HELP,
    '',
    '输出格式（必须严格遵守，只输出一个 JSON，不要代码块不要解释）：',
    '{"say":"给用户看的一两句话","actions":[{"tool":"工具名","args":{}}]}',
    '',
    '规则：',
    '· 用户只是聊天/问问题时，actions 填空数组 []。',
    '· 一次可以给多个动作，会按顺序执行。',
    '· 不确定他要改哪个设置就先问，别瞎改。',
    '· 涉及"真发评论"（runRound mode=real）一定要先在 say 里说明并等用户确认，不要自己直接跑。',
    '· 改完设置后简单说改成了什么，别复述一大串。',
    stateBrief ? ('\n当前状态摘要（供你判断，不用原样念给用户）：\n' + stateBrief) : '',
  ].filter(Boolean).join('\n')
}

/** 从模型回复里抠出 JSON（容忍 ```json 包裹、前后废话） */
export function parseAssistant(text) {
  const raw = String(text || '').trim()
  let body = raw
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) body = fence[1].trim()
  else {
    const i = raw.indexOf('{')
    const j = raw.lastIndexOf('}')
    if (i >= 0 && j > i) body = raw.slice(i, j + 1)
  }
  try {
    const o = JSON.parse(body)
    const actions = Array.isArray(o.actions) ? o.actions.filter((a) => a && typeof a.tool === 'string') : []
    return { say: String(o.say || '').trim(), actions }
  } catch {
    return { say: raw.slice(0, 500), actions: [] }   // 模型没按格式来，就当普通回答
  }
}
