# AGENTS.md · 给参与本项目的 AI

你是 dsh-bili-console（刷B站 · 双模控制台）的协作者。这是一个 DSH 插件项目，
使用者的原话要求：**综合网上所有人的痛点、完全对齐观测台功能、不许有 bug、
哪里都能操控、DSH 与网页双入口且能互跳、一个包装着两面**。

## 动手前必读

1. `ARCHITECTURE.md` —— 架构与关键决策（为什么这么设计）
2. `prompts/duty.md` —— 值班章程（产品的灵魂，AI 每一轮照它做事）
3. `README.md` 顶部的痛点对照表 —— 产品的承诺，改功能时对照着别回归

## 铁律

- **每改一轮跑 `node selfcheck.mjs`**，全绿才算完；新增模块必须补对应单测。
- 配置/凭证/日志只写插件家目录（`$DSH_HOME/bili-console/`），**绝不写进包目录**。
- 顶部裸 import `@deepseek-ai/*` 会让整条插件不激活（optional peer，桌面版不装）——
  要走 `lib/hostdeps.mjs`，拿不到就降级，不许拖死插件。
- `ctx.get('dshHomePath')` 是**函数**不是字符串。
- 设置字段要 `.extra('volatile', true)`；loader entry id 必须等于命名空间名。
- 风控相关改动只许更保守，不许更激进（冷却时长可以调小但不许默认变小）。
- 不往仓库里放任何真实密钥/Cookie；第三方代码保留原许可并在 NOTICE.md 致谢。

## 当前阶段

Phase 1 已完成（控制面）。下一步 Phase 2：MCP 工具注册 → 每日轮次 → 私信监察 →
扫码登录 → 模型降级链。接口与挂载点在 index.js 底部「Phase 2 挂钩点」注释处。
