# Change: 支持工作目录下多 Git 仓库的代码变更查看

## Why

当前任务的“代码变更”只会读取项目工作目录对应的单一 Git 仓库。如果工作目录下包含多个子项目、且这些子项目本身各自是独立 Git 仓库，用户在 PromptX 里看不到这些子仓库的改动，导致代码审查范围不完整。

## What Changes

- 扩展工作区代码变更摘要：从“单仓库”升级为“工作目录下所有相关 Git 仓库聚合”
- 扩展 Diff 详情接口：支持查看聚合后的多仓库文件变更，并标识文件所属仓库
- 调整前端代码变更面板：在摘要和文件列表中展示仓库维度信息，避免多个子仓库文件混淆
- 保持已有 `task / run / workspace` 三种 diff scope 语义，但 `workspace` scope 的底层数据来源改为多仓库聚合

## Impact

- Affected specs: `workspace-git-diff`
- Affected code:
  - `apps/server/src/gitDiff.js`
  - `apps/server/src/taskRoutes.js`
  - `apps/server/src/gitDiff.test.js`
  - `apps/web/src/composables/useTaskDiffReviewData.js`
  - `apps/web/src/components/TaskDiffReviewPanel.vue`
  - `apps/web/src/components/TaskDiffFileList.vue`
  - `apps/web/src/components/WorkbenchTaskListPanel.vue`

