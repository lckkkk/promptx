# Task Archive UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让工作台任务列表默认只显示未归档任务，并提供三态切换、归档确认，以及移动端右滑归档/删除双操作。

**Architecture:** 复用后端已存在的 `archivedAt` 字段、`view=active|all|archived` 列表能力和归档拦截逻辑。前端在 `useWorkbenchTasks` 中集中维护列表视图状态、归档/取消归档操作和默认筛选，在 `WorkbenchView` 统一管理确认弹窗，在 `WorkbenchTaskListPanel` 只承载展示与交互发射。

**Tech Stack:** Vue 3、Vite、Fastify、Node 内置测试、现有 ConfirmDialog 组件

---

### Task 1: 前端 API 与列表视图状态

**Files:**
- Modify: `apps/web/src/lib/taskApi.js`
- Modify: `apps/web/src/composables/useWorkbenchTasks.js`
- Test: `apps/web/src/composables/useWorkbenchTasks.test.js`

- [ ] 为 `listTasks` 增加 `view` 参数并补失败测试
- [ ] 在 `useWorkbenchTasks` 中增加任务视图状态，默认 `active`
- [ ] 刷新列表时携带 `view`
- [ ] 归档后在 `active` 视图中移除任务，取消归档后在 `archived` 视图中移除任务

### Task 2: 归档/取消归档动作

**Files:**
- Modify: `apps/web/src/composables/useWorkbenchTasks.js`
- Modify: `apps/web/src/lib/i18n.js`
- Test: `apps/web/src/composables/useWorkbenchTasks.test.js`

- [ ] 为 `useWorkbenchTasks` 增加 `archiveTaskBySlug` / `restoreTaskBySlug`
- [ ] 复用 `updateTask` 写入 `archivedAt`
- [ ] 补 toast、错误信息和运行中任务失败场景验证

### Task 3: 工作台弹窗与事件编排

**Files:**
- Modify: `apps/web/src/views/WorkbenchView.vue`
- Modify: `apps/web/src/components/WorkbenchTaskListPanel.vue`

- [ ] 任务列表面板新增三态切换与归档事件
- [ ] `WorkbenchView` 新增归档确认弹窗状态
- [ ] 桌面端归档点击先确认
- [ ] 移动端右滑同时展示归档/删除，已归档视图改为取消归档/删除

### Task 4: 文案与验证

**Files:**
- Modify: `apps/web/src/lib/i18n.js`
- Modify: `apps/web/src/components/WorkbenchTaskListPanel.vue`

- [ ] 补齐归档相关文案
- [ ] 跑 `corepack pnpm --filter @promptx/web test`
- [ ] 跑 `corepack pnpm build`
- [ ] 跑 `corepack pnpm local:update`
