// 刷B站 MCP server（stdio）——把刷B站助手接进「任意支持 MCP 的 QQ 机器人」
//
// 适用：qq-bridge / SnowLuma、以及任何能跑 MCP stdio server 的宿主。
// 原理：这层只是「翻译」——把 MCP 工具调用转成门卫的 HTTP 请求：
//   POST http://127.0.0.1:8792/cmd  {action, args}   header: X-Bili-Token
// 门卫由插件本体提供（在「QQ 接入」页打开小门就会监听 8792），所以：
//   · 不需要另装任何服务；
//   · 口令自动从插件配置读，不用手工填（~/.dsh/bili-console/config.json 的 remoteToken）；
//   · 面板挂了也不影响（只走 /cmd，不依赖 8790）。
//
// 环境变量（都可选）：
//   BILI_CMD_URL  门卫地址，默认 http://127.0.0.1:8792
//   BILI_TOKEN    手动指定口令（不填则自动读配置）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.BILI_CMD_URL || 'http://127.0.0.1:8792').replace(/\/+$/, '');

function token() {
  if (process.env.BILI_TOKEN) return process.env.BILI_TOKEN;
  for (const p of [
    path.join(os.homedir(), '.dsh/bili-console/config.json'),          // DSH 插件模式
    path.join(os.homedir(), '.bili-console-app/bili-console/config.json'), // 独立版面板模式
    path.join(os.homedir(), 'bili-console/config.json'),               // 兜底
  ]) {
    try {
      const t = JSON.parse(fs.readFileSync(p, 'utf8')).remoteToken;
      if (t) return String(t);
    } catch {}
  }
  return '';
}

async function cmd(action, args = {}, timeoutMs = 60000) {
  const t = token();
  if (!t) throw new Error('找不到刷B站令牌：先去插件「QQ 接入」页打开小门（会自动生成口令），或设 BILI_TOKEN');
  const r = await fetch(`${BASE}/cmd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Bili-Token': t },
    body: JSON.stringify({ action, args }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch { throw new Error(`刷B站返回了非 JSON：${text.slice(0, 120)}`); }
  if (!d.ok) throw new Error(d.reply || `动作 ${action} 失败`);
  return d.reply || '';
}

function text(s) { return { content: [{ type: 'text', text: s }] }; }
function fail(e) { return { content: [{ type: 'text', text: `刷B站连不上：${e.message}` }], isError: true }; }

const server = new McpServer({ name: 'bili', version: '1.2.0' });

server.tool(
  'bili_status',
  '看刷B站分身的状态：B站登录了没、今天刷了几条、忙不忙。群友问「你在干嘛/刷B站了吗」或你想知道自己状态时用。',
  {},
  async () => { try { return text(await cmd('status', {}, 20000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_watched',
  '列出刷B站分身最近看过的视频（BV 号）。想跟人聊"最近看了啥"、要推荐时用；拿到 BV 号后自己拼 https://www.bilibili.com/video/<BV>。',
  {},
  async () => { try { return text(await cmd('watched', {}, 20000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_report',
  '看今天的刷B站日报（跑过一轮才有）。想看具体某个视频讲了什么时用。',
  {},
  async () => { try { return text(await cmd('report', {}, 20000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_comments',
  '看这个 B站账号最近发过的评论。',
  {},
  async () => { try { return text(await cmd('comments', {}, 20000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_login',
  '查 B站登录状态（掉了会告诉你怎么扫码）。',
  {},
  async () => { try { return text(await cmd('login', {}, 20000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_search',
  '在B站搜视频（按关键词）。群友说「去B站搜一下XX」「帮我找找XX的视频」时用；返回标题、BV号、UP主、播放量。拿到 BV 号可以自己拼 https://www.bilibili.com/video/<BV> 发给对方。只查不改，最安全。',
  { q: z.string().describe('搜索关键词，比如「猫」「Switch 维修」「AI」') },
  async ({ q }) => { try { return text(await cmd('search', { q: String(q || '') }, 60000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_like',
  '给指定的这一条B站视频点赞。群友丢来 BV 号或链接说「点个赞」时用；只动这一条，不会顺带评论或投币。',
  { bvid: z.string().describe('BV 号，或包含 BV 号的链接/整句') },
  async ({ bvid }) => { try { return text(await cmd('like', { bvid: String(bvid || '') }, 30000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_coin',
  '投币（2026-11-14 起不代投）：B站对投币要二级人机验证，插件过不了也不该去绕。调用它不会花任何硬币，只会把这条视频记进面板的「待手动投币」提醒，并把链接回给群友自己去投。',
  { bvid: z.string().describe('BV 号，或包含 BV 号的链接/整句') },
  async ({ bvid }) => { try { return text(await cmd('coin', { bvid: String(bvid || ''), from: 'qq' }, 30000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_triple',
  '对指定视频一键三连：点赞 + 收藏。投币不代投（B站要人机验证），会顺手记一笔「待手动投币」，回包里的币那格永远是❌——如实报，别当成功。只在群友明确说「三连」时用。',
  { bvid: z.string().describe('BV 号，或包含 BV 号的链接/整句') },
  async ({ bvid }) => { try { return text(await cmd('triple', { bvid: String(bvid || '') }, 60000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_comment',
  '给指定的这一条B站视频发一条评论。群友丢来 BV 号/链接说「你评论一句」「说点什么」时用；评论内容由你来写（像普通观众随口一句，别像官方稿）。只动这一条，不顺带点赞投币。',
  {
    bvid: z.string().describe('BV 号，或包含 BV 号的链接/整句'),
    text: z.string().describe('要发的评论正文，1~400 字'),
  },
  async ({ bvid, text: body }) => { try { return text(await cmd('comment', { bvid: String(bvid || ''), text: String(body || '').slice(0, 400) }, 60000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_run_round',
  '让刷B站分身现在去刷一轮（试跑模式，不会往B站发任何东西）。一轮要几分钟，一小时最多一两次，别连着调。',
  {},
  async () => { try { return text(await cmd('dry', {}, 300000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_wild',
  '让刷B站分身「为所欲为」野一轮：它自己想搜什么就去B站搜什么（自己出关键词，不用你给），也翻首页推荐流；真发评论、顺手点赞、还会发一条动态。投币不代投（B站人机验证）。这是真动作，会真的在B站发东西；一轮要几分钟，别连着调。只想预览不发就用 bili_run_round（试跑）。',
  {},
  async () => { try { return text(await cmd('wild', {}, 300000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_post_dynamic',
  '用这个B站账号发一条图文动态（纯文字）。群友明确让「发个动态说XX」时才用；这是真动作，会真的发出去。文本由你写好再传进来。',
  { text: z.string().describe('动态正文，最多 800 字') },
  async ({ text: dynText }) => { try { return text(await cmd('dynamic', { text: String(dynText || '').slice(0, 800) }, 120000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_stop',
  '停掉正在跑的那一轮刷B站。',
  {},
  async () => { try { return text(await cmd('stop', {}, 20000)); } catch (e) { return fail(e); } },
);

server.tool(
  'bili_help',
  '列出刷B站分身支持的全部动作（含发动态、审核、自动投稿等进阶操作）。',
  {},
  async () => { try { return text(await cmd('help', {}, 20000)); } catch (e) { return fail(e); } },
);

const transport = new StdioServerTransport();
await server.connect(transport);
