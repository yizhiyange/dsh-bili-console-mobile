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
 *   node doctor.mjs --log               出一份体检包（口令自动抹掉，可直接发给人看）
 *   node doctor.mjs --log 出问题.txt     体检包存到指定文件
 *   node doctor.mjs --json              机器可读（给面板/脚本用）
 *
 * 设计原则：
 *   1. 8792 门卫是**唯一硬指标**——不管是 AstrBot、SnowLuma、qq-bridge 还是裸 HTTP，
 *      三种接入最后都是 POST 8792/cmd，带同一个口令。它不通，刷B站遥控就一定是死的。
 *   2. 上层框架的端口只是"参考信息"，缺了不算故障。别人用 AstrBot 就没有 3100，
 *      标成 ❌ 只会误导，所以一律标 `—` 并说明"本方案可选"。
 *   3. 只给命令，不自动执行。自动改 profile、重启服务风险太大，判断错了会把别人的机器人搞停。
 *   4. --log 出的包必定脱敏：口令、cookie、PAT 一律换成 <已隐藏>，可以放心贴到群里。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync, openSync, readSync, closeSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { homedir, networkInterfaces, hostname, platform, release } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import net from 'node:net'

const ARGS = process.argv.slice(2)
const DO_SCAN = ARGS.includes('--scan')
const AS_JSON = ARGS.includes('--json')
const LOG_IDX = ARGS.indexOf('--log')
const DO_LOG = LOG_IDX >= 0
const DO_PASTE = ARGS.includes('--paste')
const LOG_PATH_ARG = (DO_LOG && ARGS[LOG_IDX + 1] && !ARGS[LOG_IDX + 1].startsWith('--')) ? ARGS[LOG_IDX + 1] : ''
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

const BUF = []
const QUIET = DO_PASTE // --paste 只打那一段，方便整段复制
const line = (s = '') => {
  BUF.push(s)
  if (!QUIET) console.log(s)
}
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

function pluginVersion() {
  const cands = []
  try { cands.push(join(dirname(fileURLToPath(import.meta.url)), 'package.json')) } catch {}
  cands.push(join(homedir(), 'bili-console', 'package.json'))
  cands.push(join(process.cwd(), 'package.json'))
  for (const p of cands) {
    const pkg = readJson(p)
    if (pkg && pkg.name && /bili-console/.test(pkg.name) && pkg.version) return pkg.version
  }
  return '未知'
}

// 体检包要能发给人看，就必须先把敏感信息抹掉——口令、cookie、PAT 一律 <已隐藏>
function redact(s) {
  if (!s) return s
  return String(s)
    .replace(/("?(?:remoteToken|remote_token|token|password|passwd|apiKey|api_key|secret|cookie)"?\s*[:=]\s*)"?[^"\s,}]{4,}"?/gi, '$1 "<已隐藏>"')
    .replace(/\b(SESSDATA|bili_jct|DedeUserID__ckMd5|DedeUserID|sid|access_key)=([^;,\s]*)/gi, '$1=<已隐藏>')
    .replace(/(X-Bili-Token\s*[:=]\s*)\S+/gi, '$1<已隐藏>')
    .replace(/\b(ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|sk-[A-Za-z0-9]{10,})\b/g, '<已隐藏>')
}

function tailFile(p, maxLines = 40, maxBytes = 160000) {
  try {
    const st = statSync(p)
    const start = Math.max(0, st.size - maxBytes)
    const fd = openSync(p, 'r')
    const buf = Buffer.alloc(st.size - start)
    readSync(fd, buf, 0, buf.length, start)
    closeSync(fd)
    return buf.toString('utf8').split('\n').slice(-maxLines).join('\n')
  } catch { return '' }
}

function svcLine(unit) {
  if (process.platform !== 'linux') return ''
  const r = spawnSync('systemctl', ['is-active', unit], { encoding: 'utf8', timeout: 4000 })
  return `${unit}: ${(r.stdout || '').trim() || 'unknown'}`
}

async function main() {
  const stackName = STACKS[STACK_ARG] ? STACK_ARG : 'auto'
  if (stackName !== STACK_ARG) {
    line(`⚠️ 不认识 --stack ${STACK_ARG}，可选：${Object.keys(STACKS).join(' / ')}`)
  }
  const stack = STACKS[stackName]
  const ver = pluginVersion()

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
    code: '',
    short: '',
    fix: '',
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
    result.code = 'E0'
    result.short = '链路正常'
    result.verdict = '链路正常：门卫在监听且能应答，QQ 遥控可用。'
    line(`✅ ${result.verdict}`)
    if (liveWithoutPlugin.length) {
      line(`   提示：在跑的档案 ${liveWithoutPlugin.join('、')} 里没装本插件，门卫是被别的进程占着的；` +
           '那个进程重启后门卫可能消失。')
    }
  } else if (result.ports[8792] && !token) {
    result.code = 'E9'
    result.short = '门卫开着但找不到口令'
    result.verdict = '8792 在监听，但本机找不到 remoteToken，没法验证也不认命令。'
    line(`❌ ${result.verdict}`)
    line('   修：面板里看「QQ 接入」的口令，确认 config.json 里 remoteToken 和机器人那边填的一致')
  } else if (!result.ports[8792] && armed.length && liveWithoutPlugin.length) {
    result.code = 'E1'
    result.short = '插件装错档案'
    result.verdict = `装错口袋：插件装在 ${armed.join('、')}，在跑的是 ${liveWithoutPlugin.join('、')}。`
    result.fix = `dsh plugin --profile ${liveWithoutPlugin[0]} add link:<插件目录>`
    line(`❌ ${result.verdict}`)
    line(`   修：${result.fix}`)
    line('   然后重启那个档案的服务（例如 sudo systemctl restart dsh-web）')
  } else if (!result.ports[8792] && armed.length) {
    result.code = 'E2'
    result.short = '插件挂好了但门卫没开'
    result.verdict = `插件已挂进 ${armed.join('、')}，但门卫没开：那个进程没跑，或者 remoteOn=false。`
    line(`❌ ${result.verdict}`)
    line('   修：先看【4】的进程在不在；在的话去面板把「QQ 接入」小门打开')
  } else if (!result.ports[8792]) {
    result.code = 'E3'
    result.short = '没装插件'
    result.verdict = '门卫没开，且没有任何档案装了本插件。'
    line(`❌ ${result.verdict}`)
    line('   修：先把插件装到「实际在跑的那个档案」，再重启对应服务')
  } else {
    result.code = 'E4'
    result.short = '8792 被占或不应答'
    result.verdict = '8792 在监听但不应答，可能是别的东西占了这个端口。'
    line(`❌ ${result.verdict}`)
    line('   修：ss -ltnp | grep 8792 看是谁占的；确认是本插件后重启对应服务')
  }

  if (STACK_HINTS[stackName]) {
    line('')
    line(`小贴士（${stack.label}）：${STACK_HINTS[stackName]}`)
  }

  // 9) 可复制的短结论：评论区不能传文件，只能贴字，所以这段必须短、必须不带口令
  const portBits = PORTS.filter((p) => stack.roles.includes(p.role)).map((p) => {
    const up = result.ports[p.port]
    const soft = stackName === 'auto' && p.role !== 'core' && !up
    return `${p.port}${up ? '✅' : (soft ? '—' : '❌')}`
  }).join(' ')
  const profBits = profiles.length
    ? profiles.map((p) => `${p.name}${(p.installed && p.inBundles) ? '✅' : '❌'}`).join(' ')
    : '无'
  const liveBits = running.map((r) => r.profile).join(',') || '未查到'
  const blockLines = [
    `【刷B站·体检】v${ver}｜${process.platform}｜${stackName}`,
    `${result.code} ${result.short}`,
    `端口 ${portBits}`,
    `口令 ${token ? token.length + '位' : '无'}｜档案 ${profBits}｜在跑 ${liveBits}`,
    `应答 ${gateOk ? '正常' : '异常'}`
  ]
  if (result.fix) blockLines.push(`要跑的命令：${result.fix}`)
  const block = blockLines.join('\n')

  if (DO_PASTE) {
    console.log(block)
  } else if (result.code !== 'E0') {
    line('')
    line('──── 下面整段复制，贴评论区或私信就行（不含口令）────')
    line(block)
    line('──── 复制结束 ────')
  }

  if (AS_JSON) {
    line('')
    line(JSON.stringify(result, null, 2))
  }

  // 10) 体检包：给能发文件的人（群、邮件、Issue）。评论区别贴整包，贴上面那段就够
  if (DO_LOG) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const target = LOG_PATH_ARG
      ? resolve(LOG_PATH_ARG)
      : join(process.cwd(), `bili体检-${hostname()}-${stamp}.txt`)
    const parts = []
    parts.push('刷B站插件 · 部署体检包')
    parts.push(`生成时间 ${new Date().toLocaleString()}　主机 ${hostname()}　系统 ${platform()} ${release()}　Node ${process.version}　插件 v${ver}`)
    parts.push('本文件里的口令 / cookie / PAT 已自动替换为 <已隐藏>，可以直接发出去。')
    parts.push('')
    parts.push('===== 1) 体检结果 =====')
    parts.push(BUF.join('\n'))
    parts.push('')
    parts.push('===== 2) 短结论（评论区可贴）=====')
    parts.push(block)
    const sections = [
      ['3) 门卫日志 duty.log（最后 40 行）', join(homedir(), '.dsh', 'bili-console', 'duty.log'), 40],
      ['4) qq-bridge 日志 bridge.log（最后 40 行）', join(homedir(), 'qq-bridge', 'bridge.log'), 40],
      ['5) 群活动 qq-activity.log（最后 20 行）', join(homedir(), 'qq-bridge', 'state', 'qq-activity.log'), 20]
    ]
    for (const [title, p, n] of sections) {
      parts.push('')
      parts.push(`===== ${title} =====`)
      const t = tailFile(p, n)
      parts.push(t ? redact(t) : `（没读到 ${p}）`)
    }
    parts.push('')
    parts.push('===== 6) 服务状态 =====')
    if (process.platform === 'linux') {
      for (const u of ['dsh-web', 'qqbridge', 'napcat', 'zhipu-pool', 'snowluma-autologin']) parts.push(svcLine(u))
      const j = spawnSync('journalctl', ['-u', 'dsh-web', '-n', '30', '--no-pager'], { encoding: 'utf8', timeout: 6000 })
      parts.push('--- dsh-web journal（最后 30 行）---')
      parts.push(redact(((j.stdout || '') + (j.stderr || '')).trim() || '（读不到，可能没权限；有 sudo 就 sudo journalctl -u dsh-web -n 30）'))
    } else {
      parts.push('（非 Linux，跳过 systemd）')
    }
    try {
      writeFileSync(target, redact(parts.join('\n')), 'utf8')
      console.log(`\n📄 体检包已生成：${target}`)
      console.log('   （口令/cookie/PAT 已隐去，发我就行）')
    } catch (e) {
      console.log('\n⚠️ 体检包写不出去：' + (e && e.message ? e.message : e))
    }
  }
  line('')
}

main().catch((e) => {
  console.error('体检脚本自己炸了：', e)
  process.exit(1)
})
