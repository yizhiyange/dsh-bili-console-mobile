# AstrBot 适配器

把刷B站助手接进 AstrBot——AI 能看「自己刷到了什么」、能搜视频，也能被命令去野一轮。

## 装

1. 把**这个文件夹**（`astrbot/`）整个复制到 AstrBot 的插件目录：
   ```
   <AstrBot>/data/plugins/astrbot_plugin_bili_bridge/
   ```
   （文件夹名建议保持 `astrbot_plugin_bili_bridge`，和 metadata 一致。）
2. 重启 AstrBot（或在 WebUI 里重载插件）。
3. 到 AstrBot 的「插件配置」里填 **token**（面板「QQ 接入」页抄来的口令）。
   - `api_base` 默认 `http://127.0.0.1:8792`，同机不用改；机器人装在别的机器就改成局域网地址。
   - `panel_base` 默认 `http://127.0.0.1:8790/api/bili-console`（拿原始数据用，可不管）。

## 它给 AI 加了什么

- `bili_status`：看助手状态（登录没、今天刷了几条、忙不忙、有没有被风控冷却）
- `bili_recent_feed`：最近刷到的视频（带可点链接）+ 发出去的评论
- `bili_run_round`：命令助手现在去刷一轮

另外两个可选功能（配置里默认关）：

| 配置 | 作用 |
|---|---|
| `shareOn` / `shareGroups` / `shareEveryMin` | 刷到新视频后主动甩进群（默认关） |
| `autoBrushOn` / `brushEveryMin` | 到点让助手自己刷一轮攒「见闻」（默认关） |

「见闻」是怎么用的：助手每刷到一条视频，就把「标题 + 链接」记进插件的 `notes.md`，AI 开口前把最近几条塞进 system prompt——聊到相关话题时它自然想得起来，像真人刷到过一样。

## 要求

- 纯 Python 标准库，**没有额外依赖**（`requirements.txt` 是空的）。
- 门卫要在跑：面板「QQ 接入」→ 打开小门。
- 想让它能「发」东西（野一轮/发动态），把「只看不干」关掉。
