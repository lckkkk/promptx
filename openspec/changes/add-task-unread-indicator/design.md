## Context

任务列表当前已经能展示运行中状态和工作区代码变更摘要，但缺少“完成后未读”的持久化状态。用户明确要求未读只在任务执行结束后出现，不希望运行中的任务或普通编辑改动触发未读。

## Goals

- 仅对任务运行终态产生未读
- 未读状态按用户隔离
- 未读状态跨刷新、跨设备保持一致
- 打开任务即自动标记已读

## Non-Goals

- 不为普通编辑、标题修改、代码变更摘要刷新增加未读
- 不追溯历史旧 run 生成首批未读
- 不新增复杂的批量已读、筛选未读交互

## Data Model

新增一张 `task_read_states` 表：

- `user_id`
- `task_slug`
- `last_read_run_finished_at`
- `created_at`
- `updated_at`

同时在任务列表装饰阶段计算：

- `latestCompletedRunFinishedAt`
- `unread`

判定规则：

- 若任务不存在最近终态 run，则 `unread = false`
- 若 `last_read_run_finished_at` 为空，则仅当该任务在新版本上线后产生新的终态 run 时才标未读
- 若 `latestCompletedRunFinishedAt > last_read_run_finished_at`，则 `unread = true`

## Backend Flow

1. 任务列表查询时取每个任务最近一条终态 run 的 `finished_at`
2. 结合 `task_read_states.last_read_run_finished_at` 计算 `unread`
3. 新增“标记任务已读”接口，将当前任务最近终态 run 时间写入 `task_read_states`
4. 删除任务时依赖外键级联清理已读记录

## Frontend Flow

1. 任务列表读取 `unread`
2. 任务卡片标题区域展示小红点
3. 用户打开任务时调用“标记已读”接口
4. 若当前任务正处于打开状态且 run 刚刚终态完成，前端不额外制造未读，依赖已读接口保持已读

## Testing

- 后端：多用户隔离、终态 run 判定、打开任务后清除未读、非终态不触发未读
- 前端：任务卡片未读标识展示逻辑、打开任务后未读消失
