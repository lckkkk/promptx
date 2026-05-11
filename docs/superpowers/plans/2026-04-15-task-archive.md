# 任务归档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为工作台增加可恢复的任务归档能力，使归档任务默认不出现在主列表中，并可在“已归档”视图中查看、恢复与删除。

**Architecture:** 后端以 `archivedAt` 持久化归档状态，并由 `/api/tasks` 通过 `view=active|archived|all` 控制列表返回范围；前端在 `useWorkbenchTasks` 中集中维护当前任务列表视图和刷新逻辑，`WorkbenchTaskListPanel` 只负责切换视图与触发归档/恢复操作。归档仍复用现有 `PUT /api/tasks/:slug` 更新接口，运行中的任务由后端拒绝归档以保证状态一致。

**Tech Stack:** Node.js `node --test`、Fastify、SQLite/better-sqlite3、Vue 3 Composition API、Vite、现有 `request`/`api.js` 封装。

---

### Task 1: 仓储层增加归档状态与列表筛选

**Files:**
- Modify: `apps/server/src/repository.js`
- Test: `apps/server/src/repository.test.js`

- [ ] **Step 1: 写仓储层失败测试，定义归档列表与恢复行为**

```js
test('listTasks hides archived tasks by default and can list archived tasks explicitly', async () => {
  const repository = await import(`./repository.js?test=${Date.now()}`)
  const { createTask, listTasks, updateTask } = repository

  const activeTask = createTask({ title: 'active', visibility: 'private', expiry: 'none' })
  const archivedTask = createTask({ title: 'archived', visibility: 'private', expiry: 'none' })

  updateTask(archivedTask.slug, {
    title: archivedTask.title,
    visibility: archivedTask.visibility,
    expiry: archivedTask.expiry,
    archivedAt: '2026-04-15T08:00:00.000Z',
  })

  assert.deepEqual(listTasks(30).map((item) => item.slug), [activeTask.slug])
  assert.deepEqual(listTasks(30, 'default', { view: 'archived' }).map((item) => item.slug), [archivedTask.slug])
  assert.deepEqual(
    listTasks(30, 'default', { view: 'all' }).map((item) => item.slug),
    [archivedTask.slug, activeTask.slug]
  )
})

test('updateTask clears archivedAt when unarchiving a task', async () => {
  const repository = await import(`./repository.js?test=${Date.now()}`)
  const { createTask, getTaskBySlug, updateTask } = repository

  const task = createTask({ title: 'archivable', visibility: 'private', expiry: 'none' })

  updateTask(task.slug, {
    title: task.title,
    visibility: task.visibility,
    expiry: task.expiry,
    archivedAt: '2026-04-15T08:00:00.000Z',
  })

  const restored = updateTask(task.slug, {
    title: task.title,
    visibility: task.visibility,
    expiry: task.expiry,
    archivedAt: '',
  })

  assert.equal(String(restored.archivedAt || ''), '')
  assert.equal(String(getTaskBySlug(task.slug)?.archivedAt || ''), '')
})
```

- [ ] **Step 2: 运行仓储测试并确认按预期失败**

Run: `pnpm --filter @promptx/server exec node --test apps/server/src/repository.test.js`

Expected: 新增的归档测试失败，报错表现为 `listTasks` 未过滤归档任务，或返回对象中缺少 `archivedAt` 行为。

- [ ] **Step 3: 在仓储层实现 `archivedAt` 持久化与 `view` 筛选**

```js
function normalizeTaskView(input = 'active') {
  const value = String(input || 'active').trim()
  return ['active', 'archived', 'all'].includes(value) ? value : 'active'
}

function normalizeTaskArchivedAtInput(input = {}) {
  return Object.prototype.hasOwnProperty.call(input, 'archivedAt')
    ? String(input.archivedAt || '').trim()
    : null
}

export function listTasks(limit = 30, userId = 'default', options = {}) {
  const normalizedView = normalizeTaskView(options.view)
  const filters = []

  if (normalizedView === 'active') {
    filters.push(`(t.archived_at IS NULL OR t.archived_at = '')`)
  } else if (normalizedView === 'archived') {
    filters.push(`(t.archived_at IS NOT NULL AND t.archived_at != '')`)
  }
}

export function createTask(input = {}, userId = 'default') {
  const archivedAt = String(input.archivedAt || '').trim()
  run(
    `INSERT INTO tasks (..., archived_at, ...) VALUES (..., @archivedAt, ...)`,
    { archivedAt }
  )
}

export function updateTask(slug, input = {}, userId = null) {
  const archivedAtInput = normalizeTaskArchivedAtInput(input)
  const archivedAt = archivedAtInput === null ? current.archivedAt : archivedAtInput
  const changed = archivedAt !== current.archivedAt || otherFieldsChanged

  run(
    `UPDATE tasks SET archived_at = @archivedAt, updated_at = @updatedAt WHERE slug = @slug`,
    { slug, archivedAt, updatedAt }
  )
}
```

- [ ] **Step 4: 重新运行仓储测试确认通过**

Run: `pnpm --filter @promptx/server exec node --test apps/server/src/repository.test.js`

Expected: `PASS`，新增两个归档测试与原有仓储测试全部通过。

### Task 2: 路由层支持归档视图并阻止运行中归档

**Files:**
- Modify: `apps/server/src/taskRoutes.js`
- Test: `apps/server/src/taskRoutes.test.js`

- [ ] **Step 1: 写路由失败测试，定义视图查询与运行中归档限制**

```js
test('task routes pass archived view to listTasks', async () => {
  const calls = []
  const app = buildApp({
    listTasks(limit, userId, options) {
      calls.push({ limit, userId, options })
      return []
    },
    decorateTaskList: (items) => items,
  })

  const response = await app.inject({
    method: 'GET',
    url: '/api/tasks?view=archived',
  })

  assert.equal(response.statusCode, 200)
  assert.equal(calls[0].options.view, 'archived')
})

test('task routes reject archiving a running task', async () => {
  const app = buildApp({
    getRunningCodexRunByTaskSlug(slug) {
      return slug === 'task-1' ? { id: 'run-1', status: 'running' } : null
    },
    updateTask() {
      throw new Error('should not be called')
    },
  })

  const response = await app.inject({
    method: 'PUT',
    url: '/api/tasks/task-1',
    payload: {
      title: 'task-1',
      visibility: 'private',
      expiry: 'none',
      archivedAt: '2026-04-15T08:00:00.000Z',
    },
  })

  assert.equal(response.statusCode, 409)
  assert.equal(response.json().messageKey, 'errors.taskArchiveWhileRunning')
})
```

- [ ] **Step 2: 运行路由测试并确认新增用例失败**

Run: `pnpm --filter @promptx/server exec node --test apps/server/src/taskRoutes.test.js`

Expected: `GET /api/tasks?view=archived` 测试失败，或运行中归档返回状态不符合预期。

- [ ] **Step 3: 在路由层增加 `view` 查询转发与归档保护**

```js
app.get('/api/tasks', async (request) => {
  purgeExpiredContent()
  const userId = request.user?.username || 'default'
  return {
    items: decorateTaskList(listTasks(30, userId, {
      view: request.query?.view,
    })),
  }
})

app.put('/api/tasks/:slug', async (request, reply) => {
  const isArchiving = String(request.body?.archivedAt || '').trim()
  if (isArchiving && getRunningCodexRunByTaskSlug(request.params.slug)) {
    return reply.code(409).send({
      messageKey: 'errors.taskArchiveWhileRunning',
      message: '当前任务正在执行中，请先停止后再归档。',
    })
  }

  const result = updateTask(request.params.slug, request.body || {}, userId)
  if (result.error === 'not_found') {
    return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
  }
  return decorateTask(result)
})
```

- [ ] **Step 4: 重新运行路由测试确认通过**

Run: `pnpm --filter @promptx/server exec node --test apps/server/src/taskRoutes.test.js`

Expected: `PASS`，新增归档测试与现有路由测试全部通过。

### Task 3: 前端 API 与 `useWorkbenchTasks` 支持归档视图和归档/恢复动作

**Files:**
- Modify: `apps/web/src/lib/api.js`
- Modify: `apps/web/src/composables/useWorkbenchTasks.js`
- Test: `apps/web/src/composables/useWorkbenchTasks.test.js`

- [ ] **Step 1: 写 composable 失败测试，定义默认只拉 active 视图和归档后切换列表**

```js
test('initializeWorkbench requests active task view by default', async () => {
  const requests = []
  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: String(options.method || 'GET').toUpperCase() })
    if (String(url).includes('/api/tasks?view=active')) {
      return createJsonResponse({ items: [] })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  const workbench = useWorkbenchTasks()
  await workbench.initializeWorkbench()

  assert.equal(requests[0].url.includes('view=active'), true)
})

test('archiveTask removes current task from active list and keeps archived view restorable', async () => {
  const originalFetch = global.fetch
  const originalWindow = global.window
  const requests = []
  let activeItems = [
    {
      slug: 'task-1',
      title: 'task 1',
      autoTitle: '',
      lastPromptPreview: '',
      codexSessionId: '',
      codexRunCount: 0,
      todoCount: 0,
      running: false,
      updatedAt: '2026-04-15T08:00:00.000Z',
      createdAt: '2026-04-15T08:00:00.000Z',
      archivedAt: '',
    },
  ]
  let archivedItems = []

  global.window = {
    location: {
      href: 'http://localhost:4173/',
      origin: 'http://localhost:4173',
      pathname: '/',
      search: '',
    },
    localStorage: createMemoryLocalStorage(),
    history: { replaceState() {} },
    EventSource: class {
      close() {}
    },
    setTimeout,
    clearTimeout,
  }

  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url)
    const method = String(options.method || 'GET').toUpperCase()
    requests.push({ requestUrl, method })

    if (requestUrl.includes('/api/tasks?view=active') && method === 'GET') {
      return createJsonResponse({ items: activeItems })
    }
    if (requestUrl.includes('/api/tasks?view=archived') && method === 'GET') {
      return createJsonResponse({ items: archivedItems })
    }
    if (requestUrl.endsWith('/api/tasks/task-1') && method === 'GET') {
      return createJsonResponse({
        ...activeItems[0],
        blocks: [{ id: 1, type: 'text', content: 'task body', meta: {} }],
        todoItems: [],
      })
    }
    if (requestUrl.endsWith('/api/tasks/task-1') && method === 'PUT') {
      activeItems = []
      archivedItems = [
        {
          slug: 'task-1',
          title: 'task 1',
          autoTitle: '',
          lastPromptPreview: '',
          codexSessionId: '',
          codexRunCount: 0,
          todoCount: 0,
          running: false,
          updatedAt: '2026-04-15T08:05:00.000Z',
          createdAt: '2026-04-15T08:00:00.000Z',
          archivedAt: '2026-04-15T08:05:00.000Z',
          blocks: [{ id: 1, type: 'text', content: 'task body', meta: {} }],
          todoItems: [],
        },
      ]
      return createJsonResponse(archivedItems[0])
    }

    throw new Error(`Unexpected fetch: ${method} ${requestUrl}`)
  }

  try {
    const workbench = useWorkbenchTasks()
    await workbench.initializeWorkbench()
    await workbench.archiveTask('task-1')

    assert.deepEqual(workbench.tasks.value.map((item) => item.slug), [])
    await workbench.setTaskListView('archived')
    await workbench.refreshTaskList({ view: 'archived' })
    assert.deepEqual(workbench.tasks.value.map((item) => item.slug), ['task-1'])
    assert.equal(requests.some((item) => item.requestUrl.includes('view=archived')), true)
  } finally {
    global.fetch = originalFetch
    global.window = originalWindow
  }
})
```

- [ ] **Step 2: 运行 composable 测试并确认新增用例失败**

Run: `pnpm --filter @promptx/web exec node --test apps/web/src/composables/useWorkbenchTasks.test.js`

Expected: 失败原因应是 `listTasks` 未带 `view` 查询参数，且 composable 不存在归档视图状态或归档动作。

- [ ] **Step 3: 扩展前端 API 和 composable 状态机**

```js
// apps/web/src/lib/api.js
export function listTasks(view = 'active') {
  const params = new URLSearchParams()
  params.set('view', String(view || 'active'))
  return request(`/api/tasks?${params.toString()}`)
}

// apps/web/src/composables/useWorkbenchTasks.js
const taskListView = ref('active')

function setTaskListView(view = 'active') {
  taskListView.value = view === 'archived' ? 'archived' : 'active'
}

async function refreshTaskList(options = {}) {
  const view = options.view || taskListView.value
  const payload = await listTasks(view)
  tasks.value = mergeTaskSummariesWithWorkspaceDiff(tasks.value, (payload.items || []).map(toTaskSummary))
}

async function archiveTask(taskSlug = currentTaskSlug.value) {
  return updateTask(taskSlug, { archivedAt: new Date().toISOString() })
}

async function restoreTask(taskSlug = currentTaskSlug.value) {
  return updateTask(taskSlug, { archivedAt: '' })
}
```

- [ ] **Step 4: 补齐当前任务切换和空列表兜底逻辑**

```js
async function archiveTask(taskSlug = currentTaskSlug.value) {
  const updated = await updateTask(taskSlug, { archivedAt: new Date().toISOString() })
  await refreshTaskList()

  if (taskListView.value === 'active' && taskSlug === currentTaskSlug.value) {
    const nextSlug = tasks.value[0]?.slug || ''
    if (nextSlug) {
      await loadTask(nextSlug, { focusEditor: true, force: true })
    } else {
      currentTaskSlug.value = ''
      draft.value = { title: '', autoTitle: '', lastPromptPreview: '', codexSessionId: '', blocks: [], todoItems: [] }
    }
  }

  return updated
}

async function restoreTask(taskSlug = currentTaskSlug.value) {
  const updated = await updateTask(taskSlug, { archivedAt: '' })
  if (taskListView.value === 'archived') {
    await refreshTaskList()
  }
  return updated
}
```

- [ ] **Step 5: 重新运行 composable 测试确认通过**

Run: `pnpm --filter @promptx/web exec node --test apps/web/src/composables/useWorkbenchTasks.test.js`

Expected: `PASS`，新增归档视图与归档/恢复测试通过，已有测试不回归。

### Task 4: 任务列表面板增加视图切换和归档/恢复入口

**Files:**
- Modify: `apps/web/src/components/WorkbenchTaskListPanel.vue`
- Modify: `apps/web/src/views/WorkbenchView.vue`
- Optional Modify: `apps/web/src/lib/i18n.js`
- Optional Test: `apps/web/src/lib/workbenchTaskList.test.js`

- [ ] **Step 1: 在视图层先接线失败状态，暴露新的 props 和事件**

```vue
<!-- apps/web/src/views/WorkbenchView.vue -->
const {
  archiveTask,
  restoreTask,
  setTaskListView,
  taskListView,
} = useWorkbenchTasks({
  clearToast,
  flashToast,
  scrollCurrentPanelToBottom,
})

const taskListPanelProps = computed(() => ({
  codexSessions: codexSessionsForPanel.value,
  multiUser: authInfo.value.multiUser,
  currentUsername: authInfo.value.username,
  creatingTask: creatingTask.value,
  currentTaskAutoTitle: draft.value.autoTitle || currentTaskAutoTitle.value,
  currentTaskSlug: currentTaskSlug.value,
  draftTitle: draft.value.title,
  editingTaskTitleSlug: editingTaskTitleSlug.value,
  error: error.value,
  isCurrentTaskSending: isCurrentTaskSending.value,
  loadingTask: loadingTask.value,
  loadingTasks: loadingTasks.value,
  removingTask: removingTask.value,
  taskListView: taskListView.value,
  tasks: renderedTasks.value,
  uploading: uploading.value,
}))

const taskListPanelListeners = {
  'update:draftTitle': updateDraftTitle,
  'cancel-title-edit': () => {
    editingTaskTitleSlug.value = ''
  },
  'create-task': handleCreateTask,
  'edit-task': openEditTaskDialog,
  'delete-task': openDeleteDialog,
  'manage-projects': openProjectManagerDialog,
  'open-settings': openSettingsDialog,
  'reorder-task': handleTaskReorder,
  'select-task': handleTaskSelect,
  'title-blur': handleTaskTitleBlur,
  'title-click': handleTaskTitleClick,
  'archive-task': () => archiveTask(),
  'restore-task': () => restoreTask(),
  'change-task-list-view': setTaskListView,
}
```

- [ ] **Step 2: 手工运行前端构建前，先实现列表面板 UI 最小改动**

```vue
<!-- apps/web/src/components/WorkbenchTaskListPanel.vue -->
const props = defineProps({
  taskListView: {
    type: String,
    default: 'active',
  },
})

const emit = defineEmits([
  'open-settings',
  'manage-projects',
  'create-task',
  'reorder-task',
  'select-task',
  'title-click',
  'title-blur',
  'cancel-title-edit',
  'update:draftTitle',
  'edit-task',
  'delete-task',
  'archive-task',
  'restore-task',
  'change-task-list-view',
])
```

```vue
<div class="mt-3 grid grid-cols-2 gap-2">
  <button
    type="button"
    class="tool-button px-3 py-2 text-xs"
    :class="taskListView === 'active' ? 'tool-button-accent-subtle' : ''"
    @click="emit('change-task-list-view', 'active')"
  >
    {{ t('workbench.activeTasks') }}
  </button>
  <button
    type="button"
    class="tool-button px-3 py-2 text-xs"
    :class="taskListView === 'archived' ? 'tool-button-accent-subtle' : ''"
    @click="emit('change-task-list-view', 'archived')"
  >
    {{ t('workbench.archivedTasks') }}
  </button>
</div>
```

- [ ] **Step 3: 根据当前视图切换底部操作区按钮**

```vue
<button
  v-if="taskListView === 'active'"
  type="button"
  class="tool-button inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
  :disabled="!currentTaskSlug || removingTask || creatingTask || isCurrentTaskSending"
  @click="emit('archive-task')"
>
  <Archive class="h-4 w-4" />
  <span>{{ t('workbench.archiveTask') }}</span>
</button>

<button
  v-else
  type="button"
  class="tool-button inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
  :disabled="!currentTaskSlug || removingTask || creatingTask"
  @click="emit('restore-task')"
>
  <ArchiveRestore class="h-4 w-4" />
  <span>{{ t('workbench.restoreTask') }}</span>
</button>
```

- [ ] **Step 4: 补充空状态和必要文案**

```js
// apps/web/src/lib/i18n.js
workbench: {
  activeTasks: '进行中',
  archivedTasks: '已归档',
  archiveTask: '归档任务',
  restoreTask: '取消归档',
  emptyArchivedTasks: '还没有已归档任务',
}
```

```vue
<div v-if="!loadingTasks && !filteredTasks.length" class="theme-empty-state px-3 py-4 text-sm">
  {{ taskListView === 'archived' ? t('workbench.emptyArchivedTasks') : t('workbench.loadingTasks') }}
</div>
```

- [ ] **Step 5: 运行前端构建验证模板和脚本无误**

Run: `pnpm build`

Expected: 构建通过，`apps/web` 无模板编译错误或未定义事件/变量错误。

### Task 5: 全量验证并执行本地更新流程

**Files:**
- No code changes expected

- [ ] **Step 1: 运行服务端测试**

Run: `pnpm --filter @promptx/server exec node --test apps/server/src/repository.test.js apps/server/src/taskRoutes.test.js`

Expected: `PASS`，归档相关仓储与路由测试均通过。

- [ ] **Step 2: 运行前端测试**

Run: `pnpm --filter @promptx/web exec node --test apps/web/src/composables/useWorkbenchTasks.test.js apps/web/src/lib/workbenchTaskList.test.js`

Expected: `PASS`，归档视图与任务列表逻辑测试通过。

- [ ] **Step 3: 执行工作区构建**

Run: `pnpm build`

Expected: 工作区构建成功，无新增报错。

- [ ] **Step 4: 执行本地更新与重启**

Run: `pnpm local:update`

Expected: 本地更新流程完成，项目按仓库约定通过该流程重启成功。

- [ ] **Step 5: 手动冒烟检查**

Run:

```text
1. 打开工作台，确认默认只看到未归档任务
2. 归档一个普通任务，确认它从主列表消失
3. 切到“已归档”，确认能看到该任务
4. 在“已归档”视图中取消归档，确认任务回到默认列表
5. 对一个运行中的任务尝试归档，确认前后端都阻止该操作
```

Expected: 以上行为全部符合规格，无明显回归。
