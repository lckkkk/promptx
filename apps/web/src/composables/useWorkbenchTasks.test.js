import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick } from 'vue'

import {
  buildBlocksFromTodoItems,
  buildPromptPreview,
  deriveTaskPreview,
  isActiveRunStatus,
  isCurrentTaskSendingState,
  isTaskRunning,
  mergeTaskSummariesWithWorkspaceDiff,
  reorderTaskSummaries,
  resolveTaskDisplayTitle,
  shouldRefreshWorkspaceDiffSummaries,
  useWorkbenchTasks,
} from './useWorkbenchTasks.js'

test('resolveTaskDisplayTitle prefers manual title over auto title and preview', () => {
  const title = resolveTaskDisplayTitle({
    title: '手动标题',
    autoTitle: '自动标题',
    preview: '预览标题',
  }, [
    { type: 'text', content: '这是正文内容' },
  ])

  assert.equal(title, '手动标题')
})

test('resolveTaskDisplayTitle falls back to derived title from blocks', () => {
  const title = resolveTaskDisplayTitle({}, [
    { type: 'text', content: '这是一个很长很长的需求标题，应该被自动截断' },
  ])

  assert.equal(title, '这是一个很长很长的需求标题，应该')
})

test('deriveTaskPreview compacts whitespace and uses first text-like block', () => {
  const preview = deriveTaskPreview([
    { type: 'image', content: '/demo.png' },
    { type: 'imported_text', content: '  第一行\n\n第二行   第三行  ' },
  ], 20)

  assert.equal(preview, '第一行 第二行 第三行')
})

test('buildPromptPreview trims whitespace and limits length', () => {
  const preview = buildPromptPreview('  hello\n\nworld   from   promptx  ', 12)
  assert.equal(preview, 'hello world ')
})

test('buildBlocksFromTodoItems replaces editor blocks with numbered text when multiple todos are selected', () => {
  const blocks = buildBlocksFromTodoItems([
    {
      id: 'todo-1',
      blocks: [{ type: 'text', content: '第一条待办' }],
    },
    {
      id: 'todo-2',
      blocks: [{ type: 'text', content: '第二条待办' }],
    },
  ], {
    existingBlocks: [{ type: 'text', content: '原有内容' }],
    append: false,
  })

  assert.deepEqual(
    blocks.map((block) => ({ type: block.type, content: block.content })),
    [
      { type: 'text', content: '1. 第一条待办;\n2. 第二条待办;' },
    ]
  )
})

test('buildBlocksFromTodoItems appends numbered text without blank separator blocks for multiple todos', () => {
  const blocks = buildBlocksFromTodoItems([
    {
      id: 'todo-1',
      blocks: [{ type: 'text', content: '追加待办 A' }],
    },
    {
      id: 'todo-2',
      blocks: [{ type: 'text', content: '追加待办 B' }],
    },
  ], {
    existingBlocks: [{ type: 'text', content: '当前输入' }],
    append: true,
  })

  assert.deepEqual(
    blocks.map((block) => ({ type: block.type, content: block.content })),
    [
      { type: 'text', content: '当前输入' },
      { type: 'text', content: '1. 追加待办 A;\n2. 追加待办 B;' },
    ]
  )
})

test('isTaskRunning only trusts persisted task running state', () => {
  assert.equal(isTaskRunning({ running: true }), true)
  assert.equal(isTaskRunning({ running: false }), false)
  assert.equal(isTaskRunning({}), false)
})

test('isCurrentTaskSendingState keeps current task disabled during local optimistic send', () => {
  assert.equal(isCurrentTaskSendingState({ running: false }, true), true)
  assert.equal(isCurrentTaskSendingState({ running: true }, false), true)
  assert.equal(isCurrentTaskSendingState({ running: false }, false), false)
})

test('isActiveRunStatus matches queued through stopping only', () => {
  assert.equal(isActiveRunStatus('queued'), true)
  assert.equal(isActiveRunStatus('running'), true)
  assert.equal(isActiveRunStatus('stopping'), true)
  assert.equal(isActiveRunStatus('completed'), false)
  assert.equal(isActiveRunStatus('error'), false)
})

test('reorderTaskSummaries follows explicit slug order', () => {
  const reordered = reorderTaskSummaries([
    { slug: 'a' },
    { slug: 'b' },
    { slug: 'c' },
  ], ['c', 'a', 'b'])

  assert.deepEqual(reordered.map((item) => item.slug), ['c', 'a', 'b'])
})

test('reorderTaskSummaries preserves unknown trailing items', () => {
  const reordered = reorderTaskSummaries([
    { slug: 'a' },
    { slug: 'b' },
    { slug: 'c' },
  ], ['b', 'a'])

  assert.deepEqual(reordered.map((item) => item.slug), ['b', 'a', 'c'])
})

test('mergeTaskSummariesWithWorkspaceDiff preserves summary for same session', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 3,
        additions: 10,
        deletions: 2,
        statsComplete: true,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
    },
  ])

  assert.deepEqual(merged[0].workspaceDiffSummary, {
    supported: true,
    fileCount: 3,
    additions: 10,
    deletions: 2,
    statsComplete: true,
  })
})

test('mergeTaskSummariesWithWorkspaceDiff follows server task order', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-a',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
    {
      slug: 'task-b',
      codexSessionId: 'session-b',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 2,
      },
    },
  ], [
    {
      slug: 'task-b',
      codexSessionId: 'session-b',
    },
    {
      slug: 'task-a',
      codexSessionId: 'session-a',
    },
  ])

  assert.deepEqual(merged.map((item) => item.slug), ['task-b', 'task-a'])
  assert.equal(merged[0].workspaceDiffSummary?.fileCount, 2)
  assert.equal(merged[1].workspaceDiffSummary?.fileCount, 1)
})

test('mergeTaskSummariesWithWorkspaceDiff clears summary when session changes', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 3,
        additions: 10,
        deletions: 2,
        statsComplete: true,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-b',
    },
  ])

  assert.equal(merged[0].workspaceDiffSummary, null)
})

test('mergeTaskSummariesWithWorkspaceDiff clears summary when session is removed', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 3,
        additions: 10,
        deletions: 2,
        statsComplete: true,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: '',
    },
  ])

  assert.equal(merged[0].workspaceDiffSummary, null)
})

test('shouldRefreshWorkspaceDiffSummaries refreshes on initial load when session exists', () => {
  assert.equal(shouldRefreshWorkspaceDiffSummaries([], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: null,
    },
  ]), true)
})

test('shouldRefreshWorkspaceDiffSummaries skips refresh when list shape and session state are stable', () => {
  assert.equal(shouldRefreshWorkspaceDiffSummaries([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ]), false)
})

test('shouldRefreshWorkspaceDiffSummaries refreshes when running state changes', () => {
  assert.equal(shouldRefreshWorkspaceDiffSummaries([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: true,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ]), true)
})

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'content-type' ? 'application/json' : null
      },
    },
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
  }
}

function createMemoryLocalStorage() {
  const store = new Map()
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null
    },
    setItem(key, value) {
      store.set(String(key), String(value))
    },
    removeItem(key) {
      store.delete(String(key))
    },
  }
}

test('initializeWorkbench marks opened unread task as read and clears local badge', async () => {
  const originalFetch = global.fetch
  const originalWindow = global.window

  const readStateRequests = []
  const taskListPayload = {
    items: [
      {
        slug: 'task-1',
        title: '未读任务',
        autoTitle: '',
        lastPromptPreview: '刚跑完',
        codexSessionId: '',
        codexRunCount: 1,
        todoCount: 0,
        running: false,
        updatedAt: '2026-04-08T10:00:00.000Z',
        createdAt: '2026-04-08T09:00:00.000Z',
        unread: true,
        latestCompletedRunFinishedAt: '2026-04-08T10:00:00.000Z',
      },
    ],
  }
  const taskDetailPayload = {
    slug: 'task-1',
    title: '未读任务',
    autoTitle: '',
    lastPromptPreview: '刚跑完',
    codexSessionId: '',
    codexRunCount: 1,
    todoCount: 0,
    running: false,
    updatedAt: '2026-04-08T10:00:00.000Z',
    createdAt: '2026-04-08T09:00:00.000Z',
    unread: true,
    latestCompletedRunFinishedAt: '2026-04-08T10:00:00.000Z',
    blocks: [
      { id: 1, type: 'text', content: 'hello', meta: {} },
    ],
    todoItems: [],
  }

  global.window = {
    location: {
      href: 'http://localhost:4173/',
      origin: 'http://localhost:4173',
      pathname: '/',
      search: '',
    },
    localStorage: createMemoryLocalStorage(),
    history: {
      replaceState() {},
    },
    EventSource: class {
      close() {}
    },
    setTimeout,
    clearTimeout,
  }

  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url)
    const method = String(options.method || 'GET').toUpperCase()

    if (requestUrl.endsWith('/api/tasks') && method === 'GET') {
      return createJsonResponse(taskListPayload)
    }

    if (requestUrl.endsWith('/api/tasks/task-1') && method === 'GET') {
      return createJsonResponse(taskDetailPayload)
    }

    if (requestUrl.endsWith('/api/tasks/task-1/read-state') && method === 'POST') {
      readStateRequests.push(JSON.parse(String(options.body || '{}')))
      return createJsonResponse({
        ok: true,
        lastReadRunFinishedAt: '2026-04-08T10:00:00.000Z',
      })
    }

    throw new Error(`Unexpected fetch: ${method} ${requestUrl}`)
  }

  try {
    const workbench = useWorkbenchTasks()
    await workbench.initializeWorkbench()
    await nextTick()

    assert.equal(readStateRequests.length, 1)
    assert.deepEqual(readStateRequests[0], {
      finishedAt: '2026-04-08T10:00:00.000Z',
    })
    assert.equal(workbench.renderedTasks.value[0].unread, false)
  } finally {
    global.fetch = originalFetch
    global.window = originalWindow
  }
})

test('initializeWorkbench still marks task as read when detail unread flag is stale but terminal run timestamp exists', async () => {
  const originalFetch = global.fetch
  const originalWindow = global.window

  const readStateRequests = []
  const taskListPayload = {
    items: [
      {
        slug: 'task-1',
        title: '未读任务',
        autoTitle: '',
        lastPromptPreview: '刚跑完',
        codexSessionId: '',
        codexRunCount: 1,
        todoCount: 0,
        running: false,
        updatedAt: '2026-04-08T10:00:00.000Z',
        createdAt: '2026-04-08T09:00:00.000Z',
        unread: true,
        latestCompletedRunFinishedAt: '2026-04-08T10:00:00.000Z',
      },
    ],
  }
  const taskDetailPayload = {
    slug: 'task-1',
    title: '未读任务',
    autoTitle: '',
    lastPromptPreview: '刚跑完',
    codexSessionId: '',
    codexRunCount: 1,
    todoCount: 0,
    running: false,
    updatedAt: '2026-04-08T10:00:00.000Z',
    createdAt: '2026-04-08T09:00:00.000Z',
    unread: false,
    latestCompletedRunFinishedAt: '2026-04-08T10:00:00.000Z',
    blocks: [
      { id: 1, type: 'text', content: 'hello', meta: {} },
    ],
    todoItems: [],
  }

  global.window = {
    location: {
      href: 'http://localhost:4173/',
      origin: 'http://localhost:4173',
      pathname: '/',
      search: '',
    },
    localStorage: createMemoryLocalStorage(),
    history: {
      replaceState() {},
    },
    EventSource: class {
      close() {}
    },
    setTimeout,
    clearTimeout,
  }

  global.fetch = async (url, options = {}) => {
    const requestUrl = String(url)
    const method = String(options.method || 'GET').toUpperCase()

    if (requestUrl.endsWith('/api/tasks') && method === 'GET') {
      return createJsonResponse(taskListPayload)
    }

    if (requestUrl.endsWith('/api/tasks/task-1') && method === 'GET') {
      return createJsonResponse(taskDetailPayload)
    }

    if (requestUrl.endsWith('/api/tasks/task-1/read-state') && method === 'POST') {
      readStateRequests.push(JSON.parse(String(options.body || '{}')))
      return createJsonResponse({
        ok: true,
        lastReadRunFinishedAt: '2026-04-08T10:00:00.000Z',
      })
    }

    throw new Error(`Unexpected fetch: ${method} ${requestUrl}`)
  }

  try {
    const workbench = useWorkbenchTasks()
    await workbench.initializeWorkbench()
    await nextTick()

    assert.equal(readStateRequests.length, 1)
    assert.deepEqual(readStateRequests[0], {
      finishedAt: '2026-04-08T10:00:00.000Z',
    })
  } finally {
    global.fetch = originalFetch
    global.window = originalWindow
  }
})
