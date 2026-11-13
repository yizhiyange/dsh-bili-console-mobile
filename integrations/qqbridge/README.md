# MCP 适配器（qq-bridge / SnowLuma / 任意 MCP 宿主）

`mcp-bili.js` 是个 **stdio MCP server**：宿主（qq-bridge、SnowLuma、Claude Desktop、任何 MCP 客户端）调它的工具，它就转成门卫的 HTTP 请求。

```
QQ 群消息 → 你的机器人（LLM） → MCP 工具 → 本适配器 → 门卫 8792 → 刷B站插件
```

## 装

```bash
cd integrations/qqbridge
npm install
```

然后在宿主里把这个 server 加进去（各家写法不同，本质都是「命令 + 参数」）：

```json
{
  "mcpServers": {
    "bili": {
      "command": "node",
      "args": ["/绝对路径/integrations/qqbridge/mcp-bili.js"]
    }
  }
}
```

**口令不用填**：适配器会自动读插件配置里的 `remoteToken`（依次找 `~/.dsh/bili-console/config.json`、`~/.bili-console-app/bili-console/config.json`、`~/bili-console/config.json`）。只有跨机器部署时才需要设环境变量：

| 环境变量 | 说明 |
|---|---|
| `BILI_CMD_URL` | 门卫地址，默认 `http://127.0.0.1:8792`；跨机器时填 `http://<插件那台机器的局域网IP>:8792` |
| `BILI_TOKEN` | 手动指定口令（一般不填） |

## 它暴露的工具（11 个）

| 工具 | 用途 |
|---|---|
| `bili_status` | 登录没 / 今天刷了几条 / 忙不忙 |
| `bili_watched` | 最近刷过的视频（BV 号） |
| `bili_report` | 今天的日报 |
| `bili_comments` | 最近发过的评论 |
| `bili_login` | 查登录状态 |
| `bili_search` | **按关键词搜 B站 视频**（群友说「去搜一下XX」） |
| `bili_run_round` | 试跑一轮（只挑不发） |
| `bili_wild` | **为所欲为野一轮**（真评论+点赞+投币+发动态） |
| `bili_post_dynamic` | 发一条图文动态 |
| `bili_stop` | 停掉正在跑的那一轮 |
| `bili_help` | 列出全部动作 |

## 注意

- 工具**说明文字（docstring）很重要**：宿主是靠它判断"什么时候该用哪个工具"。想让它更保守/更主动，改 docstring 就行。
- 写动作（wild / post_dynamic / run）在面板开着「只看不干」时会被门卫拒绝——这是故意的。
- 野一轮要几分钟，工具超时设的是 5 分钟；别连续调。
