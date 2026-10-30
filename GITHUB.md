# GITHUB.md · 交接说明书（给帮忙上架的 AI 和未来的协作者）

这份文件是给「把本项目推到 GitHub 并让 DSH 能安装」的准备材料。原话要求：
**文件打包好、放上 GitHub、复制链接贴进 DSH，DSH 自己安装。**

## 一、这个包是什么

`dsh-bili-console` —— DSH（DeepSeek Harness）插件：刷B站 · 双模控制台。
纯 Node ESM 包（`"type": "module"`），带一个 vendored Python MCP（`vendor/bilibili-mcp`，MIT）。
不需要构建、不需要编译——**整个仓库原样就是可安装的包**。

## 二、上架 GitHub（照做即可）

```bash
cd dsh-bili-console
git init
git add .
git commit -m "feat: dsh-bili-console v0.1.0 — 刷B站双模控制台（Phase 1-3：控制面 + 接上B站 + 双操控）"
git branch -M main
git remote add origin https://github.com/<你的用户名>/dsh-bili-console.git
git push -u origin main
```

注意事项：
- 仓库名建议就叫 `dsh-bili-console`（和 package.json 的 name 一致）；
- `.gitignore` 已经排除 `node_modules/`、家目录数据、备份文件——**凭证和日志不会进仓库**；
- 建议在 GitHub 仓库页把 License 显示为 MIT（LICENSE 文件已在包里）；
- 如果 GitHub 网页端操作：New repository → 名字 dsh-bili-console → Public → 不初始化 README
  （README 已在包里）→ 创建后按网页提示上传/推送。

## 三、让 DSH 安装（两种方式）

**方式 A · 本地链接（先在自己机器上验证，推荐先走这条）：**

```bash
dsh plugin --profile web add link:<本仓库的解压目录>
```

**方式 B · GitHub 链接（验证 OK 后，别人也能装）：**

```bash
dsh plugin --profile web add https://github.com/<你的用户名>/dsh-bili-console.git
```

（npm 也支持：`dsh plugin --profile web add dsh-bili-console`——先 `npm publish` 即可，
package.json 里 publishConfig 已配好 public。）

## 四、装完怎么确认活着

1. DSH 日志里应出现 `已挂载（家=...\bili-console，v0.1.0）`；
2. 打开 `http://127.0.0.1:<DSH webServer 端口>/bili-console` 看到控制台页面；
3. 跑 `node selfcheck.mjs` 应输出 `73 通过，0 失败`。

## 五、当前阶段与路线图

- **Phase 1（已完成）**：控制面——设置体系、人设卡、章程、风控规则库、网页控制台 API 与七页界面。
- **Phase 2（已完成）**：接上 B站——`lib/mcpc.mjs` 自研 MCP stdio 客户端拉起 `vendor/bili-mcp`；每日值守引擎
  （谷时窗口 + 定量上限 + 判重 + 日报 + 风控码停手）、私信监察、扫码登录、模型降级链（配额/NO_ADAPTER 自动切下一节）。
  网页控制台「立即跑一轮 / 扫码登录 / 查私信 / 模型与降级链实时管理」全部接通。
- **Phase 3（已完成·防御式）**：网页 ↔ DSH 互跳按钮就位；`client.js` 鸭子类型探测 DSH 设置 API，
  能注册「打开网页控制台」入口与常用开关就注册，探测不到静默 no-op（绝不拖垮插件激活）。
- **Phase 4（待办）**：真机实测（本机装好 `bilibili-api-python` 依赖，验证搜/评/私信联网值守）+ 发版（git push → DSH 安装）。

改代码前先读 `ARCHITECTURE.md`；每一轮改动后跑 `node selfcheck.mjs`。

## 六、合规提醒

- 只在自己账号、以自己授权的方式使用；遵守 B站 用户协议；
- NOTICE.md 里有第三方致谢（bilibili-mcp 为 AGI_Ananas 的 MIT 项目，随包分发保留许可）；
- 不要把任何真实密钥、Cookie 提交进仓库——`.gitignore` 已防，但推送前最好再 `git status` 看一眼。
