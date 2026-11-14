#!/usr/bin/env node
/**
 * doctor.mjs —— 部署体检 + 多栈适配（不是逻辑自测，逻辑自测见 selfcheck.mjs）
 * ============================================================================
 * 它只回答一个问题：**为什么 QQ 遥控不通／插件明明装了却不干活**。
 *
 * 用法：
 *   node doctor.mjs                     自动识别本机是哪套组合
 *   node doctor.mjs --stack dsh         DSH 插件模式（本地/桌面版）
 *   node doctor.mjs --stack qqbridge    DSH + qq-bridge（NapCat）
 *   node doctor.mjs --stack snowluma    SnowLuma 当 QQ 协议端
 *   node doctor.mjs --stack astrbot     AstrBot 当机器人
 *   node doctor.mjs --stack standalone  独立面板模式
 *   node doctor.mjs --scan              顺便扫局域网，看哪台机器开着 8792
 *   node doctor.mjs --json              机器可读（给面板/脚本用）
 *
 * 设计原则：
 *   1. 8792 门卫是**唯一硬指标**——不管是 AstrBot、SnowLuma、qq-bridge 还是裸 HTTP，
 *      三种接入最后都是 POST 8792/cmd，带同一个口令。它不通，刷B站遥控就一定是死的。
 *   2. 上层框架的端口只是"参考信息"，缺了不算故障。别人用 AstrBot 就没有 3100，
 *      标成 ❌ 只会误导，所以一律标 `—` 并说明"本方案可选"。
 *   3. 只给命令，不自动执行。自动改 profile、重启服务风险太大，判断错了会把别人的机器人搞停。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import net from 'node:net'

const ARGS = process.argv.slice(2)
const DO_SCAN = ARGS.includes('--scan')
const AS_JSON = ARGS.includes('--json')
const STACK_ARG = (() => {
  const i = ARGS.indexOf('--stack')
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1].trim().toLowerCase() : 'auto'
})()

// 端口字典：role 决定它属于哪套方案
const PORTS = [
  { port: 8792, role: 'core', name: 'QQ 遥控门卫' },
  { port: 3080, role: 'dsh', name: 'DSH Web' },
  { port: 8790, role: 'panel', name: '独立面板' },
  { port: 3100, role: 'qqbridge', name: 'qq-bridge' },
  { port: 6185, role: 'astrbot', name: 'AstrBot 控制台' },
  { port: 3001, role: 'ws', name: 'SnowLuma / NapCat WS' },
  { port: 6099, role: 'napcat', name: 'NapCat WebUI' }
]

const STACKS = {
  auto: { label: '自动识别', roles: PORTS.map((p) => p.role) },
  dsh: { label: 'DSH 插件模式', roles: ['core', 'dsh', 'panel'] },
  qqbridge: { label: 'DSH + qq-bridge（NapCat）', roles: ['core', 'dsh', 'qqbridge', 'napcat', 'ws', 'panel'] },
  snowluma: { label: 'SnowLuma 当协议端', roles: ['core', 'ws', 'napcat', 'qqbridge'] },
  astrbot: { label: 'AstrBot 当机器人', roles: ['core', 'astrbot', 'napcat', 'ws'] },
  standalone: { label: '独立面板模式', roles: ['core', 'panel'] }
}

const STACK_HINTS = {
  astrbot: 'AstrBot 侧：astrbot_plugin_bili_bridge 只负责转发，它自己不提供 8792；指到 8792 + 填对 token 即可。',
  qqbridge: 'qq-bridge 侧：mcp-bili.js 会自动读 ~/.dsh/bili-console/config.json 的口令，别手动填错。',
  snowluma: 'SnowLuma 侧：WS 地址要和 qq-bridge 的 config.json 对上（默认 3001）。',
  dsh: 'DSH 侧：插件必须挂进「实际在跑的那个档案」，光装进另一个档案不会加载。',
  standalone: '独立面板侧：面板(8790)被硬编码成 noListen，永远不会开 8792；QQ 遥控仍要插件提供。'
}

const CONFIG_PATHS = [
  join(homedir(), '.dsh', 'bili-console', 'config.json'),
  join(homedir(), '.bili-console-app', 'bili-console', 'config.json'),
  join(homedir(), 'bili-console', 'config.json')
]

const line = (s = '') => console.log(s)
const mark = (b) => (b ? '✅' : '❌')

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null }
}

function probe(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port })
    let settled = false
    const finish = (v) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(v)
    }
    sock.setTimeout(timeout)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

function findToken() {
  for (const p of CONFIG_PATHS) {
    const c = readJson(p)
    if (c && c.remoteToken) return { token: String(c.remoteToken), path: p, cfg: c }
  }
  return { token: '', path: '', cfg: null }
}

function listProfiles() {
  const dir = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const pkg = readJson(join(dir, name, 'package.json'))
    if (!pkg) continue
    const deps = pkg.dependencies || {}
    const bundles = (pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
    out.push({
      name,
      installed: Object.keys(deps).some((k) => /bili-console/.test(k)),
      inBundles: bundles.some((b) => /bili-console/.test(b))
    })
  }
  return out
}

function runningDsh() {
  if (!existsSync('/proc')) return []
  const out = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    let cmd = ''
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch { continue }
    if (!cmd) continue
    if (!/deepseek-harness|dsh-desktop-host|dsh\/cli/i.test(cmd)) continue
    const m = cmd.match(/--profile\s+([\w.-]+)/)
    out.push({ pid, profile: m ? m[1] : '(未指定，通常是 desktop)' })
  }
  return out
}

async function askGate(token) {
  try {
    const r = await fetch('http://127.0.0.1:8792/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Bili-Token': token },
      body: JSON.stringify({ action: 'help' }),
      signal: AbortSignal.timeout(8000)
    })
    const body = await r.text()
    return { status: r.status, body: body.slice(0, 400) }
  } catch (e) {
    return { status: 0, body: String(e && e.message ? e.message : e) }
  }
}

function lanBase() {
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address.split('.').slice(0, 3).join('.')
    }
  }
  return null
}

async function scanLan(base) {
  const hits = []
  const hosts = Array.from({ length: 254 }, (_, i) => `${base}.${i + 1}`)
  let idx = 0
  const workers = Array.from({ length: 48 }, async () => {
    while (idx < hosts.length) {
      const h = hosts[idx++]
      if (await probe(h, 8792, 900)) hits.push(h)
    }
  })
  await Promise.all(workers)
  return hits.sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]))
}

async function main() {
  const stackName = STACKS[STACK_ARG] ? STACK_ARG : 'auto'
  if (stackName !== STACK_ARG) {
    line(`⚠️ 不认识 --stack ${STACK_ARG}，可选：${Object.keys(STACKS).join(' / ')}`)
  }
  const stack = STACKS[stackName]

  const result = {
    stack: stackName,
    stackLabel: stack.label,
    platform: process.platform,
    node: process.version,
    ports: {},
    notApplicable: [],
    upstream: [],
    config: {},
    profiles: [],
    running: [],
    gatekeeper: null,
    verdict: ''
  }

  line('')
  line(`刷B站 · 部署体检    方案：${stack.label}（--stack ${stackName}）`)
  line(`平台 ${process.platform} · Node ${process.version}`)
  line('─'.repeat(56))

  // 1) 端口：本方案内的真检查，方案外的一律标 —
  line('【1】端口')
  for (const p of PORTS) {
    const inStack = stack.roles.includes(p.role)
    if (!inStack) {
      result.notApplicable.push(p.port)
      line(`  —  ${String(p.port).padEnd(5)} ${p.name}（本方案不检查）`)
      continue
    }
    const up = await probe('127.0.0.1', p.port)
    result.ports[p.port] = up
    // auto 模式下"没探到"不等于"坏了"：可能是压根没装这套。非核心端口一律标 —，避免吓人。
    const soft = stackName === 'auto' && p.role !== 'core' && !up
    const tag = p.role === 'core' ? '  ← 硬指标' : ''
    const head = up ? '✅' : (soft ? '—' : '❌')
    const tail = soft ? '（未检测到，可选）' : ''
    line(`  ${head} ${String(p.port).padEnd(5)} ${p.name}${tail}${tag}`)
  }

  // 2) 口令
  line('')
  line('【2】口令')
  const { token, path, cfg } = findToken()
  result.config = { hasToken: !!token, tokenLen: token.length, path, remoteOn: cfg ? !!cfg.remoteOn : null }
  if (token) line(`  ✅ 找到口令（${token.length} 位，不显示内容）→ ${path}`)
  else line('  ❌ 没找到 remoteToken（配置里没有，门卫就算开着也不认命令）')
  if (cfg && cfg.remoteOn === false) line('  ⚠️ 配置里 remoteOn = false，门卫不会开；去面板打开「QQ 接入」小门')

  // 3) 档案
  line('')
  line('【3】DSH 档案（插件按档案加载，互不共享）')
  const profiles = listProfiles()
  result.profiles = profiles
  if (!profiles.length) line('  ⚠️ 没找到 ~/.dsh/profiles（没装 DSH 或家目录不同；用 AstrBot 的人可能是这种情况）')
  for (const p of profiles) {
    const good = p.installed && p.inBundles
    line(`  ${mark(good)} ${p.name.padEnd(8)} 依赖${p.installed ? '有' : '无'} / bundles${p.inBundles ? '有' : '无'}`)
  }

  // 4) 在跑的 DSH
  line('')
  line('【4】正在运行的 DSH')
  const running = runningDsh()
  result.running = running
  if (!running.length) line('  （本机没查到 DSH 进程；Windows 上没有 /proc，属正常，看端口结论即可）')
  for (const r of running) line(`  pid ${r.pid} → 档案 ${r.profile}`)

  // 5) 门卫应答
  line('')
  line('【5】门卫应答（核心）')
  if (!result.ports[8792] && stack.roles.includes('core')) {
    line('  ❌ 8792 没监听，命令发不进去')
  } else if (!token) {
    line('  ⚠️ 没有口令，无法验证应答')
  } else {
    const r = await askGate(token)
    result.gatekeeper = r
    if (r.status === 200 && r.body.includes('ok')) {
      line('  ✅ 门卫应答正常')
      line('  ' + r.body.replace(/\s+/g, ' ').slice(0, 220))
    } else {
      line(`  ❌ 门卫不应答（HTTP ${r.status}）`)
      line('  ' + r.body.replace(/\s+/g, ' ').slice(0, 220))
    }
  }

  // 6) 上游框架（仅供参考）
  line('')
  line('【6】上游框架（仅供参考，缺了不算故障）')
  const upstreamMap = [
    { port: 3100, name: 'qq-bridge' },
    { port: 6185, name: 'AstrBot' },
    { port: 3001, name: 'SnowLuma' },
    { port: 6099, name: 'NapCat WebUI' },
    { port: 3080, name: 'DSH Web' }
  ]
  for (const u of upstreamMap) {
    const up = await probe('127.0.0.1', u.port, 900)
    if (up) result.upstream.push({ port: u.port, name: u.name })
    line(`  ${up ? '✅' : '—'} ${String(u.port).padEnd(5)} ${u.name}`)
  }
  const detected = result.upstream.map((u) => u.name)
  line(`  检测到的上游：${detected.length ? detected.join('、') : '无（可能只装了 AstrBot 且没开控制台，或纯 HTTP 直连）'}`)

  // 7) 局域网扫描
  if (DO_SCAN) {
    line('')
    line('【7】局域网扫描 8792')
    const base = lanBase()
    if (!base) {
      line('  ⚠️ 没有可用的局域网 IPv4 地址，跳过')
    } else {
      line(`  扫描 ${base}.1-254 …（约 10 秒）`)
      const hits = await scanLan(base)
      if (!hits.length) line('  没扫到开放 8792 的机器')
      for (const h of hits) line(`  ✅ ${h}:8792`)
      result.scan = { base, hits }
    }
  }

  // 8) 结论
  line('')
  line('─'.repeat(56))
  const gateUp = !!result.ports[8792] || !stack.roles.includes('core')
  const gateOk = result.gatekeeper && result.gatekeeper.status === 200
  const armed = profiles.filter((p) => p.installed && p.inBundles).map((p) => p.name)
  const liveProfiles = running.map((r) => r.profile)
  const liveWithoutPlugin = liveProfiles.filter((n) => {
    const short = n.replace('(未指定，通常是 desktop)', 'desktop')
    return !armed.includes(short)
  })

  if (gateOk) {
    result.verdict = '链路正常：门卫在监听且能应答，QQ 遥控可用。'
    line(`✅ ${result.verdict}`)
    if (liveWithoutPlugin.length) {
      line(`   提示：在跑的档案 ${liveWithoutPlugin.join('、')} 里没装本插件，门卫是被别的进程占着的；` +
           '那个进程重启后门卫可能消失。')
    }
  } else if (!result.ports[8792] && armed.length && liveWithoutPlugin.length) {
    result.verdict = `装错口袋：插件装在 ${armed.join('、')}，在跑的是 ${liveWithoutPlugin.join('、')}。`
    line(`❌ ${result.verdict}`)
    line(`   修：dsh plugin --profile ${liveWithoutPlugin[0]} add link:<插件目录>`)
    line('   然后重启那个档案的服务（例如 sudo systemctl restart dsh-web）')
  } else if (!result.ports[8792] && armed.length) {
    result.verdict = `插件已挂进 ${armed.join('、')}，但门卫没开：那个进程没跑，或者 remoteOn=false。`
    line(`❌ ${result.verdict}`)
    line('   修：先看【4】的进程在不在；在的话去面板把「QQ 接入」小门打开')
  } else if (!result.ports[8792]) {
    result.verdict = '门卫没开，且没有任何档案装了本插件。'
    line(`❌ ${result.verdict}`)
    line('   修：先把插件装到「实际在跑的那个档案」，再重启对应服务')
  } else {
    result.verdict = '8792 在监听但不应答，可能是别的东西占了这个端口。'
    line(`❌ ${result.verdict}`)
    line('   修：ss -ltnp | grep 8792 看是谁占的；确认是本插件后重启对应服务')
  }

  if (STACK_HINTS[stackName]) {
    line('')
    line(`小贴士（${stack.label}）：${STACK_HINTS[stackName]}`)
  }

  if (AS_JSON) {
    line('')
    line(JSON.stringify(result, null, 2))
  }
  line('')
}

main().catch((e) => {
  console.error('体检脚本自己炸了：', e)
  process.exit(1)
})
