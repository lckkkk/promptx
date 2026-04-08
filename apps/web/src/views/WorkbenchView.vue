<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import CodexSessionManagerDialog from '../components/CodexSessionManagerDialog.vue'
import CreateTaskProjectDialog from '../components/CreateTaskProjectDialog.vue'
import EditTaskDialog from '../components/EditTaskDialog.vue'
import WorkbenchActivityPanel from '../components/WorkbenchActivityPanel.vue'
import WorkbenchInputPanel from '../components/WorkbenchInputPanel.vue'
import WorkbenchMobileDetailHeader from '../components/WorkbenchMobileDetailHeader.vue'
import WorkbenchTaskListPanel from '../components/WorkbenchTaskListPanel.vue'
import WorkbenchTodoDialog from '../components/WorkbenchTodoDialog.vue'
import TopToast from '../components/TopToast.vue'
import { useI18n } from '../composables/useI18n.js'
import { useWorkbenchMobileLayout } from '../composables/useWorkbenchMobileLayout.js'
import { usePageTitle } from '../composables/usePageTitle.js'
import { useWorkbenchRealtime } from '../composables/useWorkbenchRealtime.js'
import { useToast } from '../composables/useToast.js'
import { useWorkbenchTasks } from '../composables/useWorkbenchTasks.js'
import {
  createCodexSession,
  deleteCodexSession,
  listCodexSessions,
  listCodexWorkspaces,
  resetCodexSession,
  updateCodexSession,
} from '../lib/codexApi.js'
import { getAuthInfo, getLocalUpdateStatus } from '../lib/systemConfigApi.js'

const showClearDialog = ref(false)
const showDeleteDialog = ref(false)
const showDiffDialog = ref(false)
const preferredInspectorView = ref('diff')
const showSettingsDialog = ref(false)
const showEditTaskDialog = ref(false)
const showProjectManagerDialog = ref(false)
const showCreateTaskProjectDialog = ref(false)
const showTodoDialog = ref(false)
const showTodoDeleteConfirm = ref(false)
const showTodoUseConfirm = ref(false)
const pendingTaskDeleteSlug = ref('')
const pendingTodoDeleteId = ref('')
const pendingTodoUseIds = ref([])
const pendingCreateTaskProjectId = ref('')
const editingTaskTitleSlug = ref('')
const diffFocusToken = ref(0)
const preferredDiffScope = ref('workspace')
const preferredDiffRunId = ref('')
const { t } = useI18n()
const { toastMessage, toastType, flashToast, clearToast } = useToast()
const { readyVersion } = useWorkbenchRealtime()
const TaskDiffReviewDialog = defineAsyncComponent(() => import('../components/TaskDiffReviewDialog.vue'))
const WorkbenchSettingsDialog = defineAsyncComponent(() => import('../components/WorkbenchSettingsDialog.vue'))
const LOCAL_UPDATE_TOAST_STORAGE_KEY = 'promptx:last-seen-local-update'

const codexPanelRef = ref(null)
const checkingLocalUpdateToast = ref(false)

function getCurrentPanelRef(currentTaskSlug) {
  if (!currentTaskSlug) {
    return null
  }

  return codexPanelRef.value
}

function scrollCurrentPanelToBottom() {
  nextTick(() => {
    getCurrentPanelRef(currentTaskSlug.value)?.scrollToBottom?.()
  })
}

async function maybeNotifyLocalUpdate(options = {}) {
  if (checkingLocalUpdateToast.value || typeof window === 'undefined') {
    return
  }

  checkingLocalUpdateToast.value = true
  try {
    const payload = await getLocalUpdateStatus()
    const status = payload?.status && typeof payload.status === 'object' ? payload.status : null
    if (!status || String(status.state || '').trim() !== 'restarted') {
      return
    }

    const updatedAt = String(status.updatedAt || '').trim()
    const updatedAtMs = Date.parse(updatedAt)
    if (!updatedAt || !Number.isFinite(updatedAtMs) || Date.now() - updatedAtMs > 10 * 60 * 1000) {
      return
    }

    const lastSeen = window.localStorage.getItem(LOCAL_UPDATE_TOAST_STORAGE_KEY) || ''
    if (lastSeen === updatedAt) {
      return
    }

    window.localStorage.setItem(LOCAL_UPDATE_TOAST_STORAGE_KEY, updatedAt)
    flashToast({
      message: options.afterReconnect
        ? 'PromptX 已重启完成，页面连接已恢复。'
        : 'PromptX 已重启完成。',
      type: 'success',
      duration: 3200,
    })
  } catch {
    // Ignore local update status lookup failures.
  } finally {
    checkingLocalUpdateToast.value = false
  }
}

const {
  addCurrentDraftToTodo,
  applyTaskSettingsUpdate,
  buildPromptForTask,
  getPromptBlocksForTask,
  clearCurrentTaskContent,
  createTaskAndSelect,
  creatingTask,
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
  hasUnsavedChanges,
  initializeWorkbench,
  isCurrentTaskSending,
  loadingTask,
  loadingTasks,
  pageTitle,
  prepareCodexPromptForTask,
  currentTodoItems,
  removeTaskBySlug,
  removeTodoItem,
  removeCurrentTask,
  reorderTaskList,
  removingTask,
  renderedTasks,
  saveTask,
  saving,
  selectTask,
  updateLastPromptPreview,
  useTodoItems,
  uploading,
} = useWorkbenchTasks({
  clearToast,
  flashToast,
  scrollCurrentPanelToBottom,
})

const currentRenderedTask = computed(() =>
  renderedTasks.value.find((task) => task.slug === currentTaskSlug.value) || null
)
const currentSelectedSession = computed(() =>
  codexSessionsForPanel.value.find((session) => String(session?.id || '') === String(currentSelectedSessionId.value || '')) || null
)
const pendingDeleteTask = computed(() =>
  renderedTasks.value.find((task) => task.slug === pendingTaskDeleteSlug.value) || null
)
const currentTaskDiffSupported = computed(() => Boolean(currentRenderedTask.value?.workspaceDiffSummary?.supported))
const currentTaskBuildPrompt = computed(() => {
  const task = currentRenderedTask.value
  if (!task) {
    return null
  }

  return () => prepareCodexPromptForTask(task.slug)
})
const currentTaskBuildPromptBlocks = computed(() => {
  const task = currentRenderedTask.value
  if (!task) {
    return null
  }

  return () => getPromptBlocksForTask(task.slug)
})
const codexSessionsForPanel = ref([])
const codexWorkspacesForManager = ref([])
const loadingCodexSessionsForPanel = ref(false)
const loadingProjectManagerResources = ref(false)
const projectManagerBusy = ref(false)
const authInfo = ref({ multiUser: false, username: null })
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
  tasks: renderedTasks.value,
  uploading: uploading.value,
}))
const activityPanelProps = computed(() => ({
  buildPromptBlocks: currentTaskBuildPromptBlocks.value,
  buildPrompt: currentTaskBuildPrompt.value,
  diffSupported: currentTaskDiffSupported.value,
  selectedSessionId: currentRenderedTask.value?.codexSessionId || '',
  sessionSelectionLockReason: currentRenderedTask.value?.sessionSelectionLockReason || '',
  sessionSelectionLocked: Boolean(currentRenderedTask.value?.sessionSelectionLocked),
  taskSlug: currentRenderedTask.value?.slug || '',
  taskRunning: Boolean(currentRenderedTask.value?.running),
}))
const inputPanelProps = computed(() => ({
  agentEngine: currentSelectedSession.value?.engine || 'codex',
  canAddTodo: hasCurrentDraftContent.value,
  codexSessionId: currentSelectedSessionId.value,
  isCurrentTaskSending: isCurrentTaskSending.value,
  sendState: currentTaskSendState.value,
  loading: loadingTask.value,
  todoCount: currentTodoItems.value.length,
  uploading: uploading.value,
}))
const mobileDetailHeaderProps = computed(() => ({
  currentTaskAutoTitle: draft.value.autoTitle || currentTaskAutoTitle.value,
  currentTaskSlug: currentTaskSlug.value,
  editingTaskTitleSlug: editingTaskTitleSlug.value,
  title: currentTaskDisplayTitle.value,
  titleInputValue: draft.value.title,
}))
const {
  enterMobileDetail,
  isMobileLayout,
  leaveMobileDetail,
  mobileDetailTab,
  mobileView,
} = useWorkbenchMobileLayout({
  currentTaskSlug,
})

function resolvePreferredMobileDetailTab(task) {
  if (task?.sending || Number(task?.codexRunCount || 0) > 0) {
    return 'activity'
  }

  return 'input'
}

usePageTitle(pageTitle)

function openTaskDiff(scope = 'workspace', runId = '') {
  preferredInspectorView.value = 'diff'
  preferredDiffScope.value = scope === 'run' ? 'run' : scope === 'task' ? 'task' : 'workspace'
  preferredDiffRunId.value = preferredDiffScope.value === 'run' ? String(runId || '') : ''
  showDiffDialog.value = true
  diffFocusToken.value += 1
}

function openTaskFiles() {
  preferredInspectorView.value = 'files'
  showDiffDialog.value = true
  diffFocusToken.value += 1
}

function closeTaskDiff() {
  showDiffDialog.value = false
}

function openSettingsDialog() {
  showSettingsDialog.value = true
}

function closeSettingsDialog() {
  showSettingsDialog.value = false
}

function openProjectManagerDialog() {
  showProjectManagerDialog.value = true
  refreshProjectManagerResources()
}

function closeProjectManagerDialog() {
  if (projectManagerBusy.value) {
    return
  }

  showProjectManagerDialog.value = false
}

function openEditTaskDialog() {
  if (!currentTaskSlug.value) {
    return
  }

  showEditTaskDialog.value = true
}

function closeEditTaskDialog() {
  showEditTaskDialog.value = false
}

function openTodoDialog() {
  showTodoDialog.value = true
}

function closeTodoDialog() {
  showTodoDialog.value = false
  closeTodoDeleteConfirm()
  closeTodoUseConfirm()
}

function closeTodoDeleteConfirm() {
  showTodoDeleteConfirm.value = false
  pendingTodoDeleteId.value = ''
}

function closeTodoUseConfirm() {
  showTodoUseConfirm.value = false
  pendingTodoUseIds.value = []
}

function handleTaskSettingsSaved(task) {
  applyTaskSettingsUpdate(task)
}

function updateDraftTitle(value) {
  draft.value.title = value
}

async function handleTaskTitleBlur() {
  editingTaskTitleSlug.value = ''
  if (hasUnsavedChanges.value) {
    await saveTask({ auto: false, silent: true })
  }
}

function beginTaskTitleEdit(taskSlug) {
  if (taskSlug !== currentTaskSlug.value) {
    return
  }

  editingTaskTitleSlug.value = taskSlug
  nextTick(() => {
    const element = document.querySelector('[data-task-title-input="current"]')
    element?.focus?.()
    element?.select?.()
  })
}

async function handleTaskTitleClick(taskSlug) {
  if (isMobileLayout.value) {
    await handleTaskSelect(taskSlug)
    return
  }

  if (taskSlug !== currentTaskSlug.value) {
    await handleTaskSelect(taskSlug)
    return
  }

  beginTaskTitleEdit(taskSlug)
}

function openDeleteDialog(taskSlug = currentTaskSlug.value) {
  pendingTaskDeleteSlug.value = String(taskSlug || currentTaskSlug.value || '').trim()
  if (!pendingTaskDeleteSlug.value) {
    return
  }
  showDeleteDialog.value = true
}

function closeDeleteDialog() {
  if (removingTask.value) {
    return
  }

  showDeleteDialog.value = false
  pendingTaskDeleteSlug.value = ''
}

async function confirmRemoveCurrentTask() {
  const targetSlug = String(pendingTaskDeleteSlug.value || currentTaskSlug.value || '').trim()
  if (!targetSlug) {
    return
  }
  const deletingCurrentTask = targetSlug === currentTaskSlug.value

  if (deletingCurrentTask) {
    await removeCurrentTask()
  } else {
    await removeTaskBySlug(targetSlug)
  }
  showDeleteDialog.value = false
  pendingTaskDeleteSlug.value = ''
  if (isMobileLayout.value && deletingCurrentTask) {
    leaveMobileDetail({ useHistory: false })
  }
}

function openClearDialog() {
  showClearDialog.value = true
}

function closeClearDialog() {
  showClearDialog.value = false
}

function clearAllContent() {
  showClearDialog.value = false
  clearCurrentTaskContent()
}

function handleCurrentTaskSendingChange(nextSending) {
  const task = currentRenderedTask.value
  if (!task) {
    return
  }

  handleTaskSendingChange(task.slug, nextSending)
}

function handleCurrentTaskSessionChange(nextSessionId) {
  const task = currentRenderedTask.value
  if (!task) {
    return
  }

  handleTaskSessionChange(task.slug, nextSessionId)
}

function handleActivityToast(message) {
  flashToast(message)

  if (!isMobileLayout.value || !currentTaskSlug.value) {
    return
  }

  mobileDetailTab.value = 'activity'
}

async function flushCurrentEditorInput() {
  if (typeof document !== 'undefined' && editorRef.value?.isComposing?.()) {
    document.activeElement?.blur?.()
  }

  editorRef.value?.flushPendingInput?.()
  await nextTick()
  editorRef.value?.flushPendingInput?.()
  await nextTick()
}

async function copyCodexPrompt() {
  await flushCurrentEditorInput()
  await navigator.clipboard.writeText(buildPromptForTask(currentTaskSlug.value))
  flashToast({ message: t('workbench.promptCopied'), type: 'info' })
}

async function handleCreateTask() {
  pendingCreateTaskProjectId.value = ''
  showCreateTaskProjectDialog.value = true
  refreshCodexSessionsForPanel()
}

function closeCreateTaskProjectDialog() {
  if (creatingTask.value) {
    return
  }

  showCreateTaskProjectDialog.value = false
  pendingCreateTaskProjectId.value = ''
}

async function confirmCreateTaskWithProject() {
  const selectedProjectId = String(pendingCreateTaskProjectId.value || '').trim()
  if (!selectedProjectId) {
    flashToast({ message: t('workbench.selectProjectFirst'), type: 'warning' })
    return
  }

  const created = await createTaskAndSelect({ codexSessionId: selectedProjectId })
  if (created) {
    showCreateTaskProjectDialog.value = false
    pendingCreateTaskProjectId.value = ''
  }
  if (created && isMobileLayout.value) {
    mobileDetailTab.value = 'input'
    enterMobileDetail()
  }
}

async function refreshCodexSessionsForPanel() {
  loadingCodexSessionsForPanel.value = true
  try {
    const payload = await listCodexSessions()
    if (Array.isArray(payload?.items)) {
      codexSessionsForPanel.value = payload.items
    }
  } catch {
    // ignore background refresh failures
  } finally {
    loadingCodexSessionsForPanel.value = false
  }
}

async function refreshProjectManagerResources() {
  loadingProjectManagerResources.value = true
  try {
    const [sessionPayload, workspacePayload] = await Promise.all([
      listCodexSessions(),
      listCodexWorkspaces(),
    ])

    if (Array.isArray(sessionPayload?.items)) {
      codexSessionsForPanel.value = sessionPayload.items
    }
    if (Array.isArray(workspacePayload?.items)) {
      codexWorkspacesForManager.value = workspacePayload.items
    }
  } catch {
    // ignore manager background refresh failures
  } finally {
    loadingProjectManagerResources.value = false
  }
}

async function handleProjectManagerCreateSession(payload) {
  projectManagerBusy.value = true
  try {
    const session = await createCodexSession(payload)
    await refreshProjectManagerResources()
    return session
  } finally {
    projectManagerBusy.value = false
  }
}

async function handleProjectManagerUpdateSession(sessionId, payload) {
  projectManagerBusy.value = true
  try {
    const session = await updateCodexSession(sessionId, payload)
    await refreshProjectManagerResources()
    return session
  } finally {
    projectManagerBusy.value = false
  }
}

async function handleProjectManagerDeleteSession(sessionId) {
  projectManagerBusy.value = true
  try {
    await deleteCodexSession(sessionId)
    await refreshProjectManagerResources()
    if (currentSelectedSessionId.value === String(sessionId || '').trim()) {
      handleCurrentTaskSessionChange('')
    }
    return {
      deletedSessionId: String(sessionId || '').trim(),
      selectedSessionId: '',
    }
  } finally {
    projectManagerBusy.value = false
  }
}

async function handleProjectManagerResetSession(sessionId) {
  projectManagerBusy.value = true
  try {
    const result = await resetCodexSession(sessionId)
    await refreshProjectManagerResources()
    flashToast({ message: t('projectManager.sessionReset'), type: 'success' })
    return result
  } finally {
    projectManagerBusy.value = false
  }
}

function handleProjectManagerSelectSession(sessionId) {
  if (!currentTaskSlug.value) {
    return
  }

  handleCurrentTaskSessionChange(sessionId)
}

async function handleTaskSelect(taskSlug) {
  const targetSlug = String(taskSlug || '').trim()
  if (!targetSlug) {
    return
  }

  if (targetSlug !== currentTaskSlug.value) {
    await selectTask(targetSlug)
  }

  if (isMobileLayout.value && currentTaskSlug.value === targetSlug) {
    mobileDetailTab.value = resolvePreferredMobileDetailTab(currentRenderedTask.value)
    enterMobileDetail()
  }
}

async function handleTaskReorder(slugs = []) {
  await reorderTaskList(slugs)
}

async function handleAddTodo() {
  await flushCurrentEditorInput()
  addCurrentDraftToTodo()
}

function handleDeleteTodo(todoId) {
  pendingTodoDeleteId.value = String(todoId || '').trim()
  showTodoDeleteConfirm.value = Boolean(pendingTodoDeleteId.value)
}

function confirmDeleteTodo() {
  if (!pendingTodoDeleteId.value) {
    return
  }

  removeTodoItem(pendingTodoDeleteId.value)
  closeTodoDeleteConfirm()
}

async function applyTodoToEditor(todoIds = pendingTodoUseIds.value, options = {}) {
  const normalizedTodoIds = (Array.isArray(todoIds) ? todoIds : [todoIds])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  if (!normalizedTodoIds.length) {
    return false
  }

  const appliedTodos = useTodoItems(normalizedTodoIds, {
    append: Boolean(options?.append),
  })
  if (!appliedTodos.length) {
    return false
  }

  closeTodoUseConfirm()
  closeTodoDialog()
  return true
}

async function handleUseTodo(todoIds) {
  await flushCurrentEditorInput()
  const normalizedTodoIds = (Array.isArray(todoIds) ? todoIds : [todoIds])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  if (!normalizedTodoIds.length) {
    return
  }

  if (!hasCurrentDraftContent.value) {
    await applyTodoToEditor(normalizedTodoIds, { append: false })
    return
  }

  pendingTodoUseIds.value = normalizedTodoIds
  showTodoUseConfirm.value = true
}

async function sendToCodex() {
  const taskSlug = currentTaskSlug.value
  if (!taskSlug) {
    return
  }

  const shouldPreserveDraftAfterSend = Boolean(currentRenderedTask.value?.automation?.enabled)
  await flushCurrentEditorInput()
  updateLastPromptPreview(taskSlug, buildPromptForTask(taskSlug))
  const didSend = await getCurrentPanelRef(taskSlug)?.send?.()
  if (!didSend || taskSlug !== currentTaskSlug.value) {
    return
  }

  if (isMobileLayout.value) {
    mobileDetailTab.value = 'activity'
  }

  if (!shouldPreserveDraftAfterSend) {
    clearCurrentTaskContent({ silent: true })
  }
  await saveTask({ auto: false, silent: true })
}

function focusMobileEditorIfNeeded() {
  if (!isMobileLayout.value || mobileView.value !== 'detail' || mobileDetailTab.value !== 'input' || !currentTaskSlug.value) {
    return
  }

  nextTick(() => {
    editorRef.value?.focusEditor?.()
  })
}

function handleBeforeUnload(event) {
  if (!hasUnsavedChanges.value && !uploading.value && !saving.value) {
    return
  }

  event.preventDefault()
  event.returnValue = ''
}

function handleWindowKeydown(event) {
  if (!event.metaKey && !event.ctrlKey && event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    sendToCodex()
    return
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return
  }

  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveTask({ auto: false })
    return
  }

  if (event.shiftKey && event.key === 'Backspace') {
    event.preventDefault()
    openClearDialog()
  }
}

onMounted(() => {
  initializeWorkbench()
  refreshCodexSessionsForPanel()
  maybeNotifyLocalUpdate()
  getAuthInfo().then((info) => {
    authInfo.value = info
  }).catch(() => {})
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('keydown', handleWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('keydown', handleWindowKeydown)
})

watch(readyVersion, (value, previousValue) => {
  if (Number(value || 0) <= 0) {
    return
  }

  maybeNotifyLocalUpdate({
    afterReconnect: Number(previousValue || 0) > 0,
  })
})

watch(
  [isMobileLayout, mobileView, mobileDetailTab, currentTaskSlug],
  ([mobile, view, tab, taskSlug]) => {
    if (!mobile || view !== 'detail' || tab !== 'input' || !taskSlug) {
      return
    }
    focusMobileEditorIfNeeded()
  }
)

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
}

const activityPanelListeners = {
  'open-diff': ({ scope, runId }) => openTaskDiff(scope, runId),
  'open-files': () => openTaskFiles(),
  'project-created': () => flashToast({ message: t('workbench.projectCreated'), type: 'success' }),
  'selected-session-change': handleCurrentTaskSessionChange,
  'sending-change': handleCurrentTaskSendingChange,
  toast: handleActivityToast,
}

const inputPanelListeners = {
  'add-todo': handleAddTodo,
  'clear-request': openClearDialog,
  'copy-request': copyCodexPrompt,
  'file-feedback': (message) => flashToast({ message, type: 'warning' }),
  'import-pdf-files': handleImportPdfFiles,
  'import-text-files': handleImportTextFiles,
  'manage-todo': openTodoDialog,
  'send-request': sendToCodex,
  'upload-files': handleUpload,
}

const mobileDetailHeaderListeners = {
  'begin-edit': () => beginTaskTitleEdit(currentTaskSlug.value),
  'back': leaveMobileDetail,
  'cancel-title-edit': () => {
    editingTaskTitleSlug.value = ''
  },
  'title-blur': handleTaskTitleBlur,
  'update:titleInputValue': updateDraftTitle,
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <TopToast :message="toastMessage" :type="toastType" />

    <CreateTaskProjectDialog
      :open="showCreateTaskProjectDialog"
      :loading="creatingTask"
      :sessions="codexSessionsForPanel"
      :sessions-loading="loadingCodexSessionsForPanel"
      :selected-project-id="pendingCreateTaskProjectId"
      @cancel="closeCreateTaskProjectDialog"
      @confirm="confirmCreateTaskWithProject"
      @refresh-projects="refreshCodexSessionsForPanel"
      @update:selected-project-id="pendingCreateTaskProjectId = $event"
    />
    <CodexSessionManagerDialog
      :open="showProjectManagerDialog"
      :sessions="codexSessionsForPanel"
      :workspaces="codexWorkspacesForManager"
      :selected-session-id="currentSelectedSessionId"
      :selection-locked="Boolean(currentRenderedTask?.sessionSelectionLocked)"
      :selection-lock-reason="currentRenderedTask?.sessionSelectionLockReason || ''"
      :loading="loadingProjectManagerResources"
      :sending="Boolean(currentRenderedTask?.running)"
      :on-refresh="refreshProjectManagerResources"
      :on-create="handleProjectManagerCreateSession"
      :on-update="handleProjectManagerUpdateSession"
      :on-delete="handleProjectManagerDeleteSession"
      :on-reset="handleProjectManagerResetSession"
      @close="closeProjectManagerDialog"
      @project-created="flashToast({ message: t('workbench.projectCreated'), type: 'success' })"
      @select-session="handleProjectManagerSelectSession"
    />
    <ConfirmDialog
      :open="showClearDialog"
      :title="t('workbench.confirmClearTitle')"
      :description="t('workbench.confirmClearDescription')"
      :confirm-text="t('workbench.confirmClearAction')"
      :cancel-text="t('workbench.continueEditing')"
      @cancel="closeClearDialog"
      @confirm="clearAllContent"
    />
    <ConfirmDialog
      :open="showDeleteDialog"
      :title="t('workbench.confirmDeleteTitle')"
      :description="t('workbench.confirmDeleteDescription', { title: pendingDeleteTask?.displayTitle || pendingDeleteTask?.title || pendingDeleteTask?.autoTitle || currentTaskDisplayTitle })"
      :confirm-text="t('workbench.confirmDeleteAction')"
      :cancel-text="t('workbench.keepForNow')"
      :loading="removingTask"
      danger
      @cancel="closeDeleteDialog"
      @confirm="confirmRemoveCurrentTask"
    />
    <ConfirmDialog
      :open="showTodoDeleteConfirm"
      :title="t('workbench.confirmDeleteTodoTitle')"
      :description="t('workbench.confirmDeleteTodoDescription')"
      :confirm-text="t('workbench.confirmDeleteAction')"
      :cancel-text="t('workbench.keepForNow')"
      danger
      @cancel="closeTodoDeleteConfirm"
      @confirm="confirmDeleteTodo"
    />
    <ConfirmDialog
      :open="showTodoUseConfirm"
      :title="t('workbench.appendEditorTitle')"
      :description="t('workbench.appendEditorDescription', { count: pendingTodoUseIds.length })"
      :confirm-text="t('workbench.confirmAppendAction')"
      :cancel-text="t('workbench.dontAppendYet')"
      @cancel="closeTodoUseConfirm"
      @confirm="applyTodoToEditor(undefined, { append: true })"
    />
    <WorkbenchTodoDialog
      :open="showTodoDialog"
      :items="currentTodoItems"
      @close="closeTodoDialog"
      @delete="handleDeleteTodo"
      @use="handleUseTodo"
    />
    <TaskDiffReviewDialog
      :open="showDiffDialog"
      :task-slug="currentTaskSlug"
      :task-title="currentTaskDisplayTitle"
      :session-id="currentRenderedTask?.codexSessionId || ''"
      :preferred-view="preferredInspectorView"
      :preferred-scope="preferredDiffScope"
      :preferred-run-id="preferredDiffRunId"
      :focus-token="diffFocusToken"
      @close="closeTaskDiff"
    />
    <WorkbenchSettingsDialog :open="showSettingsDialog" @close="closeSettingsDialog" />
    <EditTaskDialog
      :open="showEditTaskDialog"
      :task-slug="currentTaskSlug"
      :task-title="currentTaskDisplayTitle"
      @close="closeEditTaskDialog"
      @saved="handleTaskSettingsSaved"
    />

    <div v-if="!isMobileLayout" class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-1">
      <WorkbenchTaskListPanel
        v-bind="taskListPanelProps"
        v-on="taskListPanelListeners"
      />

      <div class="grid min-h-0 gap-4 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
        <div class="min-h-0 min-w-0 overflow-hidden">
          <WorkbenchActivityPanel
            v-if="currentRenderedTask"
            ref="codexPanelRef"
            v-bind="activityPanelProps"
            v-on="activityPanelListeners"
          />
        </div>

        <div class="min-h-0 min-w-0 overflow-hidden">
          <WorkbenchInputPanel
            ref="editorRef"
            v-model="draft.blocks"
            v-bind="inputPanelProps"
            v-on="inputPanelListeners"
          />
        </div>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-hidden">
      <WorkbenchTaskListPanel
        v-if="mobileView === 'tasks'"
        v-bind="taskListPanelProps"
        mobile
        v-on="taskListPanelListeners"
      />

      <div v-else class="flex h-full min-h-0 flex-col gap-1.5 overflow-hidden">
        <WorkbenchMobileDetailHeader
          v-bind="mobileDetailHeaderProps"
          v-on="mobileDetailHeaderListeners"
        />

        <section class="workbench-mobile-tabs-panel shrink-0">
          <div class="workbench-mobile-tabs grid grid-cols-2 gap-2">
            <button
              type="button"
              class="tool-button px-3 py-1.5 text-sm"
              :class="mobileDetailTab === 'activity' ? 'tool-button-accent-subtle' : ''"
              @click="mobileDetailTab = 'activity'"
            >
              {{ t('workbench.activity') }}
            </button>
            <button
              type="button"
              class="tool-button px-3 py-1.5 text-sm"
              :class="mobileDetailTab === 'input' ? 'tool-button-accent-subtle' : ''"
              @click="mobileDetailTab = 'input'"
            >
              {{ t('workbench.input') }}
            </button>
          </div>
        </section>

        <div class="min-h-0 flex-1 overflow-hidden">
          <div v-show="mobileDetailTab === 'activity'" class="h-full min-h-0">
            <WorkbenchActivityPanel
              ref="codexPanelRef"
              v-bind="activityPanelProps"
              :empty-message="t('workbench.selectTask')"
              v-on="activityPanelListeners"
            />
          </div>

          <div v-show="mobileDetailTab === 'input'" class="h-full min-h-0">
            <WorkbenchInputPanel
              ref="editorRef"
              v-model="draft.blocks"
              v-bind="inputPanelProps"
              v-on="inputPanelListeners"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
