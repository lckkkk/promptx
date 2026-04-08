# Change: 增加任务内项目文件浏览器

## Why

当前任务页只能查看代码变更范围，无法直接浏览任务绑定项目的完整目录和文件内容。用户需要在任务上下文中直接查看项目全量文件，以便快速核对目录结构、非变更文件和配置文件，而不用切换到外部编辑器。

## What Changes

- 在任务页增加“文件”入口，提供任务内项目文件浏览器
- 支持浏览当前任务绑定项目工作目录下的完整目录树
- 支持在任务页中预览文本文件内容
- 对二进制文件和超大文件提供只读占位反馈，不支持编辑
- 严格限制浏览范围在当前任务绑定项目的工作目录内

## Impact

- Affected specs: `task-file-browser`
- Affected code:
  - `apps/server/src/codexRoutes.js`
  - `apps/server/src/workspaceFiles.js`
  - `apps/web/src/components/WorkbenchView.vue`
  - `apps/web/src/components/TaskDiffReviewDialog.vue`
  - `apps/web/src/composables/useWorkspacePickerData.js`
  - `apps/web/src/lib/codexApi.js`
