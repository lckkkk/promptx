# Change: 在设置中集中管理通知配置并支持默认通知配置

## Why

当前通知配置虽然已经支持模板复用，但入口仍然主要挂在任务编辑里，管理路径不集中；同时系统也没有“默认通知配置”的概念，导致用户每次新建任务后还需要再手动选择一次通知配置。

## What Changes

- 在设置弹窗的侧边导航中新增“通知配置”目录，作为通知配置的集中管理入口。
- 在该目录中提供通知配置的列表、新增、编辑、删除能力。
- 支持将某个通知配置设置为默认通知配置。
- 新建任务时，若用户已配置默认通知配置，则任务默认绑定该通知配置。

## Impact

- Affected specs:
  - `task-notification-profiles`
- Affected code:
  - `apps/server/src/systemRoutes.js`
  - `apps/server/src/repository.js`
  - `apps/server/src/systemConfig.js`
  - `apps/web/src/components/WorkbenchSettingsDialog.vue`
  - `apps/web/src/components/EditTaskDialog.vue`
  - `apps/web/src/composables/useWorkbenchTasks.js`
  - `apps/web/src/lib/systemConfigApi.js`
