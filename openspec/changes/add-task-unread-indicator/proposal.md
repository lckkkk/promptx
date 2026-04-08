# Change: 为任务列表增加执行完成未读标识

## Why

当前多任务并行使用时，用户只能看到哪些任务正在运行，但无法快速识别“哪些任务已经执行完成、但自己还没点开看过”。这会导致完成结果被淹没在列表里，降低任务切换和结果回看的效率。

## What Changes

- 为任务列表增加“执行完成未读”标识，未读仅由任务运行进入终态时触发。
- 将未读状态持久化到服务端，按 `用户 + 任务` 维度保存，保证多设备和多窗口一致。
- 在用户打开任务详情时自动标记该任务为已读。
- 任务列表接口返回未读状态，前端在任务卡片上展示未读红点。

## Impact

- Affected specs: `workbench-task-list`
- Affected code:
  - `apps/server/src/db.js`
  - `apps/server/src/repository.js`
  - `apps/server/src/taskRoutes.js`
  - `apps/server/src/index.js`
  - `apps/server/src/codexRuns.js`
  - `apps/web/src/composables/useWorkbenchTasks.js`
  - `apps/web/src/components/WorkbenchTaskListPanel.vue`
  - `apps/web/src/lib/taskApi.js`
  - `apps/web/src/lib/i18n.js`
