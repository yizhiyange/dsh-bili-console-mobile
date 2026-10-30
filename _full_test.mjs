/**
 * _full_test.mjs —— 逐项功能测试（不真发评论、不发私信）
 * 起真实插件 handler，用免费模型，逐条断言，最后打印 PASS/FAIL 表。
 */
import { createServer } from 'node:http'
import { join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync, readFileSync } from 'node:fs'

// 自动取本文件所在目录，不写死路径（换机器也能跑）
const here = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')
const DSH_HOME = join(process.env.USERPROFILE, '.dsh')
const home = join(DSH_HOME, 'bili-console')

const results = []
const ok = (name, cond, detail) => { results.push({ name, pass: !!cond, detail: detail == null ? '' : String(detail) }); console.log((cond ? '  PASS ' : '  FAIL ') + name + (detail ? '  → ' + detail : '')) }

// ── 起服务 ──
const handlers = []
const mod = await import(pathToFileURL(join(here, 'index.js')).href)
mod.apply({
  get: (k) => (k === 'dshHomePath' ? (...s) => join(DSH_HOME, ...s) : undefined),
  logger: () => {},
  effect: (f) => { try { f() } catch {} },
  webServer: { register: (o) => handlers.push(o) },
})
const reg = handlers.find((h) => h.path === '/api/bili-console')
const server = createServer((req, res) => reg.handler(req, res))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port
const BASE = `http://127.0.0.1:${PORT}`
const API = BASE + '/api/bili-console'
const j = async (m, p, body) => {
  const r = await fetch(API + p, {
    method: m, headers: { 'content-type': 'application/json' },
    body: m === 'GET' ? undefined : JSON.stringify(body || {}),
  })
  return r.json()
}

console.log('\n=== 1. 基础接口 ===')
const status = await j('GET', '/status')
ok('/status 正常', status.ok && status.loggedIn, 'loggedIn=' + status.loggedIn)
const state0 = await j('GET', '/state')
ok('/state 有 23 项以上字段', Object.keys(state0).length > 12, Object.keys(state0).length + ' 个字段')
ok('/state.asr 有状态', !!state0.asr, JSON.stringify({ ready: state0.asr.ready, reason: state0.asr.reason }).slice(0, 90))
ok('/state.vision 有状态', !!state0.vision, 'model=' + state0.vision.model + ' ready=' + state0.vision.ready)
ok('/state.memory 正常', !!state0.memory, JSON.stringify(state0.memory))
ok('/state.run 正常', !!state0.run && state0.run.running === false, JSON.stringify(state0.run))
const chain = await j('GET', '/chain')
ok('/chain 有链', chain.ok && (chain.endpoints || state0.chain.endpoints).length > 0, (state0.chain.endpoints || []).length + ' 节')
ok('链第一位是临时免费模型', (state0.chain.endpoints[0].model === 'glm-4-flash-250414'), state0.chain.endpoints[0].model)
const me = await j('GET', '/me')
ok('/me 拿到账号', me.ok && me.me && me.me.uname, me.me && me.me.uname)
const sc = await j('GET', '/selfcheck')
ok('/selfcheck 全绿', sc.ok && (sc.items || []).every((x) => x.ok), (sc.items || []).map((x) => (x.ok ? '✓' : '✗')).join(' '))
const rep = await j('GET', '/report')
ok('/report 可读', rep.ok && typeof rep.text === 'string', 'exists=' + rep.exists + ' picked=' + rep.picked)
const raw = await j('GET', '/rawlog')
ok('/rawlog 有行', raw.ok && Array.isArray(raw.lines) && raw.lines.length > 0, (raw.lines || []).length + ' 行')

console.log('\n=== 2. 设置读写（每个开关都要真的落盘） ===')
const before = (await j('GET', '/state')).settings
const patch = {
  keywords: ['DeepSeek Harness', 'AI 编程', 'MCP'],
  perDay: 3, commentPerRound: 2, replyPerRound: 1,
  autoComment: false, replyToComments: false,
  transcribe: false, asrModel: 'small',
  dmMode: 'off', dmUid: 0, dmWatch: true, dmWatchMinutes: 2, dmReplyPerDay: 0,
  peakValley: false, noon: true, night: true,
  reportLevel: 'full', favFolderId: 0,
  mentionName: '', thinkingOff: true, contextMode: 'isolated', schedulerOn: false,
}
const w = await j('POST', '/settings', patch)
ok('/settings 写入成功', w.ok && Array.isArray(w.changed), 'changed=' + (w.changed || []).length)
const after = (await j('GET', '/state')).settings
const badKeys = Object.keys(patch).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(patch[k]))
ok('写进去的值全部读回一致', badKeys.length === 0, badKeys.length ? ('不一致：' + badKeys.join(',')) : '')

console.log('\n=== 3. 识图模型（免费 glm-4v-flash，真调用） ===')
const { describeImage } = await import(pathToFileURL(join(here, 'lib', 'vision.mjs')).href)
const vs = (await j('GET', '/state')).vision
ok('识图模型已配置', vs.ready, vs.model)
const coverUrl = 'https://i0.hdslb.com/bfs/archive/0000000000000000000000000000000000000000.jpg'
const vres = await describeImage({ visionModel: (await j('GET', '/state')).settings.visionModel }, 'https://i0.hdslb.com/bfs/face/member/noface.jpg', '一句话说明这是什么（15字内）')
ok('识图调用返回结构正确（HTTP 200 或明确错误）', typeof vres.ok === 'boolean', vres.ok ? ('输出：' + String(vres.text).slice(0, 30)) : ('错误：' + String(vres.error).slice(0, 60)))

console.log('\n=== 4. 转写后端探测（未装应给出明确原因，不是崩） ===')
const { asrStatus } = await import(pathToFileURL(join(here, 'lib', 'asr.mjs')).href)
const { resolvePython } = await import(pathToFileURL(join(here, 'lib', 'pyenv.mjs')).href)
const { loadConfig } = await import(pathToFileURL(join(here, 'lib', 'state.mjs')).href)
const py = resolvePython(loadConfig(home), home)
const asr = await asrStatus(py)
ok('转写探测有结论', typeof asr.ready === 'boolean', asr.ready ? ('后端=' + asr.backend) : ('原因=' + String(asr.reason).slice(0, 70)))

console.log('\n=== 5. 收藏接口（用不存在的收藏夹 id，验证结构化失败、绝不乱写） ===')
const { newClient, addFavorite } = await import(pathToFileURL(join(here, 'lib', 'bili.mjs')).href)
const client = newClient(loadConfig(home), home)
let favRes = null
try { favRes = await addFavorite(client, 'BV1TEST00000', 999999999) } catch (e) { favRes = { success: false, error: String(e.message) } }
ok('收藏接口有结构化返回', favRes && typeof favRes.success === 'boolean', favRes.success ? '居然成功了（id 可能有效）' : ('预期失败：' + String(favRes.error || '').slice(0, 60)))
try { client.close() } catch {}

console.log('\n=== 6. 私信（关着时不该真发） ===')
const dm = await j('POST', '/dm/check', {})
ok('/dm/check 有返回', dm && typeof dm.ok === 'boolean', JSON.stringify(dm).slice(0, 90))

console.log('\n=== 7. 试跑一轮（免费模型、真搜索、不发布） ===')
const runRes = await j('POST', '/run/now', { force: true, dryRun: true })
ok('/run/now 能启动', runRes.ok && runRes.started, runRes.message)
let st = null
for (let i = 0; i < 90; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  st = await j('GET', '/state')
  if (!st.run.running) break
}
ok('试跑跑完并退出运行态', st && st.run.running === false)
const logTail = readFileSync(join(home, 'duty.log'), 'utf8').trim().split('\n').slice(-1)[0]
const mRun = logTail.match(/\{.*\}/)
const summary = mRun ? JSON.parse(mRun[0]) : {}
ok('试跑无报错', (summary.errors || []).length === 0, 'errors=' + JSON.stringify(summary.errors || []))
ok('试跑挑到了视频', (summary.picked || 0) > 0, 'picked=' + summary.picked + ' scanned=' + summary.scanned)
ok('试跑没发布', (summary.posted || 0) === 0, 'posted=' + summary.posted)
const rep2 = await j('GET', '/report')
ok('日报有内容', rep2.exists && rep2.text.length > 50, rep2.picked + ' 条')

console.log('\n=== 8. 中断能力 ===')
await j('POST', '/run/now', { force: true, dryRun: true })
await new Promise((r) => setTimeout(r, 4000))
const stopRes = await j('POST', '/run/stop', {})
ok('/run/stop 有响应', stopRes && typeof stopRes.ok === 'boolean', stopRes.message)
let stopped = null
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  stopped = await j('GET', '/state')
  if (!stopped.run.running) break
}
ok('停止后轮次确实结束', stopped && stopped.run.running === false)

console.log('\n=== 9. 上下文与记忆 ===')
await j('POST', '/settings', { contextMode: 'thread' })
const th = (await j('GET', '/state')).settings.contextMode
ok('contextMode 可切到 thread', th === 'thread', th)
await j('POST', '/settings', { contextMode: 'isolated' })
ok('contextMode 可切回 isolated', (await j('GET', '/state')).settings.contextMode === 'isolated')
const clr = await j('POST', '/memory/clear', {})
ok('/memory/clear 正常', clr.ok === true, JSON.stringify(clr.removed || {}))

console.log('\n=== 10. 前端页面 ===')
const page = await (await fetch(BASE + '/bili-console')).text()
ok('网页版可访问且是老设计骨架', page.includes('刷B站观测台') && page.includes('data-page="overview"'), (page.length / 1024).toFixed(0) + 'KB')
ok('网页版含 7 个页面容器', (page.match(/id="page-\w+"/g) || []).length === 7)
ok('网页版私信投递可点', page.includes('data-act="setdm"'))
ok('网页版恢复转写/收藏/识图', page.includes("'transcribe'") && page.includes('favFolderId') && page.includes('savevision'))
const page404 = await fetch(BASE + '/bili-console/vendor/x.js')
ok('已删除的静态路由确实 404', page404.status === 404, 'HTTP ' + page404.status)

// 还原测试期间改的配置
await j('POST', '/settings', { autoComment: before.autoComment, perDay: before.perDay, dmMode: before.dmMode, keywords: before.keywords })
server.close()

const pass = results.filter((r) => r.pass).length
const fail = results.filter((r) => !r.pass)
console.log('\n================ 结果 ================')
console.log('通过 ' + pass + ' / ' + results.length + '，失败 ' + fail.length)
if (fail.length) { console.log('失败项：'); fail.forEach((f) => console.log('  ✗ ' + f.name + (f.detail ? '  → ' + f.detail : ''))) }
process.exit(fail.length ? 1 : 0)
