# 项目背景

## 项目目标

**PromptX** 是一个本地优先的 AI Agent 工作台，用于统一管理和编排多个 AI CLI 工具（Codex、Claude Code、OpenCode）的任务执行流程。它将零散的多轮 AI 交互结构化为可重复的工作流：

```
任务 → 项目 → 目录 → 线程 → 运行 → Diff
```

核心能力：
- 任务与项目管理，支持富文本内容（文字、图片、Markdown、PDF）
- 多引擎 AI 执行（Codex、Claude Code、OpenCode）
- 通过 Server-Sent Events（SSE）实现实时过程可视化
- 每次运行附带 Git Diff 代码审查
- 通过 Relay（WebSocket 隧道）实现远程访问
- 任务自动化：Cron 定时调度 + 通知集成（钉钉、飞书、Webhook）
- 内置 Chrome 扩展，支持禅道集成
- 可选的 Token 鉴权

## 技术栈

**前端：**
- Vue 3（Composition API，`<script setup>`）
- Vite（构建工具，手��分包策略）
- TailwindCSS（原子化 CSS，暗色模式通过 `.dark` 类控制）
- Vue Router（单页路由）
- Tiptap（富文本 / 块编辑器）
- Lucide Vue（图标库）
- markdown-it（Markdown 渲染）

**后端：**
- Node.js（20.19+、22.13+、24+），全部使用 ES Modules
- Fastify 5（HTTP 框架）
- better-sqlite3（嵌入式 SQLite，WAL 模式）
- ws（Relay 用 WebSocket）
- pdfjs-dist（PDF 导入）
- NAPI-rs Canvas（图片渲染）

**工程工具：**
- pnpm 10.15.1（Monorepo 包管理器）
- Node.js 内置测试运行器（`node --test`）
- Playwright（E2E 测试）

## 项目约定

### 代码风格

- **仅使用 ES Modules** — 全部使用 `import`/`export`，禁止 `require`/`module.exports`
- **不使用 TypeScript** — 类型通过 JSDoc 注释标注
- **命名规范：**
  - `PascalCase` — Vue 组件、类名
  - `camelCase` — 函数、变量、对象键名
  - `UPPER_SNAKE_CASE` — 常量、环境变量
- **函数名前缀约定：**
  - `use*` — Vue 组合式函数（如 `useWorkbenchTasks`）
  - `create*` — 工厂 / 构造函数
  - `get*` / `list*` — 查询 / 获取函数
  - `normalize*` — 校验与规范化函数
  - `build*` — 数据构建函数
  - `register*` — 路由注册辅助函数

### 架构模式

**多进程架构：**
- **Server**（Fastify，端口 3000）— 主 API、SQLite 数据库、SSE Hub、静态文件服务
- **Runner**（Fastify，端口 3002）— 启动 Agent CLI 子进程、管理运行生命周期
- **Web**（Vue SPA）— 由 Server 作为静态文件提供服务
- Server 与 Runner 之间通过内部 HTTP + Token 鉴权通信

**任务执行数据流：**
```
Web UI → Server API → 调度 → Runner HTTP → Agent CLI（子进程）
         ↓
    SSE Hub → Web UI（实时更新）
         ↑
    Server ← Runner（事件转发）
```

**核心设计模式：**
- **Repository 模式** — `repository.js` 是唯一的数据访问层
- **工厂模式** — `create*` 函数返回配置好的实例
- **组合模式** — Vue 组合式函数封装所有响应式逻辑
- **策略 / 插件模式** — AI 引擎适配器位于 `apps/runner/src/engines/`
- **服务模式** — 后台服务（`RunRecoveryService`、`TaskAutomationService`、`MaintenanceService`）
- **事件驱动** — SSE 用于向 Web 实时推送；内部 HTTP 用于 Runner→Server 事件传递

**共享代码：**
- `@promptx/shared`（`packages/shared/src/`）是常量、枚举、事件类型定义和跨端工具函数的唯一来源，前后端均依赖此包。

### 测试策略

- 单元 / 集成测试与源码同目录，文件名为 `*.test.js`
- 测试运行器：`node --test`（Node.js 内置）
- E2E 测试：Playwright，位于 `scripts/e2e-*.mjs`
- 冒烟测试与压力测试：`scripts/smoke-*.mjs`、`scripts/load-*.mjs`
- 混沌测试：`scripts/chaos-*.mjs`
- 运行全部测试：`pnpm test`

### Git 工作流

- 主分支为 `main`，日常开发直接在此分支进行
- 提交信息约定：`<类型>: <描述>`（如 `fix:`、`feat:`、`release:`）
- 中文提交信息可接受（项目主要面向中文用户）
- 版本遵循语义化版本（semver），发布以 `release: x.y.z` 标记

## 领域概念

- **任务（Task）** — 工作的顶层单元，包含提示词和附件
- **线程（Thread）** — 任务内多轮对话的分组
- **运行（Run）** — 任务针对某个 AI 引擎的一次执行，产生结构化事件流和 Git Diff
- **引擎（Engine）** — AI CLI 工具适配器（Codex、Claude Code、OpenCode）
- **中继（Relay）** — 可选的隧道服务，无需公网 IP 即可远程访问
- 运行过程发出类型化事件（`agentRunEvents.js`），通过信封包装（`agentRunEnvelopeEvents.js`）进行实时流式传输
- **Runner** 是独立进程，将 AI 子进程执行与主 Server 隔离

## 重要约束

- 要求 Node.js 20.19+、22.13+ 或 24+，不支持旧版 LTS
- 全面使用 ES Modules，任何包均禁止 CommonJS
- 仅支持 SQLite，不引入 Postgres / MySQL
- 文件上传单个文件上限 30 MB，存储于 `~/.promptx/uploads/`
- Server↔Runner 内部 API 通过共享 Token 鉴权，Runner 端口不得对外暴露
- Relay Server 组件为可选项，设计用于独立部署
- 不使用 TypeScript，类型提示保持 JSDoc 方式，未经明确决策不得迁移至 TS

## 外部依赖

- **AI CLI 工具（运行时依赖，不随项目打包）：** OpenAI Codex CLI、Claude Code CLI、OpenCode CLI — 需用户自行安装
- **Git** — Diff 功能依赖宿主机已安装 Git
- **钉钉 / 飞书 / Webhook** — 可选通知集成，按自动化规则独立配置
- **Relay 服务器** — 可选托管服务，也可基于开源版本自行部署
- **Tailscale** — 可选，用于安全局域网 / 远程访问（提供了开发辅助脚本）
- **禅道（Zentao）** — 可选，通过 Chrome 扩展集成项目管理
