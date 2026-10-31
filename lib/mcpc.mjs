/**
 * lib/mcpc.mjs —— 最小的 MCP stdio 客户端（只够我们用的那点）
 * ============================================================================
 * 为什么自己写：vendor/bilibili-mcp 是 FastMCP(stdio) 服务，bilibili-api 的
 * 登录态、二维码都绑在**同一个进程**里（bili_login_check 要 poll 同一个会话）。
 * 所以不能每调一次工具就新开进程——登录轮询必须复用同一进程。
 *
 * 它做什么：
 *   - spawn python mcp_server.py，完成 JSON-RPC initialize 握手
 *   - callTool(name, args) → 等回包，按 id 配对
 *   - 进程崩了自动重启（重启后握手重来），**绝不让一次子进程崩拖死插件**
 *
 * 设计纪律（和 hostdeps 一样）：任何一步失败都降级返回，绝不向上抛未捕获异常。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SELF_DIR = dirname(fileURLToPath(import.meta.url))
const SERVER_PY = join(SELF_DIR, '..', 'vendor', 'bilibili-mcp', 'mcp_server.py')

/** 我们实际放开的工具白名单——跟 security review 的"真闸门"思路一致 */
export const ALLOWED_TOOLS = [
  'bili_login', 'bili_login_check', 'bili_check_credential',
  'bili_search', 'bili_video_info', 'bili_subtitle', 'bili_comments', 'bili_danmaku',
  'bili_reply', 'bili_comment_delete', 'bili_send_message', 'bili_unread_messages',
  'bili_received_replies', 'bili_user_info',
  'bili_favorite_add', 'bili_favorite_lists', 'bili_audio_url',
  // 发动态 / 发视频（2026-10-31 新增，上层自己写的发布能力）
  'bili_send_dynamic', 'bili_upload_video', 'bili_upload_video_multi',
  'bili_send_opus', 'bili_video_zones',
]

export class BiliMcp {
  /**
   * @param {{python:string, env?:Record<string,string>}} opt
   */
  constructor({ python, env = {} }) {
    this.python = python
    this.extraEnv = env
    this.child = null
    this.seq = 0
    this.pending = new Map()
    this.buffer = ''
    this.ready = false
    this.started = false
    this.dying = false
  }

  static serverExists() { return existsSync(SERVER_PY) }

  _spawn() {
    if (!existsSync(this.python)) throw new Error(`python 不存在：${this.python}`)
    if (!existsSync(SERVER_PY)) throw new Error(`mcp_server.py 不在预期位置：${SERVER_PY}`)
    const child = spawn(this.python, [SERVER_PY], {
      env: {
        ...process.env,
        ...this.extraEnv,
        BILI_MCP_TOOLS: ALLOWED_TOOLS.join(','),
        PYTHONIOENCODING: 'utf-8',
        PYTHONUNBUFFERED: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stdin.setDefaultEncoding('utf-8')
    child.stdout.setEncoding('utf-8')
    child.stdout.on('data', (chunk) => this._onData(chunk))
    child.stderr.on('data', () => { /* 日志丢弃，不进协议流 */ })
    child.on('exit', (code) => this._onExit(code))
    child.on('error', () => this._failAll(new Error('子进程启动失败')))
  }

  _onData(chunk) {
    this.buffer += chunk
    let nl
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim()
      this.buffer = this.buffer.slice(nl + 1)
      if (!line || !line.startsWith('{')) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      this._dispatch(msg)
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    // 通知（无 id）直接忽略
  }

  _onExit() {
    this.ready = false
    this.started = false
    const err = new Error('MCP 子进程已退出')
    this._failAll(err)
    this.child = null
  }

  _failAll(err) {
    for (const { reject } of this.pending.values()) { try { reject(err) } catch { /* noop */ } }
    this.pending.clear()
  }

  /** 底层发送：直接写 stdin + 等回包，不做就绪守卫（握手阶段用它，避免和 _ensureStarted 互递归） */
  _sendRaw(method, params) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} }) + '\n'
      try { this.child.stdin.write(payload) }
      catch (e) { this.pending.delete(id); reject(e) }
    })
  }

  async _request(method, params) {
    if (!this.child || !this.ready) await this._ensureStarted()
    return this._sendRaw(method, params)
  }

  async _ensureStarted() {
    if (this.ready) return
    if (this.dying) throw new Error('客户端正在关闭')
    // 已经在启动中：等它完成即可，避免重入导致无限 spawn 子进程
    if (this.starting) {
      while (!this.ready && !this.dying) { await new Promise(r => setTimeout(r, 20)) }
      return
    }
    this.starting = true
    try {
      this._spawn()
      // 握手（用底层发送，不走 _request 的就绪守卫，否则会互递归）
      await this._sendRaw('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'bili-console', version: '0.1.0' },
      })
      // 初始化完成通知（不需要回包）
      try { this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n') } catch { /* noop */ }
      this.ready = true
      this.started = true
    } finally {
      this.starting = false
    }
  }

  /** 调一个工具，返回 result（含 content 数组）；失败抛错 */
  async callTool(name, args = {}) {
    const res = await this._request('tools/call', { name, arguments: args })
    return res
  }

  /** 调工具并把 text 内容拼成字符串返回（我们的工具几乎都返回 text JSON） */
  async callText(name, args = {}) {
    const res = await this.callTool(name, args)
    const parts = Array.isArray(res?.content) ? res.content : []
    return parts.map((p) => (p?.type === 'text' ? p.text : '')).join('')
  }

  /** 关掉（登录流程用完后显式回收，避免进程常驻） */
  close() {
    this.dying = true
    try { this.child?.kill('SIGTERM') } catch { /* noop */ }
    this.child = null
    this.ready = false
    this.dying = false
  }
}
