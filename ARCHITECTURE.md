# PromptX 架构文档

> 版本：0.1.40 | 更新：2026-04-08

---

## 目录

- [一、项目概述](#一项目概述)
- [二、整体架构](#二整体架构)
- [三、目录结构](#三目录结构)
- [四、Server 服务端](#四server-服务端)
- [五、Runner 进程](#五runner-进程)
- [六、Web 前端](#六web-前端)
- [七、共享模块](#七共享模块)
- [八、Relay 远程访问](#八relay-远程访问)
- [九、数据存储](#九数据存储)
- [十、CLI 工具](#十cli-工具)
- [十一、数据流](#十一数据流)
- [十二、配置与环境变量](#十二配置与环境变量)
- [十三、本地开发](#十三本地开发)

---

## 一、项目概述

PromptX 是一个**本地优先的 AI Agent 工作台**，为 Codex、Claude Code、OpenCode 等 AI CLI 提供统一的任务管理、执行过程可视化和远程访问能力。

**核心特性：**
- 三栏工作台 UI（任务列表 / 执行过程 / 编辑区）
- 多 AI 引擎支持（Codex、Claude Code、OpenCode）
- 实时 SSE 推送执行过程
- Relay 中转：无公网 IP 也能远程访问
- 任务自动化（Cron）+ 通知（钉钉、飞书、Webhook）
- Git Diff 代码审查

**技术栈：**
- 前端：Vue 3 + Vite + TailwindCSS
- 后端：Node.js + Fastify
- 数据库：SQLite（better-sqlite3）
- 通信：HTTP + SSE + WebSocket

---

## 二、整体架构

```
┌─────────────────────────────────────────────────┐
│              Web 前端（Vue 3）                   │
│         任务管理 / 过程可视化 / 代码审查          │
└──────────────┬────────────────────┬─────────────┘
               │ HTTP / SSE         │ HTTP
               ▼                    ▼
┌──────────────────────┐  ┌────────────────────────┐
│   Server（Fastify）  │  │   Runner（Fastify）    │
│   端口：9301         │◄─┤   端口：9303            │
│                      │  │                        │
│ • REST API           │  │ • 执行 Agent 子进程    │
│ • SSE 实时推送       │  │ • 并发队列管理          │
│ • SQLite 读写        │  │ • 事件采集与转发        │
│ • Relay 客户端       │  │ • 配置热更新            │
│ • Git Diff           │  │                        │
└──────────────────────┘  └────────────┬───────────┘
               │                        │
               └────────────┬───────────┘
                            │
              ┌─────────────▼──────────────┐
              │    ~/.promptx/data/         │
              │    promptx.sqlite           │
              └────────────────────────────┘
                            │
              ┌─────────────▼──────────────┐
              │       Agent 子进程          │
              │  Codex / Claude Code /     │
              │  OpenCode                  │
              └────────────────────────────┘
```

**进程关系：**

| 进程 | 端口 | 职责 |
|------|------|------|
| Server | 9301 | 主服务：API、数据库、SSE、Relay |
| Runner | 9303 | 执行引擎：Agent 子进程、事件转发 |
| Agent  | —   | AI CLI 子进程（由 Runner 启动） |

Server 和 Runner 之间通过 `http://127.0.0.1:9303/internal/*` 通信，带内部 Token 鉴权。

---

## 三、目录结构

```
promptx/
├── bin/
│   └── promptx.js              # CLI 入口（全局命令 promptx）
├── apps/
│   ├── server/                 # Fastify 服务端
│   │   └── src/
│   │       ├── index.js        # 启动入口、路由注册
│   │       ├── db.js           # 数据库 Schema、查询函数
│   │       ├── systemRoutes.js # 系统、配置、Relay API
│   │       ├── taskRoutes.js   # 任务 CRUD、运行、Diff API
│   │       ├── codexRoutes.js  # 会话、工作区 API
│   │       ├── sseHub.js       # SSE 广播中心
│   │       ├── relayClient.js  # Relay WebSocket 客户端
│   │       ├── relayServer.js  # Relay 服务器（可独立部署）
│   │       ├── relayProtocol.js # Relay 通信协议
│   │       ├── relayConfig.js  # Relay 配置读写
│   │       ├── relayTenants.js # Relay 租户管理
│   │       ├── gitDiff.js      # Git Diff 计算
│   │       ├── runDispatch.js  # 任务发送与调度
│   │       ├── runRecovery.js  # 运行恢复服务
│   │       ├── taskAutomation.js # 自动化调度服务
│   │       ├── appPaths.js     # 存储路径管理
│   │       └── systemConfig.js # 系统配置
│   ├── runner/                 # 独立 Runner 进程
│   │   └── src/
│   │       ├── index.js        # 启动入口、内部 API
│   │       ├── runManager.js   # 运行生命周期管理
│   │       ├── processControl.js # 子进程控制
│   │       └── engines/        # Agent 引擎适配器
│   │           ├── index.js
│   │           ├── codexRunner.js
│   │           ├── claudeCodeRunner.js
│   │           └── openCodeRunner.js
│   ├── web/                    # Vue 3 前端
│   │   └── src/
│   │       ├── App.vue
│   │       ├── main.js
│   │       ├── router.js
│   │       ├── views/
│   │       │   └── WorkbenchView.vue   # 主工作台（三栏布局）
│   │       ├── components/             # UI 组件
│   │       ├── composables/            # 组合式逻辑
│   │       └── lib/
│   │           └── api.js              # HTTP 客户端
│   └── zentao-extension/       # 禅道 Chrome 扩展
├── packages/
│   └── shared/                 # 前后端共享模块
│       └── src/
│           ├── index.js        # 常量、枚举、工具函数
│           ├── agentRunEvents.js         # Agent 事件类型
│           ├── agentRunEnvelopeEvents.js # 信封事件类型
│           └── codexRunEventsMode.js     # 事件加载模式
├── scripts/
│   ├── service.mjs             # 本地服务启停脚本
│   ├── relay.mjs               # Relay 服务启动
│   ├── relay-service.mjs       # Relay 后台管理
│   ├── relay-tenant.mjs        # Relay 租户管理
│   └── doctor.mjs              # 环境诊断
├── docs/
│   └── relay-quickstart.md
└── package.json                # Monorepo 根配置（pnpm）
```

---

## 四、Server 服务端

### 启动流程

```
index.js
  ├── 初始化存储目录（~/.promptx/）
  ├── 创建核心服务实例
  │   ├── createRelayClient()
  │   ├── createRunnerClient()
  │   └── createSseHub()
  ├── 注册路由
  │   ├── registerSystemRoutes()
  │   ├── registerTaskRoutes()
  │   ├── registerCodexRoutes()
  │   ├── registerRealtimeRoutes()
  │   ├── registerAssetRoutes()
  │   └── registerWebAppRoutes()（静态文件 + SPA fallback）
  └── 启动后台服务
      ├── runRecoveryService.start()
      ├── taskAutomationService.start()
      ├── maintenanceService.start()
      └── relayClient.start()
```

### API 路由

**System Routes（`/api/system`、`/api/relay`）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/meta` | 版本信息、引擎选项 |
| GET | `/api/relay/status` | Relay 连接状态 |
| GET/PUT | `/api/system/config` | 系统配置（并发数等） |
| GET/PUT | `/api/relay/config` | Relay 配置 |
| POST | `/api/relay/reconnect` | 主动重连 Relay |
| GET | `/api/diagnostics/runtime` | Runner 诊断信息 |

**Task Routes（`/api/tasks`）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/tasks` | 任务列表 |
| POST | `/api/tasks` | 创建任务 |
| GET/PUT/DELETE | `/api/tasks/:slug` | 任务详情、更新、删除 |
| POST | `/api/tasks/:slug/send` | 发送任务（触发 Agent 运行） |
| POST | `/api/tasks/:slug/stop` | 停止运行 |
| GET | `/api/tasks/:slug/run/:runId` | 运行详情（含事件） |
| GET | `/api/tasks/:slug/workspace-diff` | 任务累计 Diff |
| GET | `/api/tasks/:slug/run/:runId/diff` | 单次运行 Diff |

**Codex Routes（`/api/codex`）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST | `/api/codex/sessions` | 会话列表、创建 |
| GET/PUT/DELETE | `/api/codex/sessions/:id` | 会话详情、更新、删除 |
| GET | `/api/codex/sessions/:id/events` | 运行事件列表 |
| GET | `/api/codex/workspaces` | 已知工作区 |
| GET | `/api/codex/workspaces/tree` | 目录树 |

**Realtime（SSE）**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/realtime/subscribe` | 订阅 SSE 实时事件 |

**Assets**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/upload` | 上传文件（最大 30MB） |
| GET | `/uploads/:path` | 访问已上传文件 |

### 后台服务

| 服务 | 文件 | 职责 |
|------|------|------|
| RunRecoveryService | `runRecovery.js` | 恢复异常中断的运行 |
| TaskAutomationService | `taskAutomation.js` | Cron 自动触发任务 |
| MaintenanceService | — | SQLite VACUUM、清理过期数据 |
| RelayClient | `relayClient.js` | 维持到 Relay Server 的 WebSocket 连接 |

---

## 五、Runner 进程

### 职责

Runner 作为独立进程运行，与 Server 完全解耦，通过内部 HTTP API 通信。

```
Runner 职责：
  ├── 管理 Agent 子进程生命周期（启动/停止/超时）
  ├── 并发队列控制（默认最大 3 个并发）
  ├── 采集 Agent stdout/stderr/事件
  ├── 将事件通过 HTTP 转发给 Server
  └── 支持热更新并发配置（无需重启）
```

### 内部 API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/internal/runs/start` | 启动一次 Agent 运行 |
| POST | `/internal/runs/:runId/stop` | 停止运行 |
| GET | `/internal/runs/:runId` | 运行状态 |
| GET | `/internal/diagnostics` | 诊断信息（活跃/队列/完成数） |
| PUT | `/internal/config` | 热更新配置（并发数等） |

### 并发模型

```
maxConcurrentRuns = 3（默认，可通过配置修改）

Active Runs（Map）:      run-1, run-2, run-3
Queued Runs（Array）:    run-4, run-5, ...

当 Active 有空位时，自动从队列取出并启动。
```

### Agent 引擎适配器

所有引擎实现同一接口：

```javascript
interface AgentRunner {
  engine: string

  // 发现本地已有的工作区
  listKnownWorkspaces(limit?): Array<string>

  // 流式执行（核心方法）
  streamPromptToSession(session, prompt, callbacks): Promise<void>
    // callbacks.onSessionUpdated(session)  会话 ID 更新
    // callbacks.onAgentEvent(event)        结构化事件
    // callbacks.onStdout(text)             原始输出
    // callbacks.onCompleted(message)       完成消息
}
```

| 引擎 | 文件 | 说明 |
|------|------|------|
| `codex` | `codexRunner.js` | Codex CLI |
| `claude-code` | `claudeCodeRunner.js` | Claude Code |
| `opencode` | `openCodeRunner.js` | OpenCode |

---

## 六、Web 前端

### 三栏布局

```
┌──────────────────────────────────────────────────────────┐
│  顶部：代码变更 | 管理项目 | 设置                        │
├───────────────┬──────────────────┬───────────────────────┤
│  左栏         │  中栏            │  右栏                 │
│  任务列表     │  执行过程        │  输入编辑区           │
│               │                  │                       │
│  • 新建       │  最新 turn       │  Tiptap 块编辑器      │
│  • 搜索/筛选  │  历史 turn       │  • 文本块             │
│  • 任务卡     │  子代理事件      │  • 图片块             │
│  • 拖拽排序   │  自动滚动        │  • 导入文件           │
│               │                  │  • 代办项             │
│               │                  │  • 发送 / 停止        │
└───────────────┴──────────────────┴───────────────────────┘
```

### 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| WorkbenchView | `views/WorkbenchView.vue` | 主布局、三栏协调 |
| TaskListPanel | `WorkbenchTaskListPanel.vue` | 左栏任务列表 |
| SessionPanel | `CodexSessionPanel.vue` | 中栏执行过程 |
| InputPanel | `WorkbenchInputPanel.vue` | 右栏输入区 |
| ProcessRenderer | `ProcessDetailRenderer.vue` | 执行事件渲染 |
| BlockEditor | `TiptapBlockEditor.vue` | 富文本块编辑器 |
| DiffReview | `TaskDiffReviewPanel.vue` | 代码审查面板 |
| SessionManager | `CodexSessionManagerDialog.vue` | 项目/会话管理 |

### 核心 Composables

| Composable | 文件 | 职责 |
|-----------|------|------|
| useWorkbenchTasks | `useWorkbenchTasks.js` | 任务列表状态与操作 |
| useCodexSessionPanel | `useCodexSessionPanel.js` | 执行面板逻辑 |
| useCodexRunHistory | `useCodexRunHistory.js` | 运行历史加载 |
| useWorkbenchRealtime | `useWorkbenchRealtime.js` | SSE 实时订阅 |
| useI18n | `useI18n.js` | 国际化 |
| useTheme | `useTheme.js` | 主题切换 |

### 块编辑器（Tiptap）

任务内容由多个 Block 组成：

```typescript
interface Block {
  type: 'text' | 'image' | 'imported_text'
  content: string
  meta: {
    fileName?: string
    mimeType?: string
    originalSize?: number
  }
}
```

支持操作：拖拽排序、图片导入（自动缩放至 1600×1600）、PDF 导入、Markdown 导入、代办项管理。

### 执行过程渲染

`ProcessDetailRenderer` 支持以下内容类型：

- 结构化：代码块、待办列表、表格、搜索结果
- 文本：终端输出、长命令（等宽字体）
- 子代理事件：轻量单行摘要（Claude Code/OpenCode 的工具调用）

---

## 七、共享模块

`packages/shared/src/index.js` 导出前后端共用的常量和工具。

### 引擎枚举

```javascript
AGENT_ENGINES = {
  CODEX: 'codex',
  CLAUDE_CODE: 'claude-code',
  OPENCODE: 'opencode',
}
```

### 事件类型

**信封事件**（Runner → Server 的容器层）：

```javascript
AGENT_RUN_ENVELOPE_EVENT_TYPES = {
  SESSION: 'session',
  SESSION_UPDATED: 'session.updated',
  STATUS: 'status',
  STDOUT: 'stdout',
  STDERR: 'stderr',
  AGENT_EVENT: 'agent_event',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  ERROR: 'error',
}
```

**Agent 事件**（结构化内容层）：

```javascript
AGENT_RUN_ITEM_TYPES = {
  REASONING: 'reasoning',
  WEB_SEARCH: 'web_search',
  COLLAB_TOOL_CALL: 'collab_tool_call',
  FILE_CHANGE: 'file_change',
  COMMAND_EXECUTION: 'command_execution',
  TODO_LIST: 'todo_list',
  AGENT_MESSAGE: 'agent_message',
}
```

### 工具函数

```javascript
slugifyTitle(title)             // 生成任务 slug（最长 36 字符）
deriveTitleFromBlocks(blocks)   // 从块内容推断标题
buildRawTaskText(task)          // 拼接完整任务文本
summarizeTask(task)             // 生成摘要（180 字符）
normalizeAgentEngine(value)     // 规范化引擎标识
```

---

## 八、Relay 远程访问

Relay 让没有公网 IP 的本地设备也能被外网访问。

### 架构

```
手机/浏览器
    │ HTTP
    ▼
Relay Server（云服务器或本地，端口 3030）
    │ WebSocket（本地主动连出）
    ▼
本地电脑（Relay Client + PromptX 主服务）
    │ HTTP（转发到本地）
    ▼
PromptX Server（端口 9301）
```

### 通信协议

所有消息为 JSON，走 WebSocket 帧：

**设备连接：**
```
Client → Server: { type: 'hello', deviceId, deviceToken, version }
Server → Client: { type: 'hello.ack', ok: true }
```

**请求转发（Server → Client）：**
```
{ type: 'request.start', requestId, method, path, headers }
{ type: 'request.body',  requestId, chunk: '<base64>' }
{ type: 'request.end',   requestId }
```

**响应回传（Client → Server）：**
```
{ type: 'response.start', requestId, status, headers }
{ type: 'response.body',  requestId, chunk: '<base64>' }
{ type: 'response.end',   requestId }
```

每个 chunk 最大 **256 KB**，二进制内容用 Base64 编码。

### 租户路由

Relay Server 通过 HTTP `Host` 头匹配租户：

```
user1.promptx.example.com → tenant: user1
user2.promptx.example.com → tenant: user2
```

**单租户无域名模式（IP 直连）：** 配置租户时不设置 `hosts`，所有请求自动路由到该租户。

### 重连机制

| 重连次数 | 等待时间 |
|---------|---------|
| 第 1 次 | 1 秒 |
| 第 2 次 | 2 秒 |
| 第 3 次 | 5 秒 |
| 第 4 次 | 10 秒 |
| 第 5+ 次 | 30 秒 |

以下错误不重连（配置有误）：`invalid_tenant`、`invalid_token`、`invalid_device`

---

## 九、数据存储

### 存储位置

```
~/.promptx/
├── data/
│   ├── promptx.sqlite        # 主数据库
│   ├── relay-config.json     # Relay 客户端配置
│   └── system-config.json    # 系统配置
├── uploads/                  # 上传的文件
├── tmp/                      # 临时文件
└── run/
    ├── service.json          # 进程状态（PID、端口）
    ├── server.log            # Server 日志
    └── runner.log            # Runner 日志
```

### 数据库 Schema

**tasks**（任务）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| slug | TEXT UNIQUE | 任务唯一标识 |
| title | TEXT | 标题 |
| codex_session_id | TEXT | 绑定会话 |
| automation_enabled | INT | 是否开启自动化 |
| automation_cron | TEXT | Cron 表达式 |
| notification_channel_type | TEXT | 通知渠道 |
| notification_webhook_url | TEXT | 通知地址 |
| created_at / updated_at | TEXT | 时间戳 |

**blocks**（任务内容块）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| task_id | INT FK | 所属任务 |
| type | TEXT | `text` / `image` / `imported_text` |
| content | TEXT | 内容 |
| sort_order | INT | 排序 |

**codex_sessions**（会话）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | |
| engine | TEXT | `codex` / `claude-code` / `opencode` |
| cwd | TEXT | 工作目录 |
| engine_session_id | TEXT | 引擎内部会话 ID |

**codex_runs**（运行记录）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | TEXT PK | |
| task_slug | TEXT FK | |
| session_id | TEXT FK | |
| engine | TEXT | |
| prompt | TEXT | 完整提示词 |
| status | TEXT | `queued` / `running` / `completed` / `error` / `stopped` |
| response_message | TEXT | 最终回复 |
| started_at / finished_at | TEXT | |

**codex_run_events**（运行事件）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | INT PK | |
| run_id | TEXT FK | |
| seq | INT | 事件序号 |
| event_type | TEXT | |
| payload_json | TEXT | 事件内容 |

另有 Git 快照相关表：`task_git_baselines`、`run_git_baselines`、`run_git_final_snapshots`。

**数据库配置：**
```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
```

---

## 十、CLI 工具

```bash
# 服务管理
promptx start           # 后台启动（Server:9301 + Runner:9303）
promptx stop            # 停止服务
promptx restart         # 重启服务
promptx status          # 查看运行状态

# 环境诊断
promptx doctor          # 检查 Node 版本、引擎、端口、构建产物

# 版本
promptx version / -v / --version

# Relay 管理
promptx relay start     # 启动 Relay Server（端口 3030）
promptx relay stop
promptx relay restart
promptx relay status

# Relay 租户
promptx relay tenant add <key>
promptx relay tenant add <key> --domain promptx.example.com
promptx relay tenant list
promptx relay tenant remove <key>
```

---

## 十一、数据流

### 任务执行流程

```
前端                   Server                 Runner              Agent
 │                        │                      │                   │
 │─── POST /send ────────►│                      │                   │
 │                        │ 创建 run（queued）    │                   │
 │                        │─── startRun() ──────►│                   │
 │                        │                      │── spawn child ───►│
 │◄── SSE: runs.created ──│                      │                   │
 │                        │                      │◄── events ────────│
 │                        │◄── POST events ──────│                   │
 │◄── SSE: runs.updated ──│                      │                   │
 │                        │                      │◄── exit ──────────│
 │                        │ 更新 run（completed） │                   │
 │◄── SSE: runs.completed─│                      │                   │
```

### SSE 事件类型

| 事件 | 触发时机 |
|------|---------|
| `tasks.changed` | 任务创建/更新/删除 |
| `runs.created` | 运行创建 |
| `runs.updated` | 运行状态变化、新事件 |
| `runs.completed` | 运行结束（完成/错误/停止） |

---

## 十二、配置与环境变量

### Server 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PORT` | `9301` | Server 监听端口 |
| `HOST` | `127.0.0.1` | Server 监听地址（`0.0.0.0` 可局域网访问） |
| `PROMPTX_HOME` | `~/.promptx` | 数据根目录 |

### Runner 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROMPTX_RUNNER_PORT` | `9303` | Runner 监听端口 |
| `PROMPTX_RUNNER_MAX_CONCURRENT_RUNS` | `3` | 最大并发运行数（1-16） |

### Relay Server 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROMPTX_RELAY_PORT` | `3030` | Relay 监听端口 |
| `PROMPTX_RELAY_HOST` | `0.0.0.0` | Relay 监听地址 |
| `PROMPTX_RELAY_TENANTS_FILE` | — | 多租户配置 JSON 文件路径 |
| `PROMPTX_RELAY_DEVICE_TOKEN` | — | 单租户设备令牌 |
| `PROMPTX_RELAY_ACCESS_TOKEN` | — | 单租户访问令牌 |
| `PROMPTX_RELAY_ADMIN_TOKEN` | — | 管理页面令牌 |

### Relay Client 配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROMPTX_RELAY_URL` | — | Relay Server 地址 |
| `PROMPTX_RELAY_DEVICE_ID` | — | 本设备 ID |
| `PROMPTX_RELAY_DEVICE_TOKEN` | — | 设备令牌（与 Server 侧匹配） |
| `PROMPTX_RELAY_ENABLED` | — | 是否启用 Relay |

---

## 十三、本地开发

### 环境要求

- Node.js 20.19+ 或 22.13+ 或 24+
- pnpm 10.15+
- 至少一个 AI 引擎（Codex / Claude Code / OpenCode）

### 启动开发环境

```bash
# 安装依赖
pnpm install

# 并行启动所有服务
pnpm dev
# 前端：http://127.0.0.1:5174
# Server：http://127.0.0.1:9302
# Runner：http://127.0.0.1:9303
```

### 构建生产版本

```bash
pnpm build
# 构建产物：apps/web/dist/

# 启动生产服务
promptx start
# http://127.0.0.1:9301
```

### 常用命令

```bash
pnpm lint           # 代码检查
pnpm test           # 单元测试
pnpm test:e2e       # E2E 测试（Playwright）
pnpm pack:dry       # 模拟打包（验证 files 配置）
promptx doctor      # 诊断环境问题
```

### 日志位置

```
~/.promptx/run/server.log   # Server 日志
~/.promptx/run/runner.log   # Runner 日志
```

### 常见问题

| 问题 | 原因 | 解法 |
|------|------|------|
| 启动报错：没有找到前端构建产物 | 未执行 `pnpm build` | `pnpm build` |
| 端口被占用 | 残留进程 | `promptx stop` 再重试 |
| Agent 无法运行 | CLI 未安装或不在 PATH | `promptx doctor` 检查 |
| Relay 无法连接 | Token 不匹配或地址错误 | 检查 `~/.promptx/data/relay-config.json` |
| 数据库报错 | WAL 文件异常 | 备份后删除 `~/.promptx/data/*.sqlite*` |
