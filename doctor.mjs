#!/usr/bin/env node
/**
 * doctor.mjs —— 部署体检（不是逻辑自测，逻辑自测见 selfcheck.mjs）
 * ============================================================================
 * 它只回答一个问题：**为什么 QQ 遥控不通／插件明明装了却不干活**。
 *
 * 用法：
 *   node doctor.mjs            体检本机
 *   node doctor.mjs --scan     顺便扫一遍局域网，看哪台机器开着 8792
 *   node doctor.mjs --json     机器可读输出（给面板/脚本用）
 *
 * 它检查的四件事：
 *   1. 五个端口谁活着（8792 门卫 / 3080 DSH Web / 3100 qq-bridge / 6099 NapCat / 8790 独立面板）
 *   2. 口令文件在不在（只报长度，绝不打印明文）
 *   3. 每个 DSH 档案（profile）里到底有没有装本插件
 *   4. 当前真正在跑的 DSH 是哪个档案 + 门卫能不能应答
 *
 * 常见结论「装了却不干活」的根因就一条：插件装在 A 档案，服务跑的是 B 档案。
 * DSH 的插件是按档案加载的，两边不共享 —— 装对了不等于装对了地方。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import net from 'node:net'

const ARGS = process.argv.slice(2)
const DO_SCAN = ARGS.includes('--scan')
const AS_JSON = ARGS.includes('--json')

const PORTS = [
  { port: 8792, name: 'QQ 遥控门卫', key: 'gate' },
  { port: 3080, name: 'DSH Web', key: 'dshweb' },
  { port: 3100, name: 'qq-bridge', key: 'qqbridge' },
  { port: 6099, name: 'NapCat', key: 'napcat' },
  { port: 8790, name: '独立面板', key: 'panel' }
]

const CONFIG_PATHS = [
  join(homedir(), '.dsh', 'bili-console', 'config.json'),
  join(homedir(), '.bili-console-app', 'bili-console', 'config.json'),
  join(homedir(), 'bili-console', 'config.json')
]

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
      inBundles: bundles.some((b) => /bili-console/.test(b)),
      bundles
    })
  }
  return out
}

function runningDsh() {
  // Linux：直接从 /proc 读启动参数；Windows 没有 /proc，跳过（不影响端口与档案检查）
  if (!existsSync('/proc')) return []
  const out = []
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    let cmd = ''
    try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim() } catch { continue }
    if (!cmd) continue
    if (!/deepseek-harness|dsh-desktop-host|dsh\/cli/i.test(cmd)) continue
    const m = cmd.match(/--profile\s+([\w.-]+)/)
    out.push({ pid, profile: m ? m[1] : '(未指定，通常是 desktop)', cmd: cmd.slice(0, 200) })
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
  const ifs = networkInterfaces()
  for (const list of Object.values(ifs)) {
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

const line = (s = '') => console.log(s)
const mark = (b) => (b ? '✅' : '❌')

async function main() {
  const result = {
    platform: process.platform,
    node: process.version,
    ports: {},
    config: {},
    profiles: [],
    running: [],
    gatekeeper: null,
    verdict: ''
  }

  line('')
  line('刷B站 · 部署体检')
  line(`平台 ${process.platform} · Node ${process.version}`)
  line('─'.repeat(52))

  // 1) 端口
  line('【1】端口')
  for (const p of PORTS) {
    const up = await probe('127.0.0.1', p.port)
    result.ports[p.key] = up
    line(`  ${mark(up)} ${String(p.port).padEnd(5)} ${p.name}`)
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
  if (!profiles.length) line('  ⚠️ 没找到 ~/.dsh/profiles，可能没装 DSH 或家目录不同')
  for (const p of profiles) {
    const good = p.installed && p.inBundles
    line(`  ${mark(good)} ${p.name.padEnd(8)} 依赖${p.installed ? '有' : '无'} / bundles${p.inBundles ? '有' : '无'}`)
  }

  // 4) 在跑的 DSH
  line('')
  line('【4】正在运行的 DSH')
  const running = runningDsh()
  result.running = running
  if (!running.length) line('  （本机查不到 DSH 进程；Windows 上属正常，可直接看端口结论）')
  for (const r of running) line(`  pid ${r.pid} → 档案 ${r.profile}`)

  // 5) 门卫应答
  line('')
  line('【5】门卫应答')
  if (!result.ports.gate) {
    line('  ❌ 8792 没监听，命令发不进去')
  } else if (!token) {
    line('  ⚠️ 8792 开着但没有口令，无法验证')
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

  // 6) 局域网扫描（可选）
  if (DO_SCAN) {
    line('')
    line('【6】局域网扫描 8792')
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

  // 7) 结论
  line('')
  line('─'.repeat(52))
  const gateUp = !!result.ports.gate
  const gateOk = result.gatekeeper && result.gatekeeper.status === 200
  const liveProfiles = running.map((r) => r.profile)
  const armed = profiles.filter((p) => p.installed && p.inBundles).map((p) => p.name)
  const missingInLive = liveProfiles.filter((n) => n !== '(未指定，通常是 desktop)' && n !== 'desktop' && !armed.includes(n))

  if (gateUp && gateOk) {
    result.verdict = '链路正常：门卫在监听且能应答，QQ 遥控可用。'
    line(`✅ ${result.verdict}`)
    if (missingInLive.length) {
      line(`   提示：当前在跑的档案 ${missingInLive.join('、')} 里没有装本插件，` +
           '门卫是被别的进程占着的。以后这个进程重启，门卫可能跟着消失。')
    }
  } else if (!gateUp && armed.length && missingInLive.length) {
    result.verdict = `装错口袋：插件装在 ${armed.join('、')} 档案，但在跑的是 ${missingInLive.join('、')}。`
    line(`❌ ${result.verdict}`)
    line(`   修：dsh plugin --profile ${missingInLive[0]} add link:<插件目录>`)
    line(`   然后重启那个档案的服务（例如 sudo systemctl restart dsh-web）`)
  } else if (!gateUp && armed.length) {
    result.verdict = `插件已挂进 ${armed.join('、')}，但门卫没开：要么那个进程没跑，要么 remoteOn=false。`
    line(`❌ ${result.verdict}`)
    line('   修：先看【4】里那个档案的进程在不在；在的话去面板把「QQ 接入」小门打开')
  } else if (!gateUp) {
    result.verdict = '门卫没开，且没有任何档案装了本插件。'
    line(`❌ ${result.verdict}`)
    line('   修：先装插件到「实际在跑的那个档案」，再重启对应服务')
  } else {
    result.verdict = '8792 在监听但不应答，可能是别的东西占了这个端口。'
    line(`❌ ${result.verdict}`)
    line('   修：ss -ltnp | grep 8792 看是谁占的；确认是本插件后重启对应服务')
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
