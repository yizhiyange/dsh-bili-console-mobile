/**
 * envjob.mjs —— 一键安装运行环境（Python / 依赖 / 转写后端），带进度与日志
 * ============================================================================
 * 为什么要它：光"检测"没用——用户看到「待安装」却不知道怎么办，手机上更没法敲命令。
 *             所以给按钮：点一下它自己去装，装到哪一步、报什么错，全在界面上看得见。
 *
 * 三种任务（kind）：
 *   python —— 系统里压根没有 python3（只对 Linux/安卓容器，走 apt 装 python3 + python3-venv）
 *   deps   —— 有 Python 但缺依赖（建 venv + pip 装 requirements，复用 ensureVenv）
 *   asr    —— 装转写后端 faster-whisper（+ 尽量补 ffmpeg）
 *
 * 铁律：
 *   ① 全程异步，绝不 spawnSync（插件挂在宿主进程上，同步跑几分钟会把界面冻死）
 *   ② 同一时间只允许一个安装任务
 *   ③ 进度纯内存读（/state 每 2 秒轮询），日志只留最近 60 行
 *   ④ 装完必须清探测缓存，否则界面还显示"没装"
 * ============================================================================
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ensureVenv, venvPython, findBasePython, venvStatus, clearDepCache, REQUIREMENTS } from './pyenv.mjs'
import { resetAsrCache } from './asr.mjs'

const run = promisify(execFile)
const PIP_MIRROR = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']
const OPTS = {
  timeout: 900000, windowsHide: true,
  env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive', PYTHONIOENCODING: 'utf-8', PIP_NO_INPUT: '1' },
}

let job = null

/** 给 /state 用的纯内存快照（不许联网、不许读盘） */
export function envJobSnapshot() {
  if (!job) return { phase: 'idle', running: false }
  return {
    kind: job.kind, phase: job.phase, pct: job.pct,
    log: (job.log || []).slice(-12),
    done: job.done, error: job.error, running: !job.done && !job.error,
    startedAt: job.startedAt, finishedAt: job.finishedAt,
  }
}

function push(line) {
  if (!job) return
  const t = new Date().toTimeString().slice(0, 8)
  job.log.push('[' + t + '] ' + String(line).split('\n')[0].slice(0, 200))
  if (job.log.length > 60) job.log.splice(0, job.log.length - 60)
}

/**
 * 发起安装任务。
 * @param {{kind:'python'|'deps'|'asr', cfg?:object, home:string}} opts
 */
export function startEnvJob({ kind, cfg = {}, home = '' } = {}) {
  if (job && !job.done && !job.error) return { ok: false, error: '已经有一个安装任务在跑了，等它结束' }
  if (!['auto', 'python', 'deps', 'asr'].includes(kind)) return { ok: false, error: '不认识的任务：' + kind }
  if (kind !== 'python' && !home) return { ok: false, error: '插件家目录没确定，无法安装' }
  job = { kind, phase: '准备中', pct: 2, log: [], done: false, error: '', startedAt: Date.now(), finishedAt: 0 }
  push('开始：' + ({ auto: '一键装好运行环境', python: '安装 Python', deps: '安装 Python 依赖', asr: '安装转写后端' }[kind] || kind))
  runJob(kind, cfg, home).then(() => {
    if (!job.error) { job.done = true; job.pct = 100; job.phase = '完成'; job.finishedAt = Date.now(); push('全部完成 ✓') }
  }).catch((e) => {
    job.error = String((e && e.message) || e)
    job.phase = '失败'
    job.finishedAt = Date.now()
    push('失败：' + job.error)
  })
  return { ok: true }
}

async function runJob(kind, cfg, home) {
  // auto = 一条龙：先把 Python 弄好（缺的话），再装依赖
  if (kind === 'auto') { job.phase = '检查 Python'; await installPython(); job.pct = 12; return await installDeps(cfg, home) }
  if (kind === 'python') return await installPython()
  if (kind === 'deps') return await installDeps(cfg, home)
  if (kind === 'asr') return await installAsr(cfg, home)
}

/* ── ① 装 Python 本体 ──────────────────────────────────────── */
async function installPython() {
  job.phase = '检查现有 Python'
  if (findBasePython()) { push('已经有可用的 Python，不需要装'); return }
  if (process.platform === 'win32') {
    throw new Error('Windows 上没法替你静默安装 Python：请到 python.org 下载安装，装的时候务必勾选 “Add Python to PATH”，装完回这里点「重新检测」')
  }
  if (process.platform === 'darwin') {
    throw new Error('macOS 上请先装 Python：终端跑 brew install python3（没有 Homebrew 就去 python.org 下安装包）')
  }
  // Linux / 安卓容器（proot、Termux 有 apt 的发行版）
  const pkgs = ['python3', 'python3-venv', 'python3-pip']
  let lastErr = ''
  for (const apt of ['apt-get', 'apt']) {
    try {
      job.phase = '安装 Python（' + apt + '）'
      job.pct = 20
      push('正在用 ' + apt + ' 安装 ' + pkgs.join(' ') + '（可能要一两分钟）…')
      let r = await run(apt, ['install', '-y', ...pkgs], OPTS).catch((e) => e)
      let out = String((r && r.stdout) || '') + String((r && r.stderr) || '')
      if (r && r.code !== 0 && /Unable to locate|Could not get lock|not found/i.test(out)) {
        push('软件源索引可能没更新，先 apt update…')
        job.pct = 35
        await run(apt, ['update'], OPTS).catch(() => {})
        push('索引更新完，重新安装…')
        r = await run(apt, ['install', '-y', ...pkgs], OPTS).catch((e) => e)
        out = String((r && r.stdout) || '') + String((r && r.stderr) || '')
      }
      job.pct = 70
      if (findBasePython()) {
        clearDepCache()
        push('Python 装好了：' + findBasePython())
        return
      }
      lastErr = out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 180)
    } catch (e) { lastErr = String((e && e.message) || e).slice(0, 180) }
  }
  throw new Error('没能自动装上 Python（' + (lastErr || '系统里没有 apt') + '）。可以手动在终端跑：apt install -y python3 python3-venv')
}

/* ── ② 装依赖（建 venv + pip） ─────────────────────────────── */
async function installDeps(cfg, home) {
  job.phase = '准备环境'
  job.pct = 8
  if (!findBasePython()) {
    throw new Error('还没有 Python——先点「自动安装 Python」，或在终端装一个 python3')
  }
  push('开始建 venv 并安装依赖（首次约 1-2 分钟，需联网）…')
  job.phase = '建 venv / pip 安装'
  job.pct = 20
  await ensureVenv(cfg, home, (line) => { push(line); job.pct = Math.min(90, job.pct + 6) })
  job.pct = 92
  clearDepCache()
  const st = venvStatus(home)
  if (!st.venvReady && !st.baseWithDeps) throw new Error('依赖装完了但 import 还是失败，请看上面的日志（常见：没网 / pip 源被墙）')
  push('依赖就绪：' + (st.venvReady ? st.venvPath : st.baseWithDeps))
}

/* ── ③ 装转写后端 ──────────────────────────────────────────── */
async function installAsr(cfg, home) {
  job.phase = '准备 Python 环境'
  job.pct = 8
  if (!findBasePython()) throw new Error('还没有 Python——先装 Python 再来装转写后端')
  push('先确保基础依赖就绪…')
  const py = await ensureVenv(cfg, home, (line) => push(line))
  clearDepCache()

  job.phase = '安装 faster-whisper'
  job.pct = 40
  push('正在 pip install faster-whisper（体积不小，几分钟正常）…')
  const r = await run(py, ['-m', 'pip', 'install', '--disable-pip-version-check', 'faster-whisper', ...PIP_MIRROR], OPTS).catch((e) => e)
  const out = String((r && r.stdout) || '') + String((r && r.stderr) || '')
  if (r && r.code !== 0) {
    throw new Error('faster-whisper 装失败（' + (out.split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 160) || '未知原因') + '）。可以改用云端转写，或手动 pip install faster-whisper')
  }
  job.pct = 80

  // ffmpeg：转写要它解音频。自带就用，没有就尽量装
  job.phase = '检查 ffmpeg'
  const hasFf = await run('ffmpeg', ['-version'], { timeout: 8000 }).then(() => true).catch(() => false)
  if (hasFf) push('ffmpeg 已有')
  else if (process.platform === 'linux') {
    push('没 ffmpeg，正在用 apt 装（可能需要一会儿）…')
    const a = await run('apt-get', ['install', '-y', 'ffmpeg'], OPTS).catch((e) => e)
    if (a && a.code === 0) push('ffmpeg 装好了')
    else push('ffmpeg 没装上 —— 转写会失败，可以在终端手动：apt install -y ffmpeg')
  } else {
    push('没检测到 ffmpeg —— Windows 请下载 ffmpeg 并加入 PATH')
  }

  job.pct = 95
  resetAsrCache()
  push('转写后端已就绪（首次转写会自动下载模型，要等一会儿）')
}
