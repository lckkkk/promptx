# Runner 拆分方案

本文基于当前仓库实现，给出一版可落地的拆分方案，目标是把长任务执行面从 `apps/server` 中摘出去，同时尽量少改前端与既有数据模型。

## 当前瓶颈

现在的执行链路在 `apps/server` 里是同进程直连：

- `apps/server/src/index.js` 里的 `startTaskRunForTask()` 会直接创建 run，并立刻调用 `codexRunRuntime.start(runRecord)`
- `apps/server/src/codexRunRuntime.js` 用进程内 `Map` 保存 controller、listener、stop 状态
- `apps/server/src/agents/*.js` 直接在 server 进程里拉起 Codex / OpenCode / Claude Code 子进程
- `apps/server/src/codexRuns.js` 虽然已经做了事件 buffer，但 flush、状态更新、SSE 广播仍都在同一个服务里

这意味着：

- agent 子进程压力和 HTTP API 共用同一个 Node 进程
- stop/kill/timeout/zombie 回收也压在主服务里
- 只要长任务卡住，`/api/tasks`、SSE、CRUD 都会跟着受影响

## 拆分目标

只做两件事：

1. `web + server api` 保持响应，不再被长任务拖死
2. `runner` 专心管理 agent 子进程、事件流、停止与回收

## 服务边界

### `apps/web`

先不动。

### `apps/server`

保留：

- HTTP API
- 任务 / 项目 CRUD
- SQLite 持久化
- SSE / relay
- 前端静态资源
- run 主状态与历史事件查询

新增职责：

- 调 `runner` 启动 / 停止 run
- 接收 `runner` 回推的状态和事件
- 把状态变化广播给前端

### `apps/runner`

新增独立服务，负责：

- 启动 agent 子进程
- 管理 run 生命周期
- 收集 stdout / stderr / agent event
- stop / kill / timeout / zombie 回收
- 事件缓冲和批量回推

## 运行模型

建议把 run 拆成两层：

### 控制态

由 `server` 落库：

- `queued`
- `starting`
- `running`
- `stopping`
- `completed`
- `stopped`
- `error`
- `stop_timeout`

### 运行态上下文

由 `runner` 只保存在内存：

- `runId`
- `engine`
- `cwd`
- `pid`
- `startedAt`
- `lastHeartbeatAt`
- `stopRequestedAt`
- `bufferedEvents`
- `lastSeq`
- `timeoutAt`

### 事件流

沿用当前已有事件协议，不重做前端消费层：

- `stdout`
- `stderr`
- `agent_event`
- `session`
- `session.updated`
- `completed`
- `stopped`
- `error`

现有事件定义已经在：

- `packages/shared/src/agentRunEnvelopeEvents.js`
- `packages/shared/src/agentRunEvents.js`
- `docs/agent-run-protocol.md`

## 最小通信方式

第一阶段不引入 MQ，只走本机 HTTP。

### server -> runner

- `POST /internal/runs/start`
- `POST /internal/runs/:id/stop`
- `GET /internal/runs/:id`

### runner -> server

- `POST /internal/runner-events`
- `POST /internal/runner-status`

### 鉴权

两边共享一个内部 token，例如：

- `PROMPTX_INTERNAL_TOKEN`

通过请求头传：

- `x-promptx-internal-token`

## 推荐契约

### `POST /internal/runs/start`

请求体建议：

```json
{
  "runId": "pxcr_xxx",
  "taskSlug": "task-1",
  "sessionId": "pxcs_xxx",
  "engine": "codex",
  "prompt": "请继续处理",
  "promptBlocks": [],
  "cwd": "D:/code/demo",
  "engineThreadId": "",
  "engineSessionId": "",
  "env": {},
  "metadata": {
    "source": "api"
  }
}
```

返回：

```json
{
  "accepted": true,
  "runId": "pxcr_xxx",
  "status": "starting"
}
```

### `POST /internal/runs/:id/stop`

请求体建议：

```json
{
  "reason": "user_requested",
  "forceAfterMs": 1500
}
```

返回：

```json
{
  "accepted": true,
  "runId": "pxcr_xxx",
  "status": "stopping"
}
```

### `POST /internal/runner-events`

批量事件，要求每条都带 `seq`：

```json
{
  "runnerId": "local-runner",
  "items": [
    {
      "runId": "pxcr_xxx",
      "seq": 1,
      "type": "stdout",
      "ts": "2026-03-21T10:00:00.000Z",
      "payload": {
        "chunk": "hello"
      }
    }
  ]
}
```

### `POST /internal/runner-status`

```json
{
  "runnerId": "local-runner",
  "runId": "pxcr_xxx",
  "status": "running",
  "pid": 12345,
  "heartbeatAt": "2026-03-21T10:00:01.000Z",
  "exitCode": null,
  "signal": null,
  "error": ""
}
```

## 代码落点

### `apps/server` 需要调整的文件

#### `apps/server/src/index.js`

当前问题：

- `startTaskRunForTask()` 直接启动执行器
- `/api/codex/runs/:runId/stop` 直接拿进程内 controller

目标改造：

- 创建 run 后只写 `queued`
- 通过 `runnerClient.startRun()` 调 runner
- stop 接口改成先把 run 标记为 `stopping`
- 再异步调 `runnerClient.stopRun()`
- 增加 runner 回调入口：
  - `POST /internal/runner-events`
  - `POST /internal/runner-status`

#### `apps/server/src/codexRunRuntime.js`

第一阶段不再作为 server 主执行器，建议降级为：

- 迁移到 `apps/runner/src/runManager.js` 的参考实现
- server 侧最终删除对 `createAgentRunRuntime()` 的直接依赖

#### `apps/server/src/codexRuns.js`

需要补两类能力：

- 创建 run 时支持初始状态 `queued`
- 增加批量 ingest：
  - `appendCodexRunEventsBatch(runId, items)`
  - `updateCodexRunFromRunnerStatus(runId, patch)`

同时保留现有事件查询接口，前端基本不用改。

#### `apps/server/src/processControl.js`

这部分应迁移或复用到 `apps/runner`，因为 stop / kill / 超时控制属于执行面，不属于控制面。

#### `apps/server/src/agents/*`

这些 engine adapter 最终也应该迁移到 `apps/runner/src/engines/*`，server 只保留 engine 枚举和元信息查询能力。

### `apps/runner` 初始目录

```text
apps/runner/
  package.json
  src/
    index.js
    runManager.js
    processControl.js
    serverClient.js
    internalAuth.js
    engines/
      index.js
      codexRunner.js
      claudeCodeRunner.js
      openCodeRunner.js
```

## 推荐迁移顺序

### 第 1 步：先稳定数据面

- 给 run 状态补齐 `queued | starting | stopping | stop_timeout`
- 给事件 ingest 补批量入口
- stop 接口改成“先改控制态，再异步执行”

这一步还不拆服务，也能先改善 UI 卡死问题。

### 第 2 步：抽 `runnerClient`

在 `apps/server/src/runnerClient.js` 定义：

- `startRun(payload)`
- `stopRun(runId, payload)`
- `getRun(runId)`

先允许一种 fallback：

- 若未配置 runner 地址，则临时走本地 runtime

这样能边迁移边保持兼容。

### 第 3 步：新建 `apps/runner`

先只支持一个 engine 跑通，例如 `codex`：

- 复制 `processControl.js`
- 迁移 `codexRunRuntime.js` 逻辑到 `runManager.js`
- 迁移 `agents/codexRunner.js`
- 实现事件批量 flush 到 server

### 第 4 步：server 切换到远端执行

`startTaskRunForTask()` 改成：

1. 校验任务 / 项目
2. 创建 run，状态为 `queued`
3. 调 `runnerClient.startRun()`
4. 接到 accepted 后改为 `starting`
5. 等 runner 持续回推 `running / completed / error`

### 第 5 步：清理旧路径

- 删除 server 进程内 controller
- 删除 server 直拉 agent 的逻辑
- 保留事件查询、SSE、持久化

## stop 链路

目标行为：

1. 用户点停止
2. `server` 立刻把 run 状态改成 `stopping`
3. 前端马上得到状态反馈，不再一直等真实退出
4. `server` 请求 `runner stop`
5. `runner` 先优雅停止，再强杀，再回收
6. 最终回 `stopped` 或 `stop_timeout`

关键要求：

- stop 接口必须幂等
- runner 重复收到 stop 也必须安全
- `GET /internal/runs/:id` 要能反映 stop 请求是否已接收

## 事件写库策略

不要让 `runner` 每条事件都直写 SQLite。

建议：

- `runner` 内存 buffer
- 每 200ms ~ 500ms 批量上报一次
- run 结束时强制 flush 一次
- `server` 再批量写库并广播 SSE

当前 `apps/server/src/codexRuns.js` 已经有 pending event flush 机制，可以复用它的思路，但 ingest 入口要从“本地 append”改成“远端批量导入”。

## 必须一起收口的 server 热路径

即使拆完 runner，`server` 里这些路径也要继续降温：

- `/api/tasks`
- `/api/tasks/workspace-diff-summaries`
- 任何首页摘要接口

不要把这些重操作混进热路径：

- workspace 扫描
- git diff
- 诊断探测
- 建议生成

建议做法：

- 重计算单独接口
- 结果缓存
- 列表接口只查轻量字段

## 风险点

### 1. runner 崩溃后 run 卡死

需要 runner 心跳；server 应定时把长期停在 `starting/running/stopping` 且失联的 run 标成异常态。

### 2. 事件乱序或重复写入

必须带 `seq`，server 侧按 `(run_id, seq)` 去重。当前 `codex_run_events` 已有唯一索引，可直接利用。

### 3. session/thread 状态不同步

`session.updated` 事件仍应由 runner 发回 server，再由 server 更新 `codex_sessions`。

### 4. 停止后残留子进程

`processControl` 不要散落在 server 和 runner 两边，最终应只有 runner 负责真实进程回收。

## 第一版验收标准

满足下面这些，就说明拆分第一阶段成功：

- agent 执行期间，`/api/tasks` 和 `/api/codex/sessions` 仍能稳定响应
- 点击停止后，前端在 1 秒内看到 `stopping`
- runner 被手动杀掉后，server 仍能正常返回 CRUD / SSE / 静态资源
- 单次 run 的事件写库频率明显下降
- 前端已有 run 历史、流式面板、停止按钮都无需大改

## 我建议你现在就做的第一刀

不是先写完整 runner，而是先做这三件：

1. 在 `apps/server/src/codexRuns.js` 把 run 状态补齐为 `queued / starting / stopping / stop_timeout`
2. 在 `apps/server/src/index.js` 把 stop 改成“立即返回控制态”
3. 新增 `apps/server/src/runnerClient.js` 和两个内部回调接口，先把 server 的边界立起来

这三步做完，再新建 `apps/runner`，迁移成本会明显更低。
