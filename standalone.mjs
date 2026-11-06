/**
 * standalone.mjs —— 独立版（安卓平板 / 不依赖 DSH）
 * ============================================================================
 * 为什么要有这个：
 *   DSH 是 Electron 应用，低配平板上滚动掉帧，而且不开 DSH 就用不了插件。
 *   但插件本体是自给自足的：调模型直接 fetch /chat/completions，前端
 *   web/console.html 也是完整独立的控制台。所以造个「假 ctx」骗过 DSH 那层壳，
 *   用系统 WebView / 浏览器打开就行。
 *
 * 三个关键设计（2026-11-06 按用户要求改）：
 *   ① 数据完全隔离：家目录是 ~/.bili-console-app/bili-console，**不碰** ~/.dsh。
 *      首次启动只搬两样东西过来（config.json + B站登录态），运行状态一律从零开始——
 *      否则 seen.md 会把 DSH 看过的视频带过来，独立版会以为"都看过了"。
 *   ② 不读 DSH 的模型配置：把 DSH_HOME 指到一个空目录，提取逻辑自然扫不到东西。
 *      独立版的模型 / Key 全部由用户自己填（config.models 里 apiKeySource=custom）。
 *   ③ 打上 BILI_STANDALONE 标记，前端据此隐藏"从 DSH 提取模型"那块 UI。
 *
 * 用法：
 *   node standalone.mjs                 → http://127.0.0.1:8790/bili-console
 *   BILI_PORT=9000 node standalone.mjs  换端口
 *
 * ⚠️ 别和 DSH 里的插件同时跑：两边都会执行定时任务，可能重复评论。
 * ============================================================================
 */
import { createServer } from 'node:http'
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'

const PORT = Number(process.env.BILI_PORT || 8790)
const HOST = process.env.BILI_HOST || '127.0.0.1'

/** 独立版的根目录（和 DSH 完全分开） */
const APP_ROOT = join(homedir(), '.bili-console-app')
/** stateDirOf 会再拼一层 bili-console，最终就是这个目录 */
const APP_HOME = join(APP_ROOT, 'bili-console')
/** DSH 那边的家目录，只在首次迁移时读一次 */
const DSH_HOME = join(homedir(), '.dsh', 'bili-console')

const LOCK = join(APP_HOME, 'standalone.lock')
const routes = []
const disposers = []
const startedAt = Date.now()

function logLine(m) {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  console.log('[' + t + '] ' + m)
}

/* ── 首次迁移：只搬配置和登录态，运行状态一律不要 ──────────────────── */
const MIGRATE = ['config.json', 'bili_credential.json']

function migrateOnce() {
  try {
    mkdirSync(APP_HOME, { recursive: true })
    if (existsSync(join(APP_HOME, 'config.json'))) return // 已经有配置了，不再动
    let n = 0
    for (const f of MIGRATE) {
      const src = join(DSH_HOME, f)
      const dst = join(APP_HOME, f)
      if (!existsSync(src)) continue
      try {
        copyFileSync(src, dst)
        n++
        logLine('迁移 ' + f)
      } catch (e) {
        logLine('迁移失败 ' + f + '：' + (e && e.message ? e.message : e))
      }
    }
    if (n) {
      logLine('首次启动：已从 DSH 搬来 ' + n + ' 个配置（之后完全独立，不再读 DSH）')
      logLine('注意：看过的视频记录 / 今日计数 / 日志都从零开始，不会带过来')
    } else {
      logLine('没找到 DSH 的旧配置，从空白开始 —— 模型和 Key 需要自己填')
    }
  } catch (e) {
    logLine('迁移出错（不影响使用）：' + (e && e.message ? e.message : e))
  }
}

/* ── 单实例锁 ─────────────────────────────────────────────────────── */
function acquireLock() {
  try {
    mkdirSync(APP_HOME, { recursive: true })
    if (existsSync(LOCK)) {
      const old = Number(readFileSync(LOCK, 'utf8').trim())
      if (old && old !== process.pid) {
        let alive = false
        try { process.kill(old, 0); alive = true } catch { alive = false }
        if (alive) {
          console.error('已经有一个独立版在跑了（PID ' + old + '）。要重开就先关掉那个窗口。')
          process.exit(1)
        }
      }
    }
    writeFileSync(LOCK, String(process.pid), 'utf8')
  } catch { /* 锁失败不影响启动 */ }
}
function releaseLock() {
  try {
    if (existsSync(LOCK) && readFileSync(LOCK, 'utf8').trim() === String(process.pid)) unlinkSync(LOCK)
  } catch { /* 忽略 */ }
}

/* ── 独立模式标记 + 切断 DSH 配置来源 ─────────────────────────────── */
process.env.BILI_STANDALONE = '1'
// 让 dshcfg 的 dshHome() 指到一个空目录 → 扫不到任何 profile → 永远提取不到 DSH 模型
process.env.DSH_HOME = join(APP_ROOT, '_no_dsh')

migrateOnce()
acquireLock()
process.on('exit', releaseLock)
for (const sig of ['SIGINT', 'SIGTERM']) {
  try {
    process.on(sig, () => {
      logLine('收到退出信号，正在停止…')
      for (const d of disposers) { try { d() } catch {} }
      releaseLock()
      process.exit(0)
    })
  } catch {}
}

/* ── 假 ctx ──────────────────────────────────────────────────────── */
const fakeCtx = {
  logger: logLine,
  // 只认 dshHomePath 这一个：返回独立版根目录（stateDirOf 会拼成 APP_HOME）
  get: (name) => (name === 'dshHomePath' ? APP_ROOT : undefined),
  on: () => () => {},
  inject: () => {},
  effect: (fn) => {
    try {
      const d = typeof fn === 'function' ? fn() : undefined
      if (typeof d === 'function') disposers.push(d)
      return d
    } catch (e) {
      logLine('某个启动步骤失败（不影响其余功能）：' + (e && e.message ? e.message : e))
      return undefined
    }
  },
  webServer: {
    register: (def) => {
      if (!def || !def.path || typeof def.handler !== 'function') return () => {}
      routes.push(def)
      logLine('注册路由 ' + def.path + '（' + (def.kind || 'prefix') + '）')
      return () => {
        const i = routes.indexOf(def)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  },
}

try {
  apply(fakeCtx, {})
} catch (e) {
  console.error('插件初始化失败：' + (e && e.message ? e.message : e))
}
if (!routes.length) console.error('没有任何路由注册成功，面板打不开。把上面的报错发我。')

/* ── HTTP 服务 ──────────────────────────────────────────────────── */
const server = createServer((req, res) => {
  let pathname = '/'
  try { pathname = new URL(req.url, 'http://placeholder').pathname } catch { /* 保持 / */ }

  if (pathname === '/') {
    res.writeHead(302, { location: '/bili-console' })
    return res.end()
  }
  if (pathname === '/favicon.ico' || pathname === '/apple-touch-icon.png') {
    res.writeHead(204)
    return res.end()
  }
  if (pathname === '/__alive') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, standalone: true, uptime: Math.round((Date.now() - startedAt) / 1000), routes: routes.length, pid: process.pid, home: APP_HOME }))
  }

  const hit = routes.find((r) => (r.kind === 'exact' ? pathname === r.path : pathname.startsWith(r.path)))
  if (hit) {
    try {
      Promise.resolve(hit.handler(req, res)).catch((e) => {
        logLine('路由处理出错：' + (e && e.message ? e.message : e))
        try {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }))
        } catch {}
      })
    } catch (e) {
      logLine('路由同步出错：' + (e && e.message ? e.message : e))
    }
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('404。面板在 http://' + HOST + ':' + PORT + '/bili-console')
})

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 被占用了。换个端口：BILI_PORT=8792 node standalone.mjs')
  } else {
    console.error('服务启动失败：' + (e && e.message ? e.message : e))
  }
  releaseLock()
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  const url = 'http://' + HOST + ':' + PORT + '/bili-console'
  console.log('')
  console.log('  ┌─────────────────────────────────────────────┐')
  console.log('  │  刷B站插件 · 独立版（不依赖 DSH）            │')
  console.log('  └─────────────────────────────────────────────┘')
  console.log('  面板地址： ' + url)
  console.log('  数据目录： ' + APP_HOME)
  console.log('            （和 DSH 完全分开，互不影响）')
  console.log('  关掉这个窗口 = 停止运行')
  console.log('')
  console.log('  ⚠️ 别同时开着 DSH 里的插件，两边都会跑定时任务。')
  console.log('')
})
