/**
 * selfupdate.mjs —— 一键自更新（下载 → 解压 → 替换文件，全程带进度）
 * ============================================================================
 * 为什么要有它：DSH 应用本身没有插件更新功能，用户又是手机党，
 *              让人手动下 zip 再导入太麻烦——所以点一下，插件自己把自己换新。
 *
 * 流程：GitHub 打包下载（多源自动切换）→ 内存解压 → 写入临时目录 →
 *       逐个搬到插件目录 → 提示"重启 DSH 生效"。
 *
 * 五条铁律：
 *   ① 绝不阻塞 —— 全程异步。插件挂在宿主 webServer 上，任何同步大 IO 都会冻死界面。
 *   ② 绝不动用户数据 —— 只写压缩包里有的文件，绝不删除现有文件；
 *      config.json / seen.md / out/ 这些数据文件不在包里，天然安全。
 *   ③ 先暂存再搬运 —— 先写进插件目录里的 .update-stage/，全部成功后再逐个 rename；
 *      rename 不跨盘、原子性最好，中途失败也只影响单个文件。
 *   ④ 进度只放内存 —— /state 每 2 秒轮询一次，snapshot 必须是纯内存读。
 *   ⑤ 同一时间只允许一个更新任务。
 * ============================================================================
 */
import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { REPO } from './version.mjs'

const BRANCH = 'main'
/** 单个源下载超时：2 分钟（包 ~200KB，手机网络慢也要给够） */
const DOWNLOAD_TIMEOUT_MS = 120000
/** 压缩包的预估大小（没有 Content-Length 时拿来估算进度条）：220KB */
const EXPECT_BYTES = 220 * 1024

/**
 * 下载源，按优先级排。codeload 是 GitHub 官方打包接口（最快），
 * 但加速站不认它（实测 403），所以后面放 github.com/archive 形式的加速版本。
 */
function sourcesFor(custom) {
  const official = [
    `https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`,
    `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`,
  ]
  const acc = [
    `https://ghfast.top/https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`,
    `https://gh-proxy.com/https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`,
  ]
  const list = [...official, ...acc]
  // 用户自定义：可以是完整 zip 地址，也可以是代理前缀
  const c = String(custom || '').trim()
  if (c) list.unshift(/^https?:\/\//i.test(c) ? c : `https://${c.replace(/^\/+/, '')}/https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip`)
  return list
}

/* ── 任务状态（纯内存，/state 轮询直接读） ─────────────────────── */
let job = null

export function selfUpdateSnapshot() {
  if (!job) return { phase: 'idle', running: false }
  return { ...job, running: !job.done && !job.error }
}

/**
 * 发起一次自更新。
 * @param {object} opts
 * @param {string} opts.pluginDir 插件代码目录（index.js 所在目录）
 * @param {string} opts.custom    自定义代理前缀/地址（可选）
 * @returns {{ok:boolean, error?:string}}
 */
export function startSelfUpdate({ pluginDir, custom } = {}) {
  if (job && !job.done && !job.error) return { ok: false, error: '已经有一个更新在跑了，等它结束' }
  if (!pluginDir || !existsSync(pluginDir)) return { ok: false, error: '找不到插件安装目录，这个环境不支持一键更新，请手动导入安装包' }
  job = { phase: '下载中', pct: 0, downloaded: 0, total: 0, msg: '正在连接 GitHub…', error: '', done: false, startedAt: Date.now(), finishedAt: 0 }
  // 异步跑，绝不等它——接口立刻返回，进度靠 /state 轮询
  run(pluginDir, custom).catch(() => {})
  return { ok: true }
}

async function run(pluginDir, custom) {
  const stage = join(pluginDir, '.update-stage')
  try {
    /* ① 下载 */
    const zip = await downloadArchive(custom)

    /* ② 内存解压 */
    job.phase = '解压中'; job.msg = '正在解开压缩包…'; job.pct = 96
    const entries = readZip(zip)
    if (!entries.length) throw new Error('压缩包是空的')

    /* ③ 写入暂存目录（先不碰现有文件） */
    job.phase = '写入中'; job.msg = '正在准备新文件…'; job.pct = 97
    rmSync(stage, { recursive: true, force: true })
    const rels = []
    for (const { rel, data } of entries) {
      const target = join(stage, rel)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, data)
      rels.push(rel)
    }

    /* ④ 逐个搬进插件目录（rename 同盘原子操作，成功的就生效） */
    let moved = 0
    for (let i = 0; i < rels.length; i++) {
      const rel = rels[i]
      const from = join(stage, rel)
      const to = join(pluginDir, rel)
      mkdirSync(dirname(to), { recursive: true })
      try { renameSync(from, to); moved++ } catch { /* 单个失败不致命，先跳过 */ }
      job.pct = 97 + Math.round((i + 1) / rels.length * 3)
      job.msg = `正在替换文件 ${i + 1}/${rels.length}…`
    }
    rmSync(stage, { recursive: true, force: true })
    job.phase = '完成'; job.done = true; job.pct = 100
    job.msg = `已更新 ${moved}/${rels.length} 个文件，重启 DSH（退出重进）后生效`
  } catch (e) {
    job.error = String((e && e.message) || e)
    job.msg = '更新失败：' + job.error
    try { rmSync(stage, { recursive: true, force: true }) } catch {}
  }
}

/* ── 下载（流式，边下边报进度） ───────────────────────────────── */
async function downloadArchive(custom) {
  const tried = []
  for (const url of sourcesFor(custom)) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => { try { ctrl.abort() } catch {} }, DOWNLOAD_TIMEOUT_MS)
    try {
      job.msg = '正在下载：' + new URL(url).host + '…'
      const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'dsh-bili-console/selfupdate' } })
      if (!r || !r.ok || !r.body) { tried.push(url + ' → HTTP ' + (r ? r.status : '无响应')); continue }
      const total = Number(r.headers.get('content-length') || 0)
      job.total = total
      const chunks = []
      let downloaded = 0
      let first = true
      for await (const chunk of r.body) {
        const b = Buffer.from(chunk)
        if (first) {
          first = false
          if (!(b[0] === 0x50 && b[1] === 0x4b)) { tried.push(url + ' → 返回的不是 zip'); break } // 'PK'
        }
        chunks.push(b); downloaded += b.length
        job.downloaded = downloaded
        job.pct = total ? Math.min(95, Math.round(downloaded / total * 95))
          : Math.min(95, Math.round(downloaded / EXPECT_BYTES * 95))
        job.msg = '正在下载…已 ' + (downloaded / 1024).toFixed(0) + ' KB' + (total ? (' / ' + (total / 1024).toFixed(0) + ' KB') : '')
      }
      if (first) { tried.push(url + ' → 空响应'); continue }
      return Buffer.concat(chunks)
    } catch (e) {
      tried.push(url + ' → ' + String((e && e.message) || e))
    } finally { clearTimeout(timer) }
  }
  throw new Error('所有下载源都失败了：' + tried.join('；'))
}

/* ── 极简 ZIP 读取器（只支持 GitHub 打包的方式：store + deflate） ──
   Node 没有内置 unzip，而手机上未必有 unzip 命令，所以自己写一个。
   只需要读懂"中央目录 → 定位每个文件 → inflateRaw"，~60 行搞定。 */
function readZip(buf) {
  // ① 从尾部找 End of Central Directory（注释最长 64KB）
  let eocd = -1
  const floor = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('下载的内容不是有效 zip 包')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)

  // ② 包内所有路径都带一个顶层前缀（如 "dsh-bili-console-mobile-main/"），先探出来
  let prefix = ''
  {
    const probe = buf.readUInt32LE(off) === 0x02014b50 ? buf.slice(off + 46, off + 46 + buf.readUInt16LE(off + 28)).toString('utf8') : ''
    const slash = probe.indexOf('/')
    if (slash > 0) prefix = probe.slice(0, slash + 1)
  }

  /* ③ 逐条解析 */
  const out = []
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip 目录损坏')
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nameLen = buf.readUInt16LE(off + 28)
    const extraLen = buf.readUInt16LE(off + 30)
    const cmtLen = buf.readUInt16LE(off + 32)
    const localOff = buf.readUInt32LE(off + 42)
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8')
    off += 46 + nameLen + extraLen + cmtLen

    if (name.endsWith('/')) continue                       // 目录条目
    let rel = prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name
    if (!rel || rel.startsWith('.git/') || rel === '.git' || rel.includes('..')) continue // 只换代码，不碰别的东西

    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('zip 数据损坏：' + name)
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.slice(dataStart, dataStart + compSize)
    let data
    if (method === 0) data = raw
    else if (method === 8) data = inflateRawSync(raw)
    else throw new Error('不认识的压缩方式 ' + method + '（' + name + '）')
    out.push({ rel, data })
  }
  return out
}
