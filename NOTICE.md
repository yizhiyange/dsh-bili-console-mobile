# NOTICE

## dsh-bili-console

本插件的编排、章程（prompts/duty.md）、双模控制台界面、状态机与风控逻辑
均为本项目原创，以 MIT 协议发布。

- 作者 / 版权所有：一只炎鸽（B站 @一只炎鸽，GitHub @yizhiyange）
- 调试用的小号：呆毛潜水艇（仅用于跑通流程、验证 @ 通知是否真的送达）

## 致谢与第三方组件

### bilibili-mcp（vendor/bilibili-mcp/）

- 来源：AGI_Ananas 的 bilibili-mcp 项目
- 协议：MIT（完整许可见 vendor/bilibili-mcp/LICENSE）
- 用途：本插件通过它提供的 Python MCP Server 与 B站 开放接口通信
  （登录、搜索、字幕、评论、私信等 27 个工具）
- 说明：它是本插件使用的**基础能力库**，不是本插件的上位依赖；
  本插件不依赖任何其它 DSH 插件的代码
- **上游修改声明**：随包分发的 mcp_server.py 在上游基础上做了追加——
  新增 bili_comment_delete（撤回自己的评论）、bili_audio_url（取音频流供本地转写）、
  bili_favorite_add（收藏），并扩展了 bili_reply；这些改动同样以 MIT 发布，
  与上游差异以本仓库版本为准。

### dsh-bili-scroll（client.js 加载骨架的起点）

- 来源：c1overzz 的 dsh-bili-scroll 项目（https://github.com/c1overzz/dsh-bili-scroll）
- 协议：MIT（其包内随附 LICENSE）
- 说明：本插件 `client.js` 的 DSH 面板加载骨架（`window.__ModuleLoader__.load`
  挂载方式与设置页注入约定）最初复制自该项目，其后大幅重写——
  现文件约 1000 行，与原版逐行重叠不足 5%。
  依据 MIT 要求，在此保留其版权与许可声明。

### bilibili-api-python

- vendor/bilibili-mcp 的底层依赖（见 vendor/bilibili-mcp/requirements.txt）
- 协议：MIT

### DSH / DeepSeek Harness

- 本插件是 DSH 生态的插件，运行所需的宿主能力由 DSH 提供

## 合规声明

- 本插件只在用户自己的账号、以用户自己的配置下执行用户授权的操作
- 默认保守：不登录、不支付、不转发私信；风控码命中自动冷却
- 使用本插件产生的一切行为由使用者自行承担；请遵守 B站 用户协议
