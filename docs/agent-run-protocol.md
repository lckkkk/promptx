# Agent Run 事件协议

本文档定义 PromptX 在“单轮执行”里的统一事件协议，目标是让不同执行引擎在进入前端与持久化层之前，先收敛到同一套结构。

## 设计原则

- 使用“两层协议”，不要把所有事件压成一层
- 第一层是运行时包络事件，描述项目会话、流式输出与轮次结束状态
- 第二层是标准 agent 事件，描述思考、工具调用、文件改动、子代理协作等细粒度语义
- 引擎适配器负责把 Codex、Claude Code、OpenCode 等原始事件先映射到第二层，再装进第一层

## 第一层：运行时包络事件

顶层结构统一为：

```json
{
  "type": "agent_event",
  "event": {
    "type": "item.completed",
    "item": {
      "type": "agent_message",
      "text": "已完成修改"
    }
  }
}
```

当前约定的包络事件类型如下：

- `session`：当前轮绑定的 PromptX 项目
- `session.updated`：项目对应的引擎线程已更新
- `status`：运行启动、恢复、重试中的状态提示
- `stdout`：原始标准输出文本
- `stderr`：原始标准错误文本
- `agent_event`：标准 agent 事件包络
- `completed`：本轮执行已正常结束
- `stopped`：本轮执行被手动停止
- `error`：运行时级别错误，通常表示包络层失败，而不是 agent 自身业务错误

说明：

- 历史包络类型 `codex` 现在视为 `agent_event` 的兼容别名
- 新增引擎时，不应再引入新的顶层事件名来替代 `agent_event`

## 第二层：标准 agent 事件

标准 agent 事件定义在 `packages/shared/src/agentRunEvents.js`，当前核心类型包括：

- `thread.started`
- `turn.started`
- `turn.completed`
- `turn.failed`
- `error`
- `item.started`
- `item.updated`
- `item.completed`

其中 `item.type` 继续承载 richer 语义，而不是退化成统一的 `tool_started/tool_completed`：

- `reasoning`
- `web_search`
- `command_execution`
- `file_change`
- `todo_list`
- `collab_tool_call`
- `agent_message`

这层语义直接服务于前端摘要、时间线和状态卡片，不建议为了“协议统一”而丢失。

## 适配要求

任意执行引擎接入时，应满足以下要求：

1. 原始输出先映射为标准 agent 事件
2. 标准 agent 事件再包装为 `agent_event`
3. 启动/恢复提示走 `status`
4. 最终文本结果走 `completed`
5. 运行时失败优先使用包络层 `error`；模型自身错误优先映射到标准 agent 事件 `error` 或 `turn.failed`

## 兼容策略

- 前端读取持久化历史时，必须同时接受 `agent_event` 与旧值 `codex`
- 查询 run 历史时，事件加载语义统一使用 `events=none|latest|all`
- 旧参数 `includeEvents`、`includeLatestEvents` 仅保留兼容，不再推荐新增调用继续使用

## 参考实现

- 包络事件定义：`packages/shared/src/agentRunEnvelopeEvents.js`
- 标准 agent 事件定义：`packages/shared/src/agentRunEvents.js`
- Codex 适配：`apps/server/src/codex.js`
- Claude Code 适配：`apps/server/src/agents/claudeCodeRunner.js`
- OpenCode 适配：`apps/server/src/agents/openCodeRunner.js`
- 前端消费：`apps/web/src/composables/codexSessionPanelTurns.js`
- 契约测试：`apps/server/src/agents/runnerContract.test.js`
