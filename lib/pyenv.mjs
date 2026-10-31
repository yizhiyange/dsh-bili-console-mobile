/**
 * lib/pyenv.mjs —— 插件自带 Python 环境（自举 / 零前置）
 * ============================================================================
 * 设计目标（用户明确要求）：**下载即用，不依赖用户机器上预先装过任何东西**。
 *   - 本机若已有「装好依赖」的 Python（如开发机的 Python312）→ 直接用，省一次建 venv；
 *   - 干净机器 → 用系统 Python 3.10+ 自动建 venv（放在插件家目录 .venv）并 pip 安装依赖；
 *   - 连 Python 都没有 → 抛带人话的报错，而不是默默"找不到 Python"。
 *
 * 对外三件套：
 *   - resolvePython(cfg, home)：返回「能跑 mcp_server.py」的 python 命令（给即时调用用）
 *   - ensureVenv(cfg, home, onLog)：确保依赖就绪，返回 python 命令（登录 / 跑一轮前必调）
 *   - venvStatus(home)：给前端 / 诊断接口用的环境就绪状态
 * ============================================================================
 */
import { existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { homedir } from 'node:os'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
export const REQUIREMENTS = join(SELF_DIR, '..', 'vendor', 'bilibili-mcp', 'requirements.txt')

/** mcp_server.py 真正 import 的第三方包（探测"依赖是否就绪"就用这组） */
const DEPS = ['bilibili_api', 'mcp', 'aiohttp', 'qrcode']

/** 插件家目录下的专属 venv 解释器路径 */
export function venvPython(home) {
  if (!home) return null
  return process.platform === 'win32'
    ? join(home, '.venv', 'Scripts', 'python.exe')
    : join(home, '.venv', 'bin', 'python')
}

/** 把 'py -3' 这种带参数的命令拆成 [exe, args]（mcpc 只接受单个可执行文件路径） */
function _split(cmd) {
  const p = String(cmd).trim().split(/\s+/)
  return [p[0], p.slice(1)]
}

/** 异步跑一条长命令：不阻塞 Node 事件循环。
 *  ⚠️ 之前用 spawnSync 跑 apt/pip（一跑几分钟）会把整个 DSH 进程冻住 —— 手机上表现为
 *  「启动失败：已请求停止，Web 尚未退出」。ensureVenv 本身是 async，长命令必须走这里。（2026-10-30 修） */
const execFileP = promisify(execFile)
async function runCmd(exe, args, opts = {}) {
  // ⚠️ execFile 默认 stdout 缓冲 1MB：pip 装依赖的输出能超限，进程会被 Node 杀掉，
  //    表现为「装到一半失败」但真错误被吞。这里兜底 32MB（2026-10-31 实锤）
  const o = { maxBuffer: 32 * 1024 * 1024, ...opts }
  try {
    const { stdout, stderr } = await execFileP(exe, args, o)
    return { status: 0, stdout: Buffer.from(String(stdout || '')), stderr: Buffer.from(String(stderr || '')) }
  } catch (e) {
    return {
      status: typeof e.code === 'number' ? e.code : 1,
      stdout: Buffer.from(String(e.stdout || '')),
      stderr: Buffer.from(String(e.stderr || '') + (e.message ? '\n' + e.message : '')),
    }
  }
}

/** 探测某解释器能否 import 我们的依赖（带缓存，避免每轮重复 spawn） */
const _depCache = new Map() // 命令字符串 -> bool
function _hasDeps(cmd) {
  // 缓存策略（2026-10-31 修）：成功永久缓存；失败只信 60 秒。
  // 为什么：刚开机冷启动时 import 一堆库（bilibili_api/aiohttp/mcp…）在手机和 Windows 上
  // 都可能超过旧的超时，探测失败还被永久记住 → 界面一直显示「待安装」，
  // 点一次安装（进程已热）又说成功，重启又回到原点——用户实测的死循环就是它。
  const hit = _depCache.get(cmd)
  if (hit) {
    if (hit.ok) return true
    if (Date.now() - hit.at < 60000) return false
  }
  const [exe, args] = _split(cmd)
  let ok = false
  if (exe) {
    const isPath = exe.includes('\\') || exe.includes('/')
    if (!isPath || existsSync(exe)) {
      try {
        const r = spawnSync(exe, [...args, '-c', `import importlib; [importlib.import_module(m) for m in ${JSON.stringify(DEPS)}]; print('OK')`], {
          timeout: 30000, windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
        })
        ok = r.status === 0
      } catch { /* 起不来就当没有 */ }
    }
  }
  _depCache.set(cmd, { ok, at: Date.now() })
  return ok
}

/** 系统里常见的基础 Python 安装位置 + 启动器（按优先级，Windows 用 'py' 而非 'python' 别名） */
function _baseCandidates() {
  const list = []
  if (process.platform === 'win32') {
    const lap = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    for (const v of ['Python313', 'Python312', 'Python311', 'Python310', 'Python39', 'Python38', 'Python37']) {
      list.push(join(lap, 'Programs', 'Python', v, 'python.exe'))
    }
    list.push('py')             // Windows Python 官方启动器（推荐）
    list.push('python')         // 兜底：可能是 WindowsApps 别名，不一定可用
    return list
  }
  // macOS / Linux / 安卓(proot、Termux)：**先试绝对路径，再退回裸命令**。
  // 以前这里只放 'python3'，只要 PATH 里没有就误报"没检测到 Python 3"——
  // 手机上（proot/Termux）PATH 常常不含 /usr/bin，于是明明装了也显示未安装（2026-10-31 修）。
  list.push(
    '/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3', '/opt/homebrew/bin/python3',
    '/data/data/com.termux/files/usr/bin/python3',   // Termux 自带
    '/usr/bin/python', '/usr/local/bin/python',
  )
  list.push('python3', 'python')
  return list
}

/** 找一个「已装好依赖」的基础解释器（直接用，或用来建 venv 都行） */
export function findBasePythonWithDeps() {
  for (const c of _baseCandidates()) {
    if (_hasDeps(c)) return c
  }
  return null
}

/** 找一个能启动的基础解释器（不要求有依赖，用来 bootstrap venv） */
export function findBasePython() {
  for (const c of _baseCandidates()) {
    const [exe, args] = _split(c)
    if (!exe) continue
    const isPath = exe.includes('\\') || exe.includes('/')
    if (isPath && !existsSync(exe)) continue
    try {
      const r = spawnSync(exe, [...args, '-c', 'import sys; print(sys.version_info[0])'], {
        timeout: 5000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
      if (r.status === 0) return c
    } catch { /* noop */ }
  }
  return null
}

/**
 * 解析运行 mcp_server.py 用的 python 命令：
 *   ① 插件自建 venv（含依赖）→ 优先（最干净、最可控）
 *   ② 系统里「已含依赖」的解释器（如本机 Python312）→ 直接用
 *   ③ 插件 venv 路径（即便还没装好——调用方应确保先 ensureVenv）
 *   ④ 任意基础解释器（用于 bootstrap）
 * 注意：返回的是 mcpc 能直接 spawn 的单命令（绝对路径 或 裸命令，绝不带空格参数）。
 */
export function resolvePython(cfg = {}, home = '') {
  // 0. 用户手动指定的解释器最高优先（设置页"高级"里可填）
  if (cfg.pythonPath && existsSync(cfg.pythonPath)) return cfg.pythonPath
  const vp = venvPython(home)
  if (vp && existsSync(vp) && _hasDeps(vp)) return vp
  const withDeps = findBasePythonWithDeps()
  if (withDeps) return withDeps
  if (vp) return vp
  return findBasePython() || 'python3'
}

/* ───────── 自举：确保插件自己的 venv 已就绪 ───────── */
let _ensurePromise = null

/**
 * 环境自检：把"到底试了哪些解释器、成没成、venv 什么状态"全部摊开。
 * 为什么需要它：用户只看到一句"没检测到 Python 3"，分不清是**真没装**还是**装了但没被找到**
 * （手机上 PATH 不含 /usr/bin 就会这样）。把这些细节亮出来，一眼定位。
 */
export function envDiagnostics(home = '') {
  const tried = []
  let found = null
  for (const c of _baseCandidates()) {
    const [exe, args] = _split(c)
    if (!exe) continue
    const isPath = exe.includes('\\') || exe.includes('/')
    let ok = false
    let ver = ''
    let why = ''
    if (isPath && !existsSync(exe)) why = '文件不存在'
    else {
      try {
        const r = spawnSync(exe, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])'], {
          timeout: 5000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        })
        ok = r.status === 0
        ver = ok ? String(r.stdout || '').trim() : ''
        if (!ok) why = String((r.stderr || '') || '启动失败').trim().slice(0, 80)
      } catch (e) { why = String(e?.message ?? e).slice(0, 80) }
    }
    tried.push({ cmd: c, ok, ver, why })
    if (ok) { found = { cmd: c, ver }; break }
  }
  const vp = venvPython(home)
  const exists = !!(vp && existsSync(vp))
  return {
    platform: process.platform,
    path: process.env.PATH || '',
    tried,
    found,
    venv: {
      path: vp,
      exists,
      ready: !!(exists && _hasDeps(vp)),
    },
  }
}

/** 给前端 / 诊断接口用的环境就绪状态 */
/** 装完后清掉"依赖探测"缓存——否则刚装好仍会被判定为没装（缓存按命令字符串记） */
export function clearDepCache() { _depCache.clear() }

/**
 * 把「该解释器已确认带依赖」持久化到磁盘（.pyready.json）。
 * 为什么需要它：之前的状态探测每次轮询都重新 import 一堆重库（bilibili_api/aiohttp/mcp…），
 * Windows 冷启动（AV 扫 DLL、磁盘缓存空）常常超过 30s 超时 → 误判"没依赖"并被 60s 失败缓存记住，
 * 于是「重启后一直待安装、点检测也没用」的死循环。既然用户点过「一键装好」已经证明能用，
 * 就把这个事实存下来，重启后直接读存档显示「就绪」，不再依赖冷探测。
 */
const READY_MARKER = '.pyready.json'
function _markPath(home) { return home ? join(home, READY_MARKER) : null }
export function markReady(home, python) {
  if (!home || !python) return
  try { writeFileSync(_markPath(home), JSON.stringify({ python, at: Date.now() })) } catch { /* 写不了就算了 */ }
}
export function clearReady(home) {
  if (!home) return
  try { rmSync(_markPath(home), { force: true }) } catch { /* 没有就不删 */ }
}
function readReadyMark(home) {
  if (!home) return null
  try { const j = JSON.parse(readFileSync(_markPath(home), 'utf8')); return (j && typeof j.python === 'string') ? j.python : null } catch { return null }
}

export function venvStatus(home, { force = false } = {}) {
  const vp = venvPython(home)
  const venvPath = vp
  const venvExists = !!(vp && existsSync(vp))
  const venvReady = !!(vp && existsSync(vp) && _hasDeps(vp))
  let basePython = null, baseWithDeps = null
  // 已持久化确认过「带依赖」→ 直接信任，避免每次轮询都冷探测（重启也不丢、不再卡待安装）
  const mark = force ? null : readReadyMark(home)
  if (mark && existsSync(mark)) {
    basePython = mark
    baseWithDeps = mark
  } else {
    basePython = findBasePython() || null
    baseWithDeps = findBasePythonWithDeps() || null
    if (baseWithDeps) markReady(home, baseWithDeps) // 探测成功就落盘，重启后直接读存档
  }
  return { venvPath, venvExists, venvReady, basePython, baseWithDeps }
}

/**
 * 确保有能跑 mcp_server.py 的 python：
 *   1) 已有可用的 venv → 直接返回
 *   2) 系统 python 已含依赖（且用户没手动指定 pythonPath）→ 直接用，省去建 venv
 *   3) 否则用基础 python 建 venv 并 pip 安装依赖（下载即用）
 * 返回 python 命令字符串。失败抛「带人话」的错误。
 */
export async function ensureVenv(cfg = {}, home = '', onLog = () => {}) {
  // 并发安全：同一时刻只跑一次自举
  if (_ensurePromise) return _ensurePromise
  _ensurePromise = (async () => {
    const vp = venvPython(home)
    // 0. 用户手动指定的解释器 → 尊重，不再自举
    if (cfg.pythonPath && existsSync(cfg.pythonPath)) { onLog('使用手动指定的 Python：' + cfg.pythonPath); return cfg.pythonPath }
    // 1. 已有可用的 venv
    if (vp && existsSync(vp) && _hasDeps(vp)) { onLog('依赖 venv 已就绪'); return vp }
    // 2. 系统 python 已含依赖 → 直接用（干净机器不会命中；本机命中可省去建 venv）
    const withDeps = findBasePythonWithDeps()
    if (withDeps && !cfg.pythonPath) { onLog('使用系统 Python（已含依赖）：' + withDeps); return withDeps }
    // 3. 需要建 venv
    const base = findBasePython()
    if (!base) {
      throw new Error('没找到可用的 Python 3。请先安装 Python 3.10+（https://www.python.org），安装时务必勾选 “Add Python to PATH”。')
    }
    if (!vp) throw new Error('插件家目录未确定，无法建 venv')
    onLog('正在用 ' + base + ' 创建插件专属 venv…')
    const [baseExe, baseArgs] = _split(base)
    // ⭐ venv 的参数是「venv 根目录」（home/.venv），不是解释器路径——
    //   之前误把解释器路径当目录传，手机上首次触发就炸：
    //   "/usr/bin/python3 and .venv/bin/python/bin/python3 are the same file"（2026-10-30 修）
    const venvDir = join(home, '.venv')
    try { rmSync(venvDir, { recursive: true, force: true }) } catch { /* 清残留失败不致命 */ }
    // --copies：用复制而非软链接建 venv。Android/Termux 等文件系统不支持软链时会直接失败（2026-10-30 手机端踩到）
    const VENV_RUN = { timeout: 120000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } }
    const mkFirst = () => runCmd(baseExe, [...baseArgs, '-m', 'venv', '--copies', venvDir], VENV_RUN)
    let mk = await mkFirst()
    if (mk.status !== 0) {
      const raw = [
        mk.stderr && mk.stderr.toString().trim(),
        mk.stdout && mk.stdout.toString().trim(),
        mk.error && mk.error.message,
        '退出码 ' + mk.status,
      ].filter(Boolean).join(' | ') || '无任何输出'
      // Debian/Ubuntu 系缺 python3-venv（ensurepip）→ 自动补装后重试一次，用户无需懂命令（2026-10-30 手机端实测踩到）
      if (/ensurepip|python3-venv|virtual environment was not created|Unable to locate/i.test(raw) && process.platform !== 'win32') {
        const RUN = { timeout: 300000, windowsHide: true, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } }
        for (const apt of ['apt-get', 'apt']) {
          onLog('检测到缺 python3-venv，正在自动安装（' + apt + '，约需一两分钟）…')
          let ins = await runCmd(apt, ['install', '-y', 'python3-venv'], RUN)
          // "Unable to locate package" = 源索引没更新 → 先 apt update 再装一次（2026-10-30 用户手机实测踩到）
          if (ins.status !== 0 && /Unable to locate/i.test((ins.stderr || '').toString() + (ins.stdout || '').toString())) {
            onLog('软件源索引没更新，先 apt update（可能要一两分钟）…')
            const upd = await runCmd(apt, ['update'], RUN)
            if (upd.status === 0) {
              onLog('索引已更新，继续安装 python3-venv…')
              ins = await runCmd(apt, ['install', '-y', 'python3-venv'], RUN)
            }
          }
          if (ins.status === 0) {
            onLog('python3-venv 已装好，正在重新创建环境…')
            try { rmSync(venvDir, { recursive: true, force: true }) } catch { /* 清残留 */ }
            mk = await mkFirst()
            break
          }
        }
      }
      if (mk.status !== 0) {
        const detail2 = [
          mk.stderr && mk.stderr.toString().trim(),
          mk.stdout && mk.stdout.toString().trim(),
          mk.error && mk.error.message,
          '退出码 ' + mk.status,
        ].filter(Boolean).join(' | ') || '无任何输出'
        const hint = /ensurepip|python3-venv/i.test(detail2)
          ? '（人话：这台设备的 Python 缺 python3-venv 小部件，自动安装没成功。请在终端手动跑：apt install -y python3-venv 然后再试）'
          : ''
        throw new Error('创建 venv 失败：' + detail2 + hint)
      }
    }
    onLog('venv 已创建，正在安装依赖（首次约需 1-2 分钟，需联网）…')
    // 国内直连 PyPI 官方源经常慢到像卡死（手机上尤甚）→ 默认走清华镜像（海外也能用，只是稍慢）（2026-10-30）
    const PIP_MIRROR = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']
    const up = await runCmd(vp, ['-m', 'pip', 'install', '--upgrade', 'pip', ...PIP_MIRROR], {
      timeout: 180000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    if (up.status !== 0) {
      throw new Error('升级 pip 失败：' + ((up.stderr && up.stderr.toString()) || up.error?.message || ''))
    }
    const pin = await runCmd(vp, ['-m', 'pip', 'install', '-r', REQUIREMENTS, ...PIP_MIRROR], {
      timeout: 600000, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    })
    if (pin.status !== 0) {
      throw new Error('安装依赖失败（多半是没联网）：' + ((pin.stderr && pin.stderr.toString()) || pin.error?.message || ''))
    }
    onLog('依赖安装完成')
    _depCache.delete(vp) // 清缓存后重新认定 venv 可用
    if (!_hasDeps(vp)) throw new Error('依赖安装后导入仍失败，请查看日志')
    return vp
  })()
  try { return await _ensurePromise }
  finally { _ensurePromise = null }
}
