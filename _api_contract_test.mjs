/**
 * _api_contract_test.mjs —— index.js 接口契约测试（不连 B站、不扫码）
 * 目的：登记前验证我们给「刷视频」栏补的接口，返回结构正是 client.js 期望的。
 * 做法：mock DSH 宿主 ctx（webServer.register 捕获路由 + dshHomePath 指向临时目录），
 *       调 apply(ctx) 挂路由，再用 mock req/res 逐个打接口核对返回字段。
 * 用法：node _api_contract_test.mjs
 */
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, rmSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const tmpHome = join(here, '_apitest_home')
try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* noop */ }

let pass = 0, fail = 0
const ok = (c, m) => { if (c) { pass++; console.log('  PASS  ' + m) } else { fail++; console.log('  FAIL  ' + m) } }

const handlers = []
const disposers = []
const ctx = {
  get: (k) => (k === 'dshHomePath' ? (...seg) => join(tmpHome, ...seg) : undefined),
  logger: () => {},
  effect: (setup, name) => { try { const d = setup(); if (typeof d === 'function') disposers.push(d) } catch (e) { console.log('  (effect ' + name + ' 抛错：' + e.message + ')') } },
  webServer: { register: (opt) => handlers.push(opt) },
}

console.log('[1] 加载 index.js 并 apply(ctx)')
const mod = await import(pathToFileURL(join(here, 'index.js')).href)
ok(typeof mod.apply === 'function', 'index.js 导出 apply')
ok(mod.name === 'bili-console', 'name = bili-console')
ok(Array.isArray(mod.inject) && mod.inject.includes('webServer'), 'inject 含 webServer')

let applyErr = null
try { mod.apply(ctx) } catch (e) { applyErr = e }
ok(!applyErr, 'apply(ctx) 不抛错' + (applyErr ? '：' + applyErr.message : ''))
const reg = handlers.find((h) => h.path === '/api/bili-console')
ok(reg && typeof reg.handler === 'function', '注册了 /api/bili-console 路由')

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : ''
    const req = {
      method, url: path,
      on(ev, cb) { if (ev === 'data' && bodyStr) process.nextTick(() => cb(bodyStr)); else if (ev === 'end') process.nextTick(cb) },
      destroy() {},
    }
    const res = { writeHead() {}, end(b) { resolve(b ? String(b) : '') } }
    Promise.resolve(reg.handler(req, res)).catch(reject)
  })
}
const j = async (method, path, body) => { const t = await call(method, path, body); try { return JSON.parse(t) } catch { return { _raw: t } } }

console.log('\n[2] 接口契约（client.js 期望的结构）')
const st = await j('GET', '/api/bili-console/status')
ok(st && st.ok === true, '/status → ok')
ok(st.config && typeof st.config.perDay === 'number', `/status.config.perDay 是数字（${st.config && st.config.perDay}）`)
ok(st.config && 'autoComment' in st.config && 'dmMode' in st.config && 'keywords' in st.config, '/status.config 含 autoComment/dmMode/keywords')
ok(st.windows && st.windows.noon && st.windows.noon.label, `/status.windows.noon.label 存在（${st.windows && st.windows.noon && st.windows.noon.label}）`)
ok(typeof st.loggedIn === 'boolean', '/status.loggedIn 是布尔')
ok(typeof st.version === 'string' && st.version.length > 0, '/status.version 非空')

const cfg1 = await j('GET', '/api/bili-console/config')
ok(cfg1 && cfg1.ok && cfg1.config, '/config GET → config')
const cfg2 = await j('POST', '/api/bili-console/config', { perDay: 3, autoComment: false })
ok(cfg2 && cfg2.ok && cfg2.config && cfg2.config.perDay === 3, '/config POST 写 perDay=3 并回读')
ok(existsSync(join(tmpHome, 'bili-console', 'config.json')), 'config.json 落盘到临时家目录')

const watched = await j('GET', '/api/bili-console/watched')
ok(watched && watched.ok && Array.isArray(watched.rows) && typeof watched.total === 'number', '/watched → rows[] + total')
const diag = await j('GET', '/api/bili-console/diagnose')
ok(diag && diag.ok && typeof diag.text === 'string' && diag.text.length > 10, '/diagnose → 文本')
const sc = await j('GET', '/api/bili-console/selfcheck')
ok(sc && sc.ok && Array.isArray(sc.items) && sc.items.length >= 3, '/selfcheck → 检查项[]')
const rep = await j('GET', '/api/bili-console/report')
ok(rep && rep.ok && typeof rep.exists === 'boolean' && typeof rep.text === 'string', '/report → exists + text')
const poll = await j('POST', '/api/bili-console/login/poll', {})
ok(poll && poll.ok && poll.state === 'waiting', '/login/poll（无会话）→ state=waiting')
const run = await j('POST', '/api/bili-console/run', {})
ok(run && run.ok && run.started === true, '/run → started=true')

// 上下文与记忆（默认 isolated，不留对话）
const st2 = await j('GET', '/api/bili-console/state')
ok(st2 && st2.memory && st2.memory.mode === 'isolated', '/state.memory.mode 默认 isolated')
ok(typeof st2.memory.count === 'number' && typeof st2.memory.turns === 'number', '/state.memory 含 count/turns')
ok(st2.settings && (st2.settings.contextMode === 'isolated' || st2.settings.contextMode === 'thread'), '/state.settings.contextMode 存在')
const idleStop = await j('POST', '/api/bili-console/run/stop', {})
ok(idleStop && idleStop.ok === true && idleStop.stopped === false, '/run/stop（空闲时）→ stopped:false，不报错')
const posted = await j('GET', '/api/bili-console/posted')
ok(posted && posted.ok === true && Array.isArray(posted.items) && typeof posted.count === 'number', '/posted → 账本可读（撤回要靠它）')
const retractDry = await j('POST', '/api/bili-console/retract', { count: 1, dryRun: true })
ok(retractDry && retractDry.ok === true && retractDry.started === true && retractDry.dryRun === true, '/retract 试跑 → 只检查不删')
const stPosted = await j('GET', '/api/bili-console/state')
ok(stPosted && stPosted.posted && typeof stPosted.posted.count === 'number', '/state.posted 存在（界面据此显示「撤回上一条」）')
const stRun = await j('GET', '/api/bili-console/state')
ok(stRun && stRun.run && typeof stRun.run.running === 'boolean', '/state.run.running 存在（界面据此显示「停止」）')
const clr = await j('POST', '/api/bili-console/memory/clear', {})
ok(clr && clr.ok === true, '/memory/clear → ok（可一键忘掉所有上下文）')

for (const d of disposers) { try { d() } catch { /* noop */ } }
console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exitCode = fail ? 1 : 0
