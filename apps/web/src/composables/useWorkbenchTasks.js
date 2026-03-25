import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { BLOCK_TYPES, deriveTitleFromBlocks } from '@promptx/shared'
import {
  createTask,
  deleteTask,
  getApiBase,
  getTask,
  importPdf,
  listTasks,
  listTaskWorkspaceDiffSummaries,
  resolveAssetUrl,
  updateTaskCodexSession,
  updateTask,
  uploadImage,
} from '../lib/api.js'
import { buildCodexPrompt } from '../lib/codex.js'
import { useWorkbenchRealtime } from './useWorkbenchRealtime.js'

const ACTIVE_TASK_STORAGE_KEY = 'promptx:active-task-slug'
const SERVER_SYNC_DELAY = 150

function normalizeWorkspaceDiffSummary(summary = null) {
  if (!summary || typeof summary !== 'object') {
    return null
  }

  return {
    supported: Boolean(summary.supported),
    fileCount: Math.max(0, Number(summary.fileCount) || 0),
    additions: Math.max(0, Number(summary.additions) || 0),
    deletions: Math.max(0, Number(summary.deletions) || 0),
    statsComplete: Boolean(summary.statsComplete),
  }
}

function cloneBlocks(blocks = []) {
  return (blocks || []).map((block) => ({
    ...block,
    meta: block?.meta ? { ...block.meta } : {},
  }))
}

function cloneTodoItems(items = []) {
  return (items || []).map((item) => ({
    id: String(item?.id || '').trim(),
    createdAt: String(item?.createdAt || ''),
    blocks: cloneBlocks(item?.blocks || []),
  }))
}

function cloneDraftState(state = {}) {
  return {
    title: String(state.title || ''),
    autoTitle: String(state.autoTitle || ''),
    lastPromptPreview: String(state.lastPromptPreview || ''),
    codexSessionId: String(state.codexSessionId || ''),
    blocks: cloneBlocks(state.blocks || []),
    todoItems: cloneTodoItems(state.todoItems || []),
  }
}

function normalizeTodoItemBlocks(blocks = []) {
  return cloneBlocks(blocks).filter((block) => {
    if (block?.type === BLOCK_TYPES.IMAGE) {
      return Boolean(String(block.content || '').trim())
    }

    return Boolean(String(block?.content || '').trim())
  })
}

function hasMeaningfulBlocks(blocks = []) {
  return normalizeTodoItemBlocks(blocks).length > 0
}

function createTodoItemId() {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) {
    return `todo-${randomUuid}`
  }

  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function deriveAutoTaskTitle(blocks = [], max = 16) {
  return deriveTitleFromBlocks(blocks, max) || ''
}

export function deriveTaskPreview(blocks = [], max = 120) {
  const firstTextBlock = blocks.find((block) => {
    const isTextBlock = block?.type === 'text' || block?.type === 'imported_text'
    return isTextBlock && String(block.content || '').trim()
  })

  return String(firstTextBlock?.content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function resolveTaskDisplayTitle(task = {}, blocks = []) {
  const manualTitle = String(task?.title || '').trim()
  if (manualTitle) {
    return manualTitle
  }

  const cachedAutoTitle = String(task?.autoTitle || '').trim()
  if (cachedAutoTitle) {
    return cachedAutoTitle
  }

  const derivedFromBlocks = deriveAutoTaskTitle(blocks)
  if (derivedFromBlocks) {
    return derivedFromBlocks
  }

  const preview = String(task?.preview || '').trim()
  if (preview) {
    return preview.slice(0, 16)
  }

  return '未命名任务'
}

export function isTaskRunning(task = {}) {
  return Boolean(task?.running)
}

export function isCurrentTaskSendingState(task = {}, localSending = false) {
  return Boolean(isTaskRunning(task) || localSending)
}

export function getCurrentTaskSendState(task = {}, localSending = false) {
  if (Boolean(localSending) && !isTaskRunning(task)) {
    return 'sending'
  }

  if (isTaskRunning(task)) {
    return 'running'
  }

  return 'idle'
}

export function isActiveRunStatus(status = '') {
  return ['queued', 'starting', 'running', 'stopping'].includes(String(status || '').trim())
}

export function buildPromptPreview(prompt = '', max = 72) {
  return String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function mergeTaskSummariesWithWorkspaceDiff(prevItems = [], nextItems = []) {
  const previousBySlug = new Map(
    (prevItems || [])
      .map((item) => {
        const slug = String(item?.slug || '').trim()
        return slug ? [slug, item] : null
      })
      .filter(Boolean)
  )

  const normalizedNextItems = (nextItems || []).map((item) => {
    const slug = String(item?.slug || '').trim()
    const nextSessionId = String(item?.codexSessionId || '').trim()

    if (!slug) {
      return item
    }

    if (Object.prototype.hasOwnProperty.call(item, 'workspaceDiffSummary')) {
      return {
        ...item,
        workspaceDiffSummary: normalizeWorkspaceDiffSummary(item.workspaceDiffSummary),
      }
    }

    if (!nextSessionId) {
      return {
        ...item,
        workspaceDiffSummary: null,
      }
    }

    const previousItem = previousBySlug.get(slug)
    const previousSessionId = String(previousItem?.codexSessionId || '').trim()
    if (previousSessionId && previousSessionId === nextSessionId) {
      return {
        ...item,
        workspaceDiffSummary: normalizeWorkspaceDiffSummary(previousItem.workspaceDiffSummary),
      }
    }

    return {
      ...item,
      workspaceDiffSummary: null,
    }
  })

  const nextBySlug = new Map(
    normalizedNextItems
      .map((item) => {
        const slug = String(item?.slug || '').trim()
        return slug ? [slug, item] : null
      })
      .filter(Boolean)
  )

  const orderedExistingItems = (prevItems || [])
    .map((item) => {
      const slug = String(item?.slug || '').trim()
      return slug ? nextBySlug.get(slug) || null : null
    })
    .filter(Boolean)

  const newItems = normalizedNextItems.filter((item) => {
    const slug = String(item?.slug || '').trim()
    return slug && !previousBySlug.has(slug)
  })

  return [
    ...newItems,
    ...orderedExistingItems,
  ]
}

function persistActiveTaskSlug(slug) {
  if (typeof window === 'undefined') {
    return
  }

  const value = String(slug || '').trim()
  if (value) {
    window.localStorage.setItem(ACTIVE_TASK_STORAGE_KEY, value)
    return
  }

  window.localStorage.removeItem(ACTIVE_TASK_STORAGE_KEY)
}

function getPersistedActiveTaskSlug() {
  if (typeof window === 'undefined') {
    return ''
  }

  return String(window.localStorage.getItem(ACTIVE_TASK_STORAGE_KEY) || '').trim()
}

function getRequestedTaskSlug() {
  if (typeof window === 'undefined') {
    return ''
  }

  try {
    const url = new URL(window.location.href)
    return String(url.searchParams.get('task') || '').trim()
  } catch {
    return ''
  }
}

function clearRequestedTaskSlug() {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('task')) {
      return
    }
    url.searchParams.delete('task')
    const nextUrl = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState({}, '', nextUrl || '/')
  } catch {
    // ignore malformed location values
  }
}

function toTaskSummary(taskRecord) {
  const summary = {
    slug: taskRecord.slug,
    title: String(taskRecord.title || ''),
    autoTitle: String(taskRecord.autoTitle || ''),
    lastPromptPreview: String(taskRecord.lastPromptPreview || ''),
    codexSessionId: String(taskRecord.codexSessionId || ''),
    codexRunCount: Math.max(0, Number(taskRecord.codexRunCount) || 0),
    todoCount: Math.max(0, Number(taskRecord.todoCount) || 0),
    running: Boolean(taskRecord.running),
    preview: String(taskRecord.lastPromptPreview || ''),
    updatedAt: taskRecord.updatedAt || taskRecord.createdAt || new Date().toISOString(),
    createdAt: taskRecord.createdAt || taskRecord.updatedAt || new Date().toISOString(),
    automation: taskRecord?.automation
      ? {
          enabled: Boolean(taskRecord.automation.enabled),
          cron: String(taskRecord.automation.cron || ''),
          nextTriggerAt: String(taskRecord.automation.nextTriggerAt || ''),
        }
      : undefined,
    notification: taskRecord?.notification
      ? {
          enabled: Boolean(taskRecord.notification.enabled),
          channelType: String(taskRecord.notification.channelType || ''),
          triggerOn: String(taskRecord.notification.triggerOn || ''),
          lastStatus: String(taskRecord.notification.lastStatus || ''),
          lastSentAt: String(taskRecord.notification.lastSentAt || ''),
        }
      : undefined,
  }

  if (Object.prototype.hasOwnProperty.call(taskRecord, 'workspaceDiffSummary')) {
    summary.workspaceDiffSummary = normalizeWorkspaceDiffSummary(taskRecord.workspaceDiffSummary)
  }

  return summary
}

export function useWorkbenchTasks(options = {}) {
  const {
    clearToast = () => {},
    flashToast = () => {},
    scrollCurrentPanelToBottom = () => {},
  } = options

  const apiBase = getApiBase()
  const realtime = useWorkbenchRealtime()
  const editorRef = ref(null)
  const tasks = ref([])
  const taskDraftMap = ref({})
  const selectedSessionMap = ref({})
  const sendingTaskMap = ref({})
  const currentTaskSlug = ref('')
  const draft = ref({
    title: '',
    autoTitle: '',
    lastPromptPreview: '',
    codexSessionId: '',
    blocks: [],
    todoItems: [],
  })
  const loadingTasks = ref(true)
  const loadingTask = ref(false)
  const creatingTask = ref(false)
  const removingTask = ref(false)
  const saving = ref(false)
  const uploading = ref(false)
  const error = ref('')
  const hasUnsavedChanges = ref(false)
  const lastSavedSnapshot = ref('')

  let autoSaveTimer = null
  let savePromise = null
  let loadRequestId = 0
  let serverSyncTimer = null
  let workspaceDiffSummaryRequestId = 0
  let pendingServerSyncTaskSlug = null

  const currentTaskAutoTitle = computed(() => deriveAutoTaskTitle(draft.value.blocks))
  const currentTaskDisplayTitle = computed(() => resolveTaskDisplayTitle({
    title: draft.value.title,
    autoTitle: draft.value.autoTitle,
    preview: deriveTaskPreview(draft.value.blocks),
  }, draft.value.blocks))
  const currentSelectedSessionId = computed(() => selectedSessionMap.value[currentTaskSlug.value] || '')
  const currentTaskSendState = computed(() => getCurrentTaskSendState(
    getTaskSummary(currentTaskSlug.value),
    sendingTaskMap.value[currentTaskSlug.value]
  ))
  const isCurrentTaskSending = computed(() => currentTaskSendState.value !== 'idle')
  const hasAnyTaskSending = computed(() => (
    tasks.value.some((task) => isTaskRunning(task))
    || Object.values(sendingTaskMap.value).some(Boolean)
  ))
  const hasCurrentDraftContent = computed(() => hasMeaningfulBlocks(draft.value.blocks))
  const currentTodoItems = computed(() => cloneTodoItems(draft.value.todoItems))
  const pageTitle = computed(() => currentTaskDisplayTitle.value || '未命名任务')
  const renderedTasks = computed(() => tasks.value.map((task) => buildRenderedTask(task)))

  function normalizeImageContent(content = '') {
    if (!content || !content.startsWith(apiBase)) {
      return content
    }

    return content.slice(apiBase.length)
  }

  function normalizeBlocksForSave(blocks = []) {
    return blocks.map((block) => ({
      ...block,
      content: block.type === 'image' ? normalizeImageContent(block.content) : block.content,
    }))
  }

  function createSnapshot(
    title = draft.value.title,
    autoTitle = draft.value.autoTitle,
    lastPromptPreview = draft.value.lastPromptPreview,
    todoItems = draft.value.todoItems,
    codexSessionId = draft.value.codexSessionId,
    blocks = draft.value.blocks
  ) {
    return JSON.stringify({
      title: String(title || ''),
      autoTitle: String(autoTitle || ''),
      lastPromptPreview: String(lastPromptPreview || ''),
      todoItems: cloneTodoItems(todoItems),
      codexSessionId: String(codexSessionId || ''),
      blocks: normalizeBlocksForSave(blocks),
    })
  }

  function hasPendingDraftChanges() {
    return createSnapshot() !== lastSavedSnapshot.value
  }

  function getTaskSummary(slug) {
    return tasks.value.find((task) => task.slug === slug) || null
  }

  function getTaskDraftState(slug) {
    if (!slug) {
      return null
    }

    return taskDraftMap.value[slug] || null
  }

  function buildRenderedTask(task) {
    const cachedDraft = getTaskDraftState(task.slug)
    const blocks = task.slug === currentTaskSlug.value
      ? draft.value.blocks
      : cachedDraft?.blocks || []
    const title = task.slug === currentTaskSlug.value
      ? draft.value.title
      : cachedDraft?.title ?? task.title
    const autoTitle = task.slug === currentTaskSlug.value
      ? draft.value.autoTitle
      : cachedDraft?.autoTitle ?? task.autoTitle
    const todoCount = task.slug === currentTaskSlug.value
      ? cloneTodoItems(draft.value.todoItems).length
      : cloneTodoItems(cachedDraft?.todoItems || []).length || Number(task.todoCount || 0)
    const preview = task.slug === currentTaskSlug.value
      ? draft.value.lastPromptPreview || task.lastPromptPreview || ''
      : cachedDraft?.lastPromptPreview || task.lastPromptPreview || ''
    const codexSessionId = task.slug === currentTaskSlug.value
      ? selectedSessionMap.value[task.slug] || draft.value.codexSessionId || task.codexSessionId || ''
      : cachedDraft?.codexSessionId || task.codexSessionId || ''

    return {
      ...task,
      title,
      autoTitle,
      todoCount,
      preview,
      codexSessionId,
      sessionSelectionLocked: Boolean(codexSessionId && Number(task.codexRunCount || 0) > 0),
      sessionSelectionLockReason: codexSessionId && Number(task.codexRunCount || 0) > 0
        ? '该任务已有项目历史，不能再切换项目；如需使用新项目，请新建任务。'
        : '',
      displayTitle: resolveTaskDisplayTitle({ title, autoTitle, preview }, blocks),
      sending: isTaskRunning(task),
    }
  }

  function upsertTaskSummary(summary, options = {}) {
    const { insertAtStart = false } = options
    if (!summary?.slug) {
      return
    }

    const nextTasks = [...tasks.value]
    const existingIndex = nextTasks.findIndex((task) => task.slug === summary.slug)

    if (existingIndex >= 0) {
      nextTasks.splice(existingIndex, 1, {
        ...nextTasks[existingIndex],
        ...summary,
      })
      tasks.value = nextTasks
      return
    }

    if (insertAtStart) {
      nextTasks.unshift(summary)
    } else {
      nextTasks.push(summary)
    }
    tasks.value = nextTasks
  }

  function setTaskDraftState(slug, state) {
    if (!slug) {
      return
    }

    taskDraftMap.value = {
      ...taskDraftMap.value,
      [slug]: cloneDraftState(state),
    }
  }

  function getTaskRawUrl(slug) {
    return slug ? `${apiBase}/api/tasks/${slug}/raw` : `${apiBase}/api/tasks/`
  }

  function applyTaskRunningStateFromRealtime(taskSlug = '') {
    const normalizedTaskSlug = String(taskSlug || '').trim()
    if (!normalizedTaskSlug) {
      return
    }

    const currentSummary = getTaskSummary(normalizedTaskSlug)
    const change = realtime.getTaskRunChange(normalizedTaskSlug)
    if (!currentSummary || !change?.status) {
      return
    }

    const nextRunning = isActiveRunStatus(change.status)
    if (Boolean(currentSummary.running) === nextRunning) {
      return
    }

    upsertTaskSummary({
      ...currentSummary,
      running: nextRunning,
    })
  }

  function handleTaskSendingChange(slug, value) {
    sendingTaskMap.value = {
      ...sendingTaskMap.value,
      [slug]: Boolean(value),
    }
  }

  function syncSendingTaskMapWithTasks(nextTasks = tasks.value) {
    const nextMap = {}

    ;(nextTasks || []).forEach((task) => {
      if (!task?.slug) {
        return
      }
      nextMap[task.slug] = Boolean(task.running)
    })

    sendingTaskMap.value = nextMap
  }

  function setTaskSelectedSessionId(slug, sessionId) {
    if (!slug) {
      return
    }

    selectedSessionMap.value = {
      ...selectedSessionMap.value,
      [slug]: String(sessionId || '').trim(),
    }
  }

  async function handleTaskSessionChange(slug, sessionId) {
    const targetSlug = String(slug || '').trim()
    if (!targetSlug) {
      return
    }

    const normalizedSessionId = String(sessionId || '').trim()
    const currentSummary = getTaskSummary(targetSlug)
    const previousSessionId = selectedSessionMap.value[targetSlug] || currentSummary?.codexSessionId || ''
    const sessionSelectionLocked = Boolean(previousSessionId && Number(currentSummary?.codexRunCount || 0) > 0)
    if (sessionSelectionLocked && normalizedSessionId !== previousSessionId) {
      error.value = '该任务已有项目历史，不能再切换项目；如需使用新项目，请新建任务。'
      return
    }

    setTaskSelectedSessionId(targetSlug, normalizedSessionId)

    const cachedDraft = getTaskDraftState(targetSlug)
    if (cachedDraft) {
      setTaskDraftState(targetSlug, {
        ...cachedDraft,
        codexSessionId: normalizedSessionId,
      })
    }
    if (currentSummary) {
      upsertTaskSummary({
        ...currentSummary,
        codexSessionId: normalizedSessionId,
        workspaceDiffSummary: normalizedSessionId && normalizedSessionId === previousSessionId
          ? currentSummary.workspaceDiffSummary
          : null,
      })
    }

    if (targetSlug === currentTaskSlug.value) {
      draft.value = {
        ...draft.value,
        codexSessionId: normalizedSessionId,
      }
    }

    try {
      await updateTaskCodexSession(targetSlug, normalizedSessionId)
    } catch (err) {
      setTaskSelectedSessionId(targetSlug, previousSessionId)
      if (cachedDraft) {
        setTaskDraftState(targetSlug, {
          ...cachedDraft,
          codexSessionId: previousSessionId,
        })
      }
      if (currentSummary) {
        upsertTaskSummary({
          ...currentSummary,
          codexSessionId: previousSessionId,
        })
      }
      if (targetSlug === currentTaskSlug.value) {
        draft.value = {
          ...draft.value,
          codexSessionId: previousSessionId,
        }
      }
      error.value = err.message
    }
  }

  function clearAutoSaveTimer() {
    if (autoSaveTimer) {
      window.clearTimeout(autoSaveTimer)
      autoSaveTimer = null
    }
  }

  function clearServerSyncTimer() {
    if (serverSyncTimer) {
      window.clearTimeout(serverSyncTimer)
      serverSyncTimer = null
    }
  }

  function scheduleAutoSave() {
    clearAutoSaveTimer()
    if (loadingTask.value || !currentTaskSlug.value) {
      return
    }

    autoSaveTimer = window.setTimeout(() => {
      saveTask({ auto: true, silent: true })
    }, 1500)
  }

  function syncDraftSummary() {
    if (!currentTaskSlug.value) {
      return
    }

    const currentSummary = getTaskSummary(currentTaskSlug.value) || {
      slug: currentTaskSlug.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    upsertTaskSummary({
      ...currentSummary,
      title: String(draft.value.title || ''),
      autoTitle: String(draft.value.autoTitle || ''),
      lastPromptPreview: String(draft.value.lastPromptPreview || ''),
      todoCount: cloneTodoItems(draft.value.todoItems).length,
      codexSessionId: String(selectedSessionMap.value[currentTaskSlug.value] || draft.value.codexSessionId || ''),
      preview: String(draft.value.lastPromptPreview || ''),
    })
  }

  function applyTaskSettingsUpdate(taskRecord = {}) {
    const slug = String(taskRecord?.slug || '').trim()
    if (!slug) {
      return
    }

    const summary = toTaskSummary(taskRecord)
    upsertTaskSummary(summary)

    if (slug !== currentTaskSlug.value) {
      return
    }

    if (Object.prototype.hasOwnProperty.call(taskRecord, 'title')) {
      draft.value.title = String(taskRecord.title || '')
    }
    if (Object.prototype.hasOwnProperty.call(taskRecord, 'autoTitle')) {
      draft.value.autoTitle = String(taskRecord.autoTitle || '')
    }

    setTaskDraftState(slug, {
      ...draft.value,
    })
  }

  function applyTaskWorkspaceDiffSummaries(items = []) {
    const summaryBySlug = new Map(
      (items || [])
        .map((item) => {
          const slug = String(item?.slug || '').trim()
          if (!slug) {
            return null
          }

          return [slug, normalizeWorkspaceDiffSummary(item.workspaceDiffSummary)]
        })
        .filter(Boolean)
    )

    if (!summaryBySlug.size) {
      return
    }

    tasks.value = tasks.value.map((task) => {
      if (!summaryBySlug.has(task.slug)) {
        return task
      }

      return {
        ...task,
        workspaceDiffSummary: summaryBySlug.get(task.slug),
      }
    })
  }

  async function refreshTaskWorkspaceDiffSummaries(taskItems = tasks.value) {
    const nextTaskItems = Array.isArray(taskItems) ? taskItems : []
    const tasksWithSessions = nextTaskItems.filter((task) => String(task?.codexSessionId || '').trim())
    const requestId = ++workspaceDiffSummaryRequestId

    if (!tasksWithSessions.length) {
      tasks.value = nextTaskItems.map((task) => {
        if (Object.prototype.hasOwnProperty.call(task, 'workspaceDiffSummary')) {
          return task
        }

        return {
          ...task,
          workspaceDiffSummary: null,
        }
      })
      return
    }

    try {
      const payload = await listTaskWorkspaceDiffSummaries(nextTaskItems.length || 30)
      if (requestId !== workspaceDiffSummaryRequestId) {
        return
      }

      applyTaskWorkspaceDiffSummaries(payload.items || [])
    } catch {
      // Ignore summary fetch failures so the main task list stays responsive.
    }
  }

  async function refreshTaskList(options = {}) {
    const { silent = false } = options
    if (!silent) {
      loadingTasks.value = true
      error.value = ''
    }

    try {
      const payload = await listTasks()
      const nextTasks = mergeTaskSummariesWithWorkspaceDiff(
        tasks.value,
        (payload.items || []).map(toTaskSummary)
      )
      tasks.value = nextTasks
      syncSendingTaskMapWithTasks(nextTasks)
      refreshTaskWorkspaceDiffSummaries(nextTasks)
    } catch (err) {
      if (!silent) {
        error.value = err.message
      }
    } finally {
      if (!silent) {
        loadingTasks.value = false
      }
    }
  }

  async function syncTaskStateAfterServerChange(taskSlug = '') {
    const currentSlug = String(currentTaskSlug.value || '').trim()
    if (!currentSlug) {
      return
    }

    const currentStillExists = tasks.value.some((task) => task.slug === currentSlug)
    if (!currentStillExists) {
      if (tasks.value.length) {
        await loadTask(tasks.value[0].slug, { force: true, skipIfDirtyOnApply: true })
        return
      }

      currentTaskSlug.value = ''
      persistActiveTaskSlug('')
      draft.value = { title: '', autoTitle: '', lastPromptPreview: '', codexSessionId: '', blocks: [], todoItems: [] }
      lastSavedSnapshot.value = createSnapshot('', '', '', [], '', [])
      hasUnsavedChanges.value = false
      return
    }

    if (taskSlug && taskSlug !== currentSlug) {
      return
    }

    if (hasPendingDraftChanges() || hasUnsavedChanges.value || saving.value || uploading.value || loadingTask.value) {
      return
    }

    await loadTask(currentSlug, { force: true, skipIfDirtyOnApply: true })
  }

  function scheduleServerRefresh(taskSlug = '') {
    const nextTaskSlug = String(taskSlug || '').trim()
    if (pendingServerSyncTaskSlug === null) {
      pendingServerSyncTaskSlug = nextTaskSlug
    } else if (pendingServerSyncTaskSlug !== nextTaskSlug) {
      pendingServerSyncTaskSlug = ''
    }

    if (serverSyncTimer) {
      return
    }

    serverSyncTimer = window.setTimeout(async () => {
      const taskSlug = pendingServerSyncTaskSlug
      pendingServerSyncTaskSlug = null
      serverSyncTimer = null

      await refreshTaskList({ silent: true })
      await syncTaskStateAfterServerChange(taskSlug || '')
    }, SERVER_SYNC_DELAY)
  }

  async function hydrateTaskFromServer(slug) {
    const task = await getTask(slug)
    const normalizedBlocks = (task.blocks || []).map((block) => ({
      ...block,
      content: block.type === 'image' ? resolveAssetUrl(block.content) : block.content,
    }))

    const state = {
      title: String(task.title || ''),
      autoTitle: String(task.autoTitle || ''),
      lastPromptPreview: String(task.lastPromptPreview || ''),
      codexSessionId: String(task.codexSessionId || ''),
      blocks: normalizedBlocks,
      todoItems: cloneTodoItems(task.todoItems || []),
    }

    return {
      state,
      summary: toTaskSummary({
        ...task,
        blocks: normalizedBlocks,
      }),
    }
  }

  async function loadTask(slug, options = {}) {
    const { focusEditor = false, force = false, skipIfDirtyOnApply = false } = options
    const targetSlug = String(slug || '').trim()
    if (!targetSlug) {
      return false
    }

    const requestId = ++loadRequestId
    loadingTask.value = true
    error.value = ''
    clearToast()

    try {
      let state = force ? null : getTaskDraftState(targetSlug)
      let summary = null
      if (!state) {
        const hydrated = await hydrateTaskFromServer(targetSlug)
        state = hydrated?.state || null
        summary = hydrated?.summary || null
      }

      if (requestId !== loadRequestId) {
        return false
      }

      if (
        skipIfDirtyOnApply
        && targetSlug === currentTaskSlug.value
        && (hasPendingDraftChanges() || hasUnsavedChanges.value)
      ) {
        return false
      }

      currentTaskSlug.value = targetSlug
      persistActiveTaskSlug(targetSlug)
      draft.value = cloneDraftState(state)
      setTaskDraftState(targetSlug, state)
      if (summary) {
        upsertTaskSummary(summary)
      }
      setTaskSelectedSessionId(targetSlug, state.codexSessionId)
      lastSavedSnapshot.value = createSnapshot(
        draft.value.title,
        draft.value.autoTitle,
        draft.value.lastPromptPreview,
        draft.value.todoItems,
        draft.value.codexSessionId,
        draft.value.blocks
      )
      hasUnsavedChanges.value = false

      if (focusEditor) {
        nextTick(() => editorRef.value?.focusEditor?.())
      }
      scrollCurrentPanelToBottom()
      return true
    } catch (err) {
      if (requestId === loadRequestId) {
        error.value = err.message
      }
      return false
    } finally {
      if (requestId === loadRequestId) {
        loadingTask.value = false
      }
    }
  }

  async function saveTask(options = {}) {
    const { auto = false, silent = false } = options
    if (!currentTaskSlug.value) {
      return false
    }

    const snapshot = createSnapshot()
    if (snapshot === lastSavedSnapshot.value) {
      return true
    }

    if (savePromise) {
      return savePromise
    }

    clearAutoSaveTimer()
    saving.value = true
    error.value = ''

    savePromise = (async () => {
      try {
        const task = await updateTask(currentTaskSlug.value, {
          title: String(draft.value.title || ''),
          autoTitle: String(draft.value.autoTitle || ''),
          lastPromptPreview: String(draft.value.lastPromptPreview || ''),
          todoItems: cloneTodoItems(draft.value.todoItems),
          codexSessionId: String(selectedSessionMap.value[currentTaskSlug.value] || draft.value.codexSessionId || ''),
          expiry: 'none',
          visibility: 'private',
          blocks: normalizeBlocksForSave(draft.value.blocks),
        })

        const normalizedState = {
          title: String(task.title || ''),
          autoTitle: String(task.autoTitle || ''),
          lastPromptPreview: String(task.lastPromptPreview || ''),
          todoItems: cloneTodoItems(task.todoItems || draft.value.todoItems || []),
          codexSessionId: String(selectedSessionMap.value[currentTaskSlug.value] || task.codexSessionId || ''),
          blocks: cloneBlocks(draft.value.blocks),
        }
        setTaskDraftState(currentTaskSlug.value, normalizedState)
        lastSavedSnapshot.value = createSnapshot(
          normalizedState.title,
          normalizedState.autoTitle,
          normalizedState.lastPromptPreview,
          normalizedState.todoItems,
          normalizedState.codexSessionId,
          normalizedState.blocks
        )
        hasUnsavedChanges.value = false
        upsertTaskSummary(toTaskSummary(task))
        if (!auto && !silent) {
          flashToast('任务已保存')
        }
        return true
      } catch (err) {
        error.value = err.message
        return false
      } finally {
        saving.value = false
        savePromise = null
        if (createSnapshot() !== lastSavedSnapshot.value) {
          hasUnsavedChanges.value = true
          scheduleAutoSave()
        }
      }
    })()

    return savePromise
  }

  async function ensureCurrentTaskReady() {
    if (uploading.value) {
      error.value = '文件仍在处理中，请稍后再操作任务。'
      return false
    }

    if (savePromise) {
      return savePromise
    }

    if (!hasUnsavedChanges.value) {
      return true
    }

    return saveTask({ auto: false, silent: true })
  }

  async function createTaskAndSelect() {
    if (!(await ensureCurrentTaskReady()) && currentTaskSlug.value) {
      return false
    }

    creatingTask.value = true
    error.value = ''

    try {
      const task = await createTask({
        title: '',
        expiry: 'none',
        visibility: 'private',
      })

      const initialState = {
        title: String(task.title || ''),
        autoTitle: String(task.autoTitle || ''),
        lastPromptPreview: String(task.lastPromptPreview || ''),
        codexSessionId: String(task.codexSessionId || ''),
        blocks: cloneBlocks(task.blocks || []),
        todoItems: cloneTodoItems(task.todoItems || []),
      }
      setTaskDraftState(task.slug, initialState)
      upsertTaskSummary(toTaskSummary(task), { insertAtStart: true })
      await loadTask(task.slug, { focusEditor: true })
      flashToast('已创建新任务')
      return true
    } catch (err) {
      error.value = err.message
      return false
    } finally {
      creatingTask.value = false
    }
  }

  async function selectTask(slug) {
    const targetSlug = String(slug || '').trim()
    if (!targetSlug || targetSlug === currentTaskSlug.value) {
      return
    }

    const ready = await ensureCurrentTaskReady()
    if (!ready) {
      return
    }

    await loadTask(targetSlug)
  }

  async function removeCurrentTask() {
    if (!currentTaskSlug.value) {
      return
    }

    removingTask.value = true
    error.value = ''

    try {
      const targetSlug = currentTaskSlug.value
      await deleteTask(targetSlug)
      tasks.value = tasks.value.filter((task) => task.slug !== targetSlug)

      const nextDraftMap = { ...taskDraftMap.value }
      delete nextDraftMap[targetSlug]
      taskDraftMap.value = nextDraftMap

      const nextSessionMap = { ...selectedSessionMap.value }
      delete nextSessionMap[targetSlug]
      selectedSessionMap.value = nextSessionMap

      const nextSendingMap = { ...sendingTaskMap.value }
      delete nextSendingMap[targetSlug]
      sendingTaskMap.value = nextSendingMap

      if (tasks.value.length) {
        await loadTask(tasks.value[0].slug, { focusEditor: true })
      } else {
        currentTaskSlug.value = ''
        persistActiveTaskSlug('')
        draft.value = { title: '', autoTitle: '', lastPromptPreview: '', codexSessionId: '', blocks: [], todoItems: [] }
        lastSavedSnapshot.value = createSnapshot('', '', '', [], '', [])
        hasUnsavedChanges.value = false
        await createTaskAndSelect()
      }
    } catch (err) {
      error.value = err.message
    } finally {
      removingTask.value = false
    }
  }

  function clearCurrentTaskContent(options = {}) {
    const { silent = false } = options
    if (!currentTaskSlug.value) {
      return
    }

    draft.value = {
      ...draft.value,
      blocks: [{ type: 'text', content: '', meta: {} }],
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    nextTick(() => {
      editorRef.value?.focusEditor?.()
    })
    if (!silent) {
      flashToast('已清空当前任务内容，稍后会自动保存')
    }
  }

  function addCurrentDraftToTodo() {
    if (!currentTaskSlug.value) {
      return false
    }

    const todoBlocks = normalizeTodoItemBlocks(draft.value.blocks)
    if (!todoBlocks.length) {
      return false
    }

    draft.value = {
      ...draft.value,
      blocks: [{ type: 'text', content: '', meta: {} }],
      todoItems: [
        {
          id: createTodoItemId(),
          createdAt: new Date().toISOString(),
          blocks: todoBlocks,
        },
        ...cloneTodoItems(draft.value.todoItems),
      ],
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    nextTick(() => {
      editorRef.value?.focusEditor?.()
    })
    flashToast('已加入代办')
    return true
  }

  function removeTodoItem(todoId = '') {
    const normalizedTodoId = String(todoId || '').trim()
    if (!currentTaskSlug.value || !normalizedTodoId) {
      return false
    }

    const nextTodoItems = cloneTodoItems(draft.value.todoItems).filter((item) => item.id !== normalizedTodoId)
    if (nextTodoItems.length === cloneTodoItems(draft.value.todoItems).length) {
      return false
    }

    draft.value = {
      ...draft.value,
      todoItems: nextTodoItems,
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    return true
  }

  function useTodoItem(todoId = '') {
    const normalizedTodoId = String(todoId || '').trim()
    if (!currentTaskSlug.value || !normalizedTodoId) {
      return null
    }

    const targetTodo = cloneTodoItems(draft.value.todoItems).find((item) => item.id === normalizedTodoId)
    if (!targetTodo) {
      return null
    }

    draft.value = {
      ...draft.value,
      blocks: cloneBlocks(targetTodo.blocks),
      todoItems: cloneTodoItems(draft.value.todoItems).filter((item) => item.id !== normalizedTodoId),
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    nextTick(() => {
      editorRef.value?.focusEditor?.()
    })
    return targetTodo
  }

  async function initializeWorkbench() {
    await refreshTaskList()
    if (!tasks.value.length) {
      await createTaskAndSelect()
      return
    }

    const requestedSlug = getRequestedTaskSlug()
    if (requestedSlug) {
      const loaded = await loadTask(requestedSlug, { focusEditor: true, force: true })
      clearRequestedTaskSlug()
      if (loaded) {
        return
      }
    }

    const latestRunningTaskSlug = tasks.value.find((task) => Boolean(task?.running))?.slug || ''
    const persistedSlug = getPersistedActiveTaskSlug()
    const initialSlug = latestRunningTaskSlug
      || (tasks.value.some((task) => task.slug === persistedSlug)
        ? persistedSlug
        : tasks.value[0].slug)

    await loadTask(initialSlug, { focusEditor: true, force: true })
  }

  async function handleUpload(files) {
    uploading.value = true
    error.value = ''

    try {
      const insertedAfterImported = editorRef.value?.isImportedBlockActive?.() || false
      const uploadedBlocks = []

      for (const file of files) {
        const asset = await uploadImage(file)
        uploadedBlocks.push({
          type: 'image',
          content: resolveAssetUrl(asset.url),
          meta: {},
        })
      }

      editorRef.value?.insertUploadedBlocks(uploadedBlocks)
      flashToast(insertedAfterImported
        ? `已把 ${uploadedBlocks.length} 张图片插入到当前导入块后方，稍后会自动保存`
        : `已插入 ${uploadedBlocks.length} 张图片，稍后会自动保存`)
    } catch (err) {
      error.value = err.message
    } finally {
      uploading.value = false
    }
  }

  async function handleImportTextFiles(files) {
    error.value = ''

    try {
      const insertedAfterImported = editorRef.value?.isImportedBlockActive?.() || false
      const importedBlocks = []

      for (const file of files) {
        const text = await file.text()
        if (!text.trim()) {
          continue
        }
        importedBlocks.push({
          type: 'imported_text',
          content: text,
          meta: {
            fileName: file.name || '未命名文件',
            collapsed: true,
          },
        })
      }

      if (!importedBlocks.length) {
        flashToast('没有读取到可插入的文本内容')
        return
      }

      editorRef.value?.insertImportedBlocks(importedBlocks)
      flashToast(insertedAfterImported
        ? `已把 ${importedBlocks.length} 个文件块插入到当前导入块后方，稍后会自动保存`
        : `已插入 ${importedBlocks.length} 个文件块，稍后会自动保存`)
    } catch {
      error.value = '文件读取失败，请确认使用 UTF-8 编码的 .md 或 .txt 文件。'
    }
  }

  async function handleImportPdfFiles(files) {
    uploading.value = true
    error.value = ''

    try {
      let insertedBlockCount = 0
      let insertedPageCount = 0

      for (const file of files) {
        const payload = await importPdf(file)
        const blocks = (payload.blocks || []).map((block) => ({
          ...block,
          content: block.type === 'image' ? resolveAssetUrl(block.content) : block.content,
        }))

        if (!blocks.length) {
          continue
        }

        editorRef.value?.insertBlocks(blocks)
        insertedBlockCount += blocks.length
        insertedPageCount += Number(payload.pageCount || 0)
      }

      if (!insertedBlockCount) {
        flashToast('没有从 PDF 中解析出可插入内容')
        return
      }

      flashToast(`已插入 ${insertedBlockCount} 个图文块${insertedPageCount ? `，共 ${insertedPageCount} 页` : ''}，稍后会自动保存`)
    } catch (err) {
      error.value = err.message || 'PDF 解析失败，请确认文件不是扫描件，并且内容为单栏图文。'
    } finally {
      uploading.value = false
    }
  }

  function buildPromptForTask(slug) {
    const state = slug === currentTaskSlug.value
      ? draft.value
      : getTaskDraftState(slug)

    if (!state) {
      return ''
    }

    return buildCodexPrompt({
      title: String(state.title || ''),
      blocks: normalizeBlocksForSave(state.blocks || []),
    }, getTaskRawUrl(slug))
  }

  function getPromptBlocksForTask(slug) {
    const state = slug === currentTaskSlug.value
      ? draft.value
      : getTaskDraftState(slug)

    if (!state) {
      return []
    }

    return cloneBlocks(normalizeBlocksForSave(state.blocks || []))
  }

  async function ensureCodexPromptReady(taskSlug) {
    if (uploading.value) {
      error.value = '文件仍在处理中，请稍后再发送给当前执行引擎。'
      return false
    }

    if (taskSlug !== currentTaskSlug.value) {
      return true
    }

    if (saving.value && savePromise) {
      return savePromise
    }

    if (!hasUnsavedChanges.value) {
      return true
    }

    return saveTask({ auto: false, silent: true })
  }

  async function prepareCodexPromptForTask(taskSlug) {
    const ready = await ensureCodexPromptReady(taskSlug)
    if (!ready) {
      return ''
    }

    return buildPromptForTask(taskSlug)
  }

  function updateLastPromptPreview(taskSlug, prompt) {
    const promptPreview = buildPromptPreview(prompt)
    if (!promptPreview || taskSlug !== currentTaskSlug.value) {
      return
    }

    draft.value.lastPromptPreview = promptPreview
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
  }

  watch(
    draft,
    () => {
      if (loadingTask.value || !currentTaskSlug.value) {
        return
      }

      const derivedAutoTitle = deriveAutoTaskTitle(draft.value.blocks)
      if (!String(draft.value.title || '').trim() && derivedAutoTitle && derivedAutoTitle !== draft.value.autoTitle) {
        draft.value.autoTitle = derivedAutoTitle
      }

      setTaskDraftState(currentTaskSlug.value, draft.value)
      hasUnsavedChanges.value = createSnapshot() !== lastSavedSnapshot.value
      syncDraftSummary()
      if (hasUnsavedChanges.value && !saving.value) {
        scheduleAutoSave()
      }
    },
    { deep: true }
  )

  watch(currentTaskSlug, (slug) => {
    if (slug) {
      persistActiveTaskSlug(slug)
    }
  })

  onBeforeUnmount(() => {
    clearAutoSaveTimer()
    clearServerSyncTimer()
  })

  watch(
    () => realtime.listSyncVersion.value,
    () => {
      applyTaskRunningStateFromRealtime(realtime.listSyncTaskSlug.value)
      scheduleServerRefresh(realtime.listSyncTaskSlug.value)
    }
  )

  return {
    addCurrentDraftToTodo,
    applyTaskSettingsUpdate,
    buildPromptForTask,
    getPromptBlocksForTask,
    buildPromptPreview,
    clearCurrentTaskContent,
    createTaskAndSelect,
    currentSelectedSessionId,
    currentTaskSendState,
    currentTaskAutoTitle,
    currentTaskDisplayTitle,
    currentTaskSlug,
    draft,
    editorRef,
    error,
    handleImportPdfFiles,
    handleImportTextFiles,
    handleTaskSendingChange,
    handleTaskSessionChange,
    handleUpload,
    hasCurrentDraftContent,
    hasAnyTaskSending,
    hasUnsavedChanges,
    initializeWorkbench,
    isCurrentTaskSending,
    loadingTask,
    loadingTasks,
    pageTitle,
    prepareCodexPromptForTask,
    currentTodoItems,
    removeTodoItem,
    removeCurrentTask,
    removingTask,
    renderedTasks,
    refreshTaskList,
    saveTask,
    saving,
    selectTask,
    selectedSessionMap,
    sendingTaskMap,
    taskDraftMap,
    tasks,
    useTodoItem,
    updateLastPromptPreview,
    uploading,
    creatingTask,
  }
}
