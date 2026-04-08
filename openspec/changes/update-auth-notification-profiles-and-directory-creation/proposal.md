# Change: 收紧登录方式并抽离通知模板与目录创建能力

## Why

当前有三处产品交互已经不再适合后续使用方式：
- `default` 空密码登录仍然可用，不符合正式多用户环境的账号安全要求。
- 任务通知配置直接挂在任务上，重复填写 webhook/secret 成本高，也不利于统一维护。
- 新建项目时选择工作目录只能选已有目录，无法在流程内直接创建目标目录。

## What Changes

- 禁用 `default` 无密码登录，系统必须使用显式配置的用户名和密码登录。
- 将任务通知配置抽离为可复用的“通知模板/通知配置”，任务只选择已配置项，不再重复填写完整通知参数。
- 在新建项目选择工作目录时支持直接新建目录，并在创建成功后可立即选中该目录。

## Impact

- Affected specs:
  - `user-authentication`
  - `task-notification-profiles`
  - `project-directory-picker`
- Affected code:
  - `apps/server/src/authMiddleware.js`
  - `apps/server/src/usersConfig.js`
  - `apps/server/src/repository.js`
  - `apps/server/src/taskAutomation.js`
  - `apps/web/src/components/EditTaskDialog.vue`
  - `apps/web/src/components/CodexDirectoryPickerDialog.vue`
  - `apps/web/src/lib/i18n.js`
