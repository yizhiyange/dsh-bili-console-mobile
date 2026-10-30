# ARCHITECTURE · dsh-bili-console 架构

一句话：**一个 npm 包，两副面孔**——宿主侧（index.js）挂进 DSH 的 webServer/tools/settings，
客户端侧（client.js）画在 DSH 的设置界面里；网页控制台（web/console.html）由插件自己通过
webServer 提供。用户只需要装一个包。

## 包结构

```
dsh-bili-console/
├── package.json          # npm 包 + DSH 清单（dsh.bundle.patch / dsh.client.inject）
├── cordis.patch.yml      # bundle 挂载声明（insert: bili-console）
├── index.js              # 宿主侧：网页 API / 后台调度（轮次 + 私信监察）/ 设置读取
├── client.js             # DSH 客户端侧：防御式探测设置 API，挂"打开网页控制台"+常用开关
├── prompts/duty.md       # 值班章程（AI 每一轮的指令，人设从这里进脑子）
├── lib/
│   ├── state.mjs         # 插件"家"：config（含 models/chainOrder/visionModel）/ state / seen / out / log
│   ├── persona.mjs       # 人设解析：文本框直填，或填一个 AGENTS.md 路径（≤8000 字）
│   ├── guardian.mjs      # 风控规则库：风控码表、分级处置、冷却状态（落盘）
│   ├── mcpc.mjs          # 极简 MCP stdio 客户端（拉起 vendor/bilibili-mcp，登录轮询复用同进程）
│   ├── bili.mjs          # B站 高层封装：登录会话 / 搜 / 字幕 / 评论 / 私信 / 凭证同步
│   ├── chain.mjs         # 模型降级链：端点解析（自定义+DSH预设）/ 配额信号 / 尽力切 DSH 默认模型
│   ├── llm.mjs           # 调模型链写评论/私信（OpenAI 兼容，配额错自动降级）
│   ├── round.mjs         # 每日值守引擎：谷时窗口 + 定量上限 + 判重 + 日报 + 风控码停手
│   └── dm.mjs            # 私信监察：轮询未读 / 人设口吻回信 / 永久去重 / 每日上限
├── web/console.html      # 网页控制台（单文件，调 /api/bili-console/*，七页可操作）
├── vendor/bilibili-mcp/  # 基础能力库（MIT，AGI_Ananas），随包分发
└── selfcheck.mjs         # 核心模块自测（73 项，不依赖 DSH 即可跑）
```

## 数据流

```
                 ┌──────────────────────── DSH（宿主）────────────────────────┐
                 │                                                            │
   用户 ──► 设置界面(client.js) ──► ctx.settings ──► config.json ┌──────────┐ │
                 │                                              │ 插件家目录 │ │
   用户 ──► 网页控制台 ──► /api/bili-console/* ──► 同上 ─────────►│ $DSH_HOME│ │
                 │                                              │ /bili-    │ │
                 │                                              │ console/  │ │
                 │                                              └──────────┘ │
                 │                                                     │      │
                 │   每日轮次：dsh --profile headless <duty.md> ◄────────┘      │
                 │        │                                                │
                 │        ├─ 读人设(persona.mjs) + 章程(duty.md)            │
                 │        ├─ 调 MCP 工具(vendor/bilibili-mcp) 搜/读/评/私信 │
                 │        └─ 写 out/<日期>.md 日报 + seen.md 判重表          │
                 │                                                            │
                 │   私信监察：lib/dm.mjs 定时轮询（不花 token，有新消息才动） │
                 └────────────────────────────────────────────────────────────┘
```

## 关键设计决策

1. **配置只放插件自己的家目录**（`$DSH_HOME/bili-console/`）：装进 node_modules 后包目录可能
   只读、升级会被覆盖。凭证（bili_credential.json）也落在家目录——所以 vendored 的
   mcp_server.py 运行时要先**拷贝到家目录再启动**（它的凭证路径是脚本同级目录）。
2. **schemastery / defineTool 从宿主树取**（lib/hostdeps.mjs 同款思路）：桌面版 profile 是
   `autoInstallPeers: false`，裸 import optional peer 会让整个插件不激活。
3. **每个设置字段都带 `.extra('volatile', true)`**：DSH 的 settings.update() 只认 volatile
   字段；且 loader entry 的 id 必须等于命名空间名（patch 里是 `bili-console`）+ 导出 Config。
4. **`ctx.get('dshHomePath')` 返回的是函数不是字符串**（真机踩坑记录），用前先判类型。
5. **风控分级**（lib/guardian.mjs）：验证码/429 → 长冷却（默认 24h，可调）；当日上限 →
   当天收工；频率过快 → 本轮停。冷却状态落盘，重启不丢。
6. **双操控同一份配置**：网页 API 和 DSH 设置读写同一个 config.json，谁改另一边都看得到；
   互跳只是打开对方的 URL / DSH 设置页锚点，不涉及数据搬运。
7. **不重造 B站 API**：bilibili-mcp（MIT）是基础能力库，随包分发并在 NOTICE.md 致谢；
   被摆脱的是别人插件的编排与界面，不是开源生态的轮子。
8. **凭证同步规矩**（`lib/bili.mjs`）：python 的 mcp_server.py 登录后把凭证写到 **vendor 目录**，
   但插件家目录才是真相源（抗升级覆盖）。所以跑之前把家目录凭证拷到 vendor（给 python 用），
   登录成功后再把 vendor 的拷回家目录（持久化）；两处任一存在都算"已登录"。
9. **MCP stdio 客户端自研**（`lib/mcpc.mjs`）：不加任何 Python 依赖，纯 Node 拉起 mcp_server.py、
   完成 JSON-RPC initialize 握手、按 id 配对回包；进程崩了自动重启，绝不拖死插件。
10. **轮次/私信都是后台跑**：HTTP 接口（/run/now、/dm/check）只负责"点火"，真正联网工作在异步里完成，
    避免 HTTP 超时；前端看活动流与 state 拿结果。

## Phase 2/3 状态

- [x] MCP 工具注册（bili_login / search / subtitle / comments / reply / send_message / unread…）
- [x] 每日轮次编排（谷时窗口 + 定量上限 + 判重 + 日报 + 风控码停手）
- [x] 私信监察（dm.mjs）与扫码登录（login.mjs / bili.mjs LoginSession）
- [x] 模型降级链（chain.mjs + llm.mjs：配额/NO_ADAPTER 自动切下一节；尽力写 DSH 默认模型）
- [x] 网页 ↔ DSH 互跳按钮；client.js 防御式接入 DSH 设置 API
- [ ] Phase 4：真机实测（本机装 `bilibili-api-python` 依赖，验证联网值守）+ 发版（git push → DSH 安装）
