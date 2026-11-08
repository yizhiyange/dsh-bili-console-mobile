/**
 * 回归：DSH 会话推送走「本机网页接口」这条真路径。
 * 用假的 .credentials.yaml + 假的 fetch，不发真请求、不碰真 DSH。
 */
import { pushToDshSession, buildReportPrompt } from './lib/dshsession.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'bcdsh-'))
const home = join(tmp, 'bili-console')
mkdirSync(home)
const secret = Buffer.alloc(32, 7).toString('base64url')
writeFileSync(join(tmp, '.credentials.yaml'), [
  'version: 1', 'records:', '  client-connection/browser-session:',
  '    kind: grant', '    payload:', '      version: 1',
  '      secret: ' + secret, '',
].join('\n'))

const ctx = {
  get: (n) => n === 'webServer' ? { getOrigin: () => 'http://127.0.0.1:12345' } : null,
}
let calls = []
let listItems = [{ sessionId: 'bili-console-old', blank: false }]
let status = 200
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body)
  calls.push({ url, body, cookie: init.headers.cookie })
  if (status !== 200) return { status, ok: false, json: async () => ({}) }
  let value = {}
  if (body.method === 'session/list') value = { items: listItems }
  if (body.method === 'session/create') value = { sessionId: 'bili-console-new' }
  return {
    status: 200, ok: true,
    json: async () => ({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }),
  }
}

let fail = 0
const ok = (cond, msg) => { console.log((cond ? '✓ ' : '✗ ') + msg); if (!cond) fail++ }

// ① 正常发送：拿到地址、铸 Cookie、复用已有会话、发 content
calls = []
const r1 = await pushToDshSession(ctx, { home, text: '这一轮刷了 3 条', cwd: home })
ok(r1.ok === true, '发送成功')
ok(r1.sessionId === 'bili-console-old', '复用了已存在的空白会话：' + r1.sessionId)
ok(calls.every((c) => c.url.startsWith('http://127.0.0.1:12345/api/')), '请求都发到 webServer.getOrigin() 给的本机地址')
ok(calls.every((c) => /^dsh-auth-[A-Za-z0-9_-]+=v1\./.test(c.cookie)), '每个请求都带了离线铸造的会话 Cookie')
const listCall = calls.find((c) => c.body.method === 'session/list')
ok(!!listCall && '_request' in listCall.body.payload.args, 'session/list 用 _request 包装')
const promptCall = calls.find((c) => c.body.method === 'session/prompt')
ok(!!promptCall, '调用了 session/prompt')
const req = promptCall && promptCall.body.payload.args.request
ok(!!req && Array.isArray(req.content) && req.content[0].text === '这一轮刷了 3 条', '消息内容字段是 content（不是 prompt）')
ok(!!req && req.mode === 'queue' && typeof req.requestId === 'string' && req.requestId.length > 10, '带 mode=queue 和 requestId')
ok(!calls.some((c) => c.body.method === 'session/create'), '有现成会话时不乱新建')

// ② 没有可用会话时才新建，并记住会话编号
calls = []
listItems = []
const r2 = await pushToDshSession(ctx, { home, text: '第二轮' })
ok(r2.ok === true && r2.sessionId === 'bili-console-new', '没有现成会话时新建：' + (r2.sessionId || ''))
ok(calls.some((c) => c.body.method === 'session/create'), '确实调了 session/create')
const createReq = calls.find((c) => c.body.method === 'session/create').body.payload.args.request
ok('cwd' in createReq && !('workspaceId' in createReq), 'create 只给 cwd，不同时给 workspaceId（DSH 会拒）')

// ③ 安全：非回环地址一律不发
calls = []
const r3 = await pushToDshSession(ctx, { home, text: 'x', baseUrl: 'http://example.com:1234' })
ok(r3.ok === false && r3.stage === 'origin' && calls.length === 0, '外网地址直接拒绝，一个请求都不发')

// ④ 独立 APK 里没有 DSH：给人话而不是崩
const r4 = await pushToDshSession({ get: () => null }, { home, text: 'x' })
ok(r4.ok === false && /独立版|没有 DSH/.test(r4.error || ''), '没有 webServer 时说清「这里用不了」：' + r4.error)

// ⑤ 401：凭证失效要给人话，且不能把密钥/Cookie 回传
status = 401
const r5 = await pushToDshSession(ctx, { home, text: 'x' })
ok(r5.ok === false && /拒绝了登录凭证/.test(r5.error || ''), '401 时提示重启 DSH：' + r5.error)
ok(!JSON.stringify(r5).includes(secret), '返回内容里没有密钥')
status = 200

// ⑥ 空内容 / 提示词
const r6 = await pushToDshSession(ctx, { home, text: '   ' })
ok(r6.ok === false && r6.stage === 'input', '空内容直接拒绝')
ok(/不要调用任何工具/.test(buildReportPrompt(['搜到 1 条'])), '自动汇报提示词要求 AI 别动工具')

rmSync(tmp, { recursive: true, force: true })
console.log(fail ? `\n失败 ${fail} 项` : '\n全部通过')
process.exit(fail ? 1 : 0)
