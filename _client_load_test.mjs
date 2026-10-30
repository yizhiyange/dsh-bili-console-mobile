/**
 * _client_load_test.mjs —— 虚拟环境加载测试（不扫码、不连 B站）
 * 目的：在登记进 DSH bundles 之前，证明 client.js 能被 DSH 的 client 加载框架
 *       （window.__ModuleLoader__.load + React + slots.inject）正常加载并注册出
 *       「刷视频」设置栏，且 Panel 初次渲染不抛错 —— 即登记后不会崩 DSH 界面。
 * 用法：node _client_load_test.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, 'client.js'), 'utf8')

let pass = 0, fail = 0
const ok = (cond, msg) => { if (cond) { pass++; console.log('  PASS  ' + msg) } else { fail++; console.log('  FAIL  ' + msg) } }

// ---- mock DSH client 加载框架 ----
const registered = []
const slots = {
  inject: (name, fn) => { registered.push({ kind: 'inject', slot: name, fn }); return { dispose() {} } },
  register: (desc, comp) => { registered.push({ kind: 'register', desc, comp }); return comp },
}
const styleEl = { setAttribute() {}, appendChild() {}, remove() {}, textContent: '' }
let effectCount = 0
const ctx = {
  get: (k) => (k === 'slots' ? slots : undefined),
  slots,
  effect: (fn, name) => { effectCount++; return () => { try { fn() } catch {} } },
  logger: () => {},
}
const document = {
  createElement: () => styleEl,
  head: { appendChild() {} },
}
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (init) => [init, () => {}],
  useEffect: () => {},
  useRef: (init) => ({ current: init }),
}
const reqShim = (name) => { if (name === 'react') return fakeReact; throw new Error('unexpected require: ' + name) }
let captured = null
const window = { __ModuleLoader__: { load: (def) => { captured = def } } }
const sandbox = {
  window, document, require: reqShim, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  navigator: { clipboard: { writeText: async () => {} } },
}

console.log('\n[1] client.js 语法/格式加载')
let loadErr = null
try {
  vm.createContext(sandbox)
  vm.runInContext(src, sandbox, { filename: 'client.js' })
} catch (e) { loadErr = e }
ok(!loadErr, 'client.js 能被加载框架 eval 不抛错' + (loadErr ? '：' + loadErr.message : ''))
ok(captured && typeof captured.factory === 'function', '调用了 window.__ModuleLoader__.load({id, factory})')

console.log('\n[2] factory 执行（拿到 {inject, apply}）')
let mod = null, facErr = null
try { mod = captured && captured.factory(reqShim) } catch (e) { facErr = e }
ok(!facErr, 'factory(require) 不抛错' + (facErr ? '：' + facErr.message : ''))
ok(captured && captured.id === 'dsh-bili-console', `id 是 dsh-bili-console（实际 ${captured && captured.id}）`)
ok(mod && Array.isArray(mod.inject) && mod.inject.includes('slots'), `inject 含 'slots'（实际 ${JSON.stringify(mod && mod.inject)}）`)
ok(typeof mod.apply === 'function', '导出 apply(ctx)')

console.log('\n[3] apply(ctx)：注册设置栏 + 注入样式')
let applyErr = null
try { mod.apply(ctx) } catch (e) { applyErr = e }
ok(!applyErr, 'apply(ctx) 不抛错' + (applyErr ? '：' + applyErr.message : ''))
ok(registered.some((r) => r.kind === 'inject' && r.slot === 'settings.section'), "slots.inject('settings.section', …) 被调用")
// 触发 inject 回调，拿到 register 的描述
let secDesc = null
const sec = registered.find((r) => r.kind === 'inject' && r.slot === 'settings.section')
if (sec) { try { sec.fn() } catch (e) { console.log('    (settings.section 回调抛错：' + e.message + ')') } }
const reg = registered.find((r) => r.kind === 'register' && r.desc && r.desc.name === 'settings.section')
if (reg) secDesc = reg.desc
ok(secDesc && secDesc.label === '刷视频', `设置栏 label 是「刷视频」（实际 ${secDesc && secDesc.label}）`)
ok(secDesc && secDesc.id === 'bili-console', `section id 是 bili-console（实际 ${secDesc && secDesc.id}）`)
ok(styleEl.textContent.length > 500, '注入了大段 CSS（' + styleEl.textContent.length + ' 字符）')
ok(effectCount >= 1, '注册了 ctx.effect 清理器（样式卸载）')

console.log('\n[4] Panel 初次渲染（st=null 时应显示“读设置中…”且不抛错）')
let panelTree = null, panelErr = null
if (reg && typeof reg.comp === 'function') {
  try { const el = reg.comp(); if (el && typeof el.type === 'function') panelTree = el.type() } catch (e) { panelErr = e }
}
ok(!panelErr, 'Panel 初次渲染不抛错' + (panelErr ? '：' + panelErr.stack || panelErr.message : ''))

console.log(`\n===== 结果：${pass} 通过 / ${fail} 失败 =====`)
process.exitCode = fail ? 1 : 0
