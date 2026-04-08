# Change: 优化任务创建前项目选择与移动端任务列表交互

## Why

当前任务列表存在三个影响使用效率的交互问题：
- 用户可以在未明确选择项目时直接创建任务，容易先写内容、后发现项目未绑定。
- 手机端任务列表缺少便捷删除手势，删除路径过长。
- 项目筛选只能单选，不利于同时查看多个项目下的任务。

## What Changes

- 调整任务创建入口：创建任务前必须先选择项目；未选择时引导用户先选择项目。
- 为手机端任务列表增加右滑删除交互：右滑出现删除按钮，点击后删除任务。
- 将任务列表项目筛选从单选改为多选，允许同时筛选多个项目。

## Impact

- Affected specs: `workbench-task-list`
- Affected code:
  - `apps/web/src/views/WorkbenchView.vue`
  - `apps/web/src/components/WorkbenchTaskListPanel.vue`
  - `apps/web/src/composables/useWorkbenchTasks.js`
  - `apps/web/src/lib/i18n.js`
