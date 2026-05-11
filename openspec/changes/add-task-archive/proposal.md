# Change: 增加任务归档能力

## Why

当前工作台中的任务会持续累积，已经完成或暂时不再处理的任务仍长期出现在主列表中，影响正在进行中的任务查找与聚焦。

用户需要一种轻量的“收纳”机制：将任务归档后默认从主列表隐藏，但保留历史内容，并允许在归档视图中查看、恢复或删除。

## What Changes

- 为任务增加归档状态与归档时间，用于标记任务是否已归档
- 调整任务列表接口，默认仅返回未归档任务，并支持显式查询归档任务
- 在工作台任务列表中增加“进行中 / 已归档”视图切换
- 在主列表中提供归档操作，在归档视图中提供取消归档操作
- 归档任务仅在“已归档”视图中可见和可操作
- 运行中的任务不能归档，避免任务在执行期间从主列表消失

## Impact

- Affected specs: `workbench-task-list`
- Affected code:
  - `apps/server/src/repository.js`
  - `apps/server/src/taskRoutes.js`
  - `apps/server/src/repository.test.js`
  - `apps/server/src/taskRoutes.test.js`
  - `apps/web/src/lib/api.js`
  - `apps/web/src/composables/useWorkbenchTasks.js`
  - `apps/web/src/components/WorkbenchTaskListPanel.vue`
  - `apps/web/src/views/WorkbenchView.vue`
  - `apps/web/src/lib/i18n.js`
