/**
 * _audit.mjs —— 死开关体检
 * 找出「配置里有、界面上能改、但逻辑里没人读」的开关。
 * 直接 import CONFIG_DEFAULTS 拿真值（不靠正则猜），再数 lib/*.mjs（不含 state.mjs）
 * 与 index.js 运行时代码（不含 zod 声明）里的引用次数。
 * 用法：node _audit.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { CONFIG_DEFAULTS } from './lib/state.mjs'

const keys = Object.keys(CONFIG_DEFAULTS)
const libSrc = readdirSync('lib')
  .filter((f) => f.endsWith('.mjs') && f !== 'state.mjs')
  .map((f) => readFileSync('lib/' + f, 'utf8')).join('\n')
// index.js 里去掉 zod 声明行，只看真正的运行时逻辑
const idxLogic = readFileSync('index.js', 'utf8').split('\n').filter((l) => !/z\.[a-z]+\(/.test(l)).join('\n')

// 本来就只是"只读展示"的，不算死
// 界面上还能不能看到这个开关（两个前端都查）
const uiSrc = readFileSync('client.js', 'utf8') + '\n' + readFileSync('web/console.html', 'utf8')

const DISPLAY_ONLY = new Set(['pythonPath', 'dshBin', 'headlessProfile', 'workspace', 'overlayMcp'])

const rows = keys.map((k) => {
  const re = new RegExp('\\b' + k + '\\b', 'g')
  const inLib = (libSrc.match(re) || []).length
  const inIdx = (idxLogic.match(re) || []).length
  // 只认"真的接了一个控件"：data-key / data-sel / saveOne('k' / save('k'
  const inUI = new RegExp('data-key="' + k + '"').test(uiSrc)
    || new RegExp('data-sel="' + k + '"').test(uiSrc)
    || new RegExp("saveOne\\('" + k + "'").test(uiSrc)
    || new RegExp("save\\('" + k + "'").test(uiSrc)
  let status = 'ok'
  if (DISPLAY_ONLY.has(k)) status = 'display'
  else if ((inLib + inIdx) === 0) status = inUI ? 'DEAD' : 'orphan'
  return { k, inLib, inIdx, inUI, status }
})

const dead = rows.filter((r) => r.status === 'DEAD')
const orphan = rows.filter((r) => r.status === 'orphan')
const ok = rows.filter((r) => r.status === 'ok')
const disp = rows.filter((r) => r.status === 'display')
console.log('共 ' + rows.length + ' 个配置项：生效 ' + ok.length + ' · 只读展示 ' + disp.length + ' · 死开关 ' + dead.length)
if (dead.length) {
  console.log('\n❌ 死开关（界面上能改，但代码不读）：')
  dead.forEach((r) => console.log('   ' + r.k.padEnd(20) + ' lib:' + r.inLib + ' index:' + r.inIdx))
}
if (orphan.length) console.log('\n🧹 孤儿配置（界面已撤、逻辑也没用，可以删）：' + orphan.map((r) => r.k).join(', '))
console.log('\n✅ 生效：' + ok.map((r) => r.k).join(', '))
console.log('👁  只读展示：' + disp.map((r) => r.k).join(', '))
process.exit(dead.length ? 1 : 0)
