/**
 * selfcheck.mjs —— 核心模块自测（不需要 DSH，node selfcheck.mjs 直接跑）
 * 覆盖：persona / guardian / logread / state 四个纯模块 + index.js 路由全链路（mock ctx）
 */
import { rmSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

let pass = 0, fail = 0
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.log(`  ✗ ${name}`) } }
const eq = (a, b, name) => ok(JSON.stringify(a) === JSON.stringify(b), `${name}（得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

const { resolvePersona, looksLikePath } = await import('./lib/persona.mjs')
const { classify, decide, Cooldown, CODES } = await import('./lib/guardian.mjs')
const { parseLine, levelOf, translate, tailLines } = await import('./lib/logread.mjs')
const stateLib = await import('./lib/state.mjs')
const { loadConfig, saveConfig, parseSeen, readReport, dayKey, inWindow, normalize, CONFIG_DEFAULTS } = stateLib

console.log('\n— 人设解析 —')
{
  const r = resolvePersona('角色卡：抽象小鲸鱼\n一、你是谁')
  ok(r.from === 'inline' && r.text.includes('抽象小鲸鱼'), '文本框直填：全文生效')
  eq(resolvePersona('').from, 'empty', '空人设 → 中性语气')
  const long = 'x'.repeat(9000)
  eq(resolvePersona(long).truncated, true, '超 8000 字会截断并标注')
  ok(looksLikePath('C:\\a\\AGENTS.md') && looksLikePath('~/x.md') && !looksLikePath('你好啊'), '路径识别')
  const p = resolvePersona(join(process.cwd(), 'AGENTS.md'))
  ok(p.from === 'file' && p.text.length > 0, '填 AGENTS.md 路径 → 去读文件')
  const bad = resolvePersona('C:\\不存在的目录\\AGENTS.md')
  ok(bad.from === 'inline-fallback' && bad.note.includes('读不到'), '路径读不到 → 退回文本框并说明')
}

console.log('\n— 风控规则库 —')
{
  eq(classify('返回码 12045 需要验证码').label, '触发验证码（12045）', '识别验证码码 12045')
  eq(classify('code=-412 被风控').action, 'cooldown', '识别 -412 → 冷却')
  eq(classify('HTTP 429 Too Many Requests').action, 'cooldown', '识别 429 → 冷却')
  eq(classify('今日互动已达上限 12008').action, 'stop-day', '识别 12008 → 今天收工')
  eq(classify('操作太频繁 12002').action, 'stop-round', '识别 12002 → 本轮停')
  eq(classify('一切正常'), null, '正常日志不误判')
  const d = decide('撞上 429 了', { cooldownMinutes: 1440 })
  ok(d.action === 'cooldown' && d.minutes === 1440 && d.until > Date.now(), '默认冷却 24 小时')
  eq(decide('429', { cooldownMinutes: 5 }).minutes, 10, '冷却时长有下限 10 分钟（防手滑设成 0）')
  const home = join(tmpdir(), 'bili-console-selfcheck')
  rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true })
  const cd = new Cooldown(home)
  eq(cd.active(), false, '初始不在冷却')
  cd.engage(decide('429', {}))
  ok(cd.active() && cd.remaining() > 0, '命中后进入冷却')
  const cd2 = new Cooldown(home)
  ok(cd2.active(), '冷却落盘：重启（新实例）仍然生效')
  cd2.clear()
  ok(!cd2.active(), '可手动解除冷却')
  rmSync(home, { recursive: true, force: true })
}

console.log('\n— 日志翻译 —')
{
  const { t } = parseLine('2026-10-25T07:24:36.064Z  私信监听：aaa')
  ok(/^\d{2}:\d{2}:\d{2}$/.test(t), '解析出时间串')
  const now = new Date()
  const utc = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(11, 19)
  eq(parseLine(`${new Date().toISOString()}  x`).t, utc, '时间是本地时间（不再是 UTC 直切）')
  eq(levelOf('xxx code=1 失败'), 'ERROR', 'ERROR 识别')
  eq(levelOf('本地转写超时，重试'), 'WARN', 'WARN 识别')
  eq(levelOf('第 37 轮开始'), 'INFO', 'INFO 识别')
  eq(translate('私信监听：还不知道回给谁')[1], '私信监察转了一圈：还没配「私信发给谁」，现在只是看看、不动', '私信监察说人话')
  ok(translate('NO_ADAPTER')[2] === 'err', 'NO_ADAPTER → 错误级')
  eq(tailLines('a\nb\nc\n', 2), ['b', 'c'], 'tailLines 取尾 N 行')
}

console.log('\n— 配置与状态 —')
{
  const home = join(tmpdir(), 'bili-console-selfcheck-2')
  rmSync(home, { recursive: true, force: true }); mkdirSync(home, { recursive: true })
  const cfg0 = loadConfig(home)
  eq(cfg0.perDay, 10, '默认每天 10 条')
  eq(cfg0.dmWatch, true, '默认开着私信监察')
  eq(cfg0.cooldownMinutes, 1440, '默认冷却 24 小时')
  const changed = saveConfig(home, { perDay: 7, autoComment: true, dmMode: 'bogus', reportLevel: 'x' })
  ok(changed.includes('perDay') && changed.includes('autoComment'), '改动被记录')
  const cfg1 = loadConfig(home)
  eq(cfg1.perDay, 7, '写入生效')
  eq(cfg1.autoComment, true, '布尔写入')
  eq(cfg1.dmMode, 'off', '非法枚举被收敛成 off')
  eq(cfg1.reportLevel, 'full', '非法报告级别被收敛成 full')
  eq(saveConfig(home, { perDay: 7 }), [], '值没变不算改动')
  eq(normalize('perDay', 'abc'), 0, '数字字段防呆')
  eq(normalize('keywords', 'not-array'), [], '数组字段防呆')
  const seen = parseSeen('- [x] BV1aaa 标题\n- [x] rpid: 12345 评论\n- [x] BV1bbb 标题\n')
  eq(seen, { videos: 2, comments: 1 }, '判重表统计')
  mkdirSync(join(home, 'out'), { recursive: true })
  writeFileSync(join(home, 'out', `${dayKey()}.md`), '### BV1xxx\n标题\n**档位：值得看**\n')
  const rep = readReport(home, dayKey())
  eq(rep.picked, 1, '日报挑中数（### BV 行）')
  eq(dayKey(new Date(2026, 9, 25, 0, 30)).length, 10, '本地日期键')
  eq(inWindow({ noon: true, night: false }, new Date(2026, 9, 25, 12, 30)), 'noon', '午间谷时判断')
  eq(inWindow({ noon: false, night: false }, new Date(2026, 9, 25, 12, 30)), '', '窗口都关 → 不在谷时')
  rmSync(home, { recursive: true, force: true })
}

console.log('\n— 路由全链路（mock ctx，不依赖 DSH）—')
{
  const { apply } = await import('./index.js')
  const home = join(tmpdir(), 'bili-console-selfcheck-3', 'bili-console')
  rmSync(join(tmpdir(), 'bili-console-selfcheck-3'), { recursive: true, force: true })
  const specs = []
  const ctx = {
    get: (k) => (k === 'dshHomePath' ? (...segs) => join(tmpdir(), 'bili-console-selfcheck-3', ...segs) : undefined),
    logger: () => {},
    webServer: { register: (spec) => { specs.push(spec); return () => {} } },
    effect: (fn) => { try { fn() } catch (e) { console.log('  effect 抛错:', e.message) } },
  }
  apply(ctx, {})
  ok(specs.some((s) => s.path === '/api/bili-console'), 'API 路由挂上了')
  ok(specs.some((s) => s.path === '/bili-console'), '页面路由挂上了')
  const api = specs.find((s) => s.path === '/api/bili-console')

  const call = (method, path, body) => new Promise((resolve) => {
    const req = {
      method, url: path,
      on(ev, cb) { if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body))); if (ev === 'end') cb() },
      destroy() {},
    }
    let code = 0, out = ''
    const res = { writeHead(c) { code = c }, end(b) { out = b || ''; try { resolve({ code, json: JSON.parse(out) }) } catch { resolve({ code, raw: out }) } } }
    api.handler(req, res)
  })

  let r = await call('GET', '/api/bili-console/state')
  eq(r.code, 200, 'GET /state → 200')
  ok(r.json.ok && r.json.settings.perDay === 10, 'state 里有配置（默认值）')
  eq(r.json.safeMode, true, '默认安全模式（不自动发）')
  ok(Array.isArray(r.json.activity) && r.json.activity.length > 0, '启动写了日志，动态里有东西')
  eq(r.json.status.phase, '值守中', '状态：值守中')

  r = await call('POST', '/api/bili-console/settings', { perDay: 7, autoComment: true, dmUid: 123 })
  ok(r.json.ok && r.json.changed.includes('perDay') && r.json.changed.includes('autoComment'), 'POST /settings 写入')
  r = await call('GET', '/api/bili-console/state')
  eq(r.json.settings.perDay, 7, '写入后读得到')
  eq(r.json.safeMode, false, '开了自动评论 → 退出安全模式')

  r = await call('POST', '/api/bili-console/persona', { personaPrompt: '角色卡：自检小鱼\n测试' })
  ok(r.json.ok, 'POST /persona 写入')
  r = await call('GET', '/api/bili-console/state')
  eq(r.json.persona.name, '自检小鱼', '人设名字解析')
  ok(r.json.persona.text.includes('自检小鱼'), '人设全文在 state 里')

  r = await call('POST', '/api/bili-console/settings', { perDay: 'abc' })
  eq(r.json.ok, true, '防呆：垃圾输入不 500')
  r = await call('GET', '/api/bili-console/state')
  eq(r.json.settings.perDay, 0, '防呆：垃圾输入被收敛成 0')

  r = await call('GET', '/api/bili-console/rawlog')
  ok(r.json.ok && r.json.lines.length > 0 && r.json.lines[0].lv, 'GET /rawlog 有行有等级')

  r = await call('GET', '/api/bili-console/bogus')
  eq(r.code, 404, '未知路径 → 404')

  const page = specs.find((s) => s.path === '/bili-console')
  const html = await new Promise((resolve) => {
    const res = { writeHead() {}, end(b) { resolve(String(b)) } }
    page.handler({ method: 'GET', url: '/bili-console', on() {} }, res)
  })
  ok(html.includes('刷B站观测台'), '页面路由吐出 console.html')

  rmSync(join(tmpdir(), 'bili-console-selfcheck-3'), { recursive: true, force: true })
}

console.log('\n— Phase 2：降级链 / LLM / 值守引擎（纯逻辑，不联网）—')
{
  const { buildEndpoints, isQuotaError, applyDefaultModelToDsh } = await import('./lib/chain.mjs')
  const { chat } = await import('./lib/llm.mjs')
  const { runRound } = await import('./lib/round.mjs')

  // 降级链：自定义模型按 chainOrder 排序；DSH 预设只取带密钥的
  const cfg = {
    models: [
      { id: 'm1', provider: 'deepseek', displayName: 'DS', apiUrl: 'https://a', modelName: 'm-a', apiKeySource: 'custom', customKey: 'sk-x', addToChain: true },
      { id: 'm2', provider: 'glm', displayName: 'GLM', apiUrl: 'https://b', modelName: 'm-b', apiKeySource: 'custom', customKey: 'sk-y', addToChain: true },
      { id: 'm3', provider: 'qwen', displayName: 'Q', apiUrl: 'https://c', modelName: 'm-c', apiKeySource: 'custom', customKey: '', addToChain: false },
    ],
    chainOrder: ['m2', 'm1'],
  }
  const host = [
    { provider: 'dsh-1', label: 'DSH主', apiUrl: 'https://d', apiKey: 'sk-d', modelName: 'm-d', hasKey: true },
    { provider: 'dsh-2', label: 'DSH无key', apiUrl: 'https://e', apiKey: '', modelName: 'm-e', hasKey: false },
  ]
  const ep = buildEndpoints(cfg, host)
  eq(ep.map((e) => e.id), ['m2', 'm1'], '手动排序后严格按 chainOrder：未排入的预设不再自动追加（防链暴涨，2026-10-29 改）')
  ok(!ep.some((e) => e.source === 'preset'), '手动排序后预设不自动进链')
  ok(!ep.some((e) => e.id === 'm3'), '没勾"加进链"的模型不进链')
  const ep2 = buildEndpoints({ models: cfg.models }, host)
  eq(ep2.find((e) => e.id === 'preset:dsh-1:m-d').apiKey, 'sk-d', '没手动排序时，带密钥预设进链且密钥被采纳')
  ok(!ep2.some((e) => e.id === 'preset:dsh-2:m-e'), '没密钥的预设不进链')

  ok(isQuotaError('HTTP 429 Too Many Requests'), '429 命中配额信号')
  ok(isQuotaError('NO_ADAPTER 没有适配器'), 'NO_ADAPTER 命中')
  ok(!isQuotaError('视频发布成功'), '正常文案不误判为配额错')

  // LLM：链上空 → ok:false 且不抛
  const empty = await chat([], { system: 'x', user: 'y' })
  ok(empty.ok === false && /没有可调用模型/.test(empty.lastError || ''), '空链 → 安全失败')
  // LLM：链上端点不可达 → 全部试完仍 ok:false（不抛）
  const unreach = await chat([{ id: 'z', label: 'Z', baseUrl: 'http://127.0.0.1:1/nope', apiKey: '', model: 'm' }], { system: 'x', user: 'y' })
  ok(unreach.ok === false, '不可达端点 → 安全失败不抛异常')

  // 值守引擎：安全模式（默认配置）→ 不联网直接说明，ran:false
  const home = join(tmpdir(), 'bili-console-selfcheck-4', 'bili-console')
  rmSync(join(tmpdir(), 'bili-console-selfcheck-4'), { recursive: true, force: true })
  const s0 = await runRound({ home })
  ok(s0.ran === false && /安全模式/.test(s0.why || ''), '安全模式：不真发、不联网、给说明')

  // loginStatus 返回结构稳定（不依赖本机是否真登录）
  const { loginStatus } = await import('./lib/bili.mjs')
  ok(typeof loginStatus(home).loggedIn === 'boolean', 'loginStatus 返回布尔 loggedIn')

  // 值守引擎：开了评论但没关键词 → 说明（不联网）
  const cfgFile = join(home, 'config.json')
  mkdirSync(home, { recursive: true })
  writeFileSync(cfgFile, JSON.stringify({ autoComment: true, dmMode: 'off', keywords: [] }))
  // 假凭证字段齐全 → home 判定"已登录"；否则会回退读插件目录 vendor 里的真凭证（若开发机有），
  // 导致测试结果依赖本机登录态（打包副本没这个文件就翻车，2026-10-30 修）
  writeFileSync(join(home, 'bili_credential.json'), JSON.stringify({ sessdata: 'test-sessdata', bili_jct: 'test-jct', dedeuserid: '1' }))
  const s2 = await runRound({ home })
  ok(s2.ran === false && /关键词/.test(s2.why || ''), '没关键词：说明，不联网')

  rmSync(join(tmpdir(), 'bili-console-selfcheck-4'), { recursive: true, force: true })

  // DSH 默认模型补丁：尽力写，文件不存在也不抛
  const patch = applyDefaultModelToDsh('m1', 'm-a')
  ok(Array.isArray(patch.tried), 'applyDefaultModelToDsh 不抛，返回 tried 列表')
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail ? 1 : 0)
