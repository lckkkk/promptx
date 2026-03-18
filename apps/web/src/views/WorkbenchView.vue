<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowLeft,
  Blocks,
  CircleAlert,
  Copy,
  Plus,
  SendHorizontal,
  Settings2,
  Square,
  Trash2,
  Upload,
  WandSparkles,
} from 'lucide-vue-next'
import BlockEditor from '../components/BlockEditor.vue'
import TaskDiffReviewDialog from '../components/TaskDiffReviewDialog.vue'
import CodexSessionPanel from '../components/CodexSessionPanel.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import WorkbenchSettingsDialog from '../components/WorkbenchSettingsDialog.vue'
import TopToast from '../components/TopToast.vue'
import { usePageTitle } from '../composables/usePageTitle.js'
import { useToast } from '../composables/useToast.js'
import { useWorkbenchTasks } from '../composables/useWorkbenchTasks.js'

const showClearDialog = ref(false)
const showDeleteDialog = ref(false)
const showDiffDialog = ref(false)
const showSettingsDialog = ref(false)
const editingTaskTitleSlug = ref('')
const diffFocusToken = ref(0)
const preferredDiffScope = ref('workspace')
const preferredDiffRunId = ref('')
const { toastMessage, flashToast, clearToast } = useToast()

const codexPanelRef = ref(null)
const isMobileLayout = ref(false)
const mobileView = ref('tasks')
const MOBILE_BREAKPOINT_QUERY = '(max-width: 1023px)'
const MOBILE_DETAIL_HISTORY_KEY = 'promptxWorkbenchMobileView'
let mobileMediaQueryList = null
let removeMobileMediaQueryListener = () => {}

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

const {
  buildPromptForTask,
  clearCurrentTaskContent,
  createTaskAndSelect,
  creatingTask,
  currentSelectedSessionId,
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
  hasUnsavedChanges,
  initializeWorkbench,
  isCurrentTaskSending,
  loadingTask,
  loadingTasks,
  pageTitle,
  prepareCodexPromptForTask,
  removeCurrentTask,
  removingTask,
  renderedTasks,
  saveTask,
  saving,
  selectTask,
  updateLastPromptPreview,
  uploading,
} = useWorkbenchTasks({
  clearToast,
  flashToast,
  scrollCurrentPanelToBottom,
})

const currentRenderedTask = computed(() =>
  renderedTasks.value.find((task) => task.slug === currentTaskSlug.value) || null
)

usePageTitle(pageTitle)

function getTaskCardClass(task) {
  if (task.slug === currentTaskSlug.value) {
    return 'border-[var(--theme-accent)] bg-[var(--theme-accentSoft)] text-[var(--theme-textPrimary)] shadow-md shadow-[color-mix(in_srgb,var(--theme-accent)_18%,transparent)]'
  }

  if (task.sending) {
    return 'border-[var(--theme-warning)] bg-[var(--theme-appPanelMuted)] hover:bg-[var(--theme-appPanelHover)]'
  }

  return 'border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelMuted)] hover:bg-[var(--theme-appPanelHover)]'
}

function getTaskRunningBadgeClass(task) {
  if (task.slug === currentTaskSlug.value) {
    return 'border-[var(--theme-warning)] bg-[var(--theme-warningSoft)] text-[var(--theme-warningText)]'
  }

  return 'border-[var(--theme-warning)] bg-[var(--theme-warningSoft)] text-[var(--theme-warningText)]'
}

function getTaskWorkspaceBadgeClass(task) {
  return task.slug === currentTaskSlug.value
    ? 'border-[var(--theme-borderStrong)] bg-[var(--theme-appPanelStrong)] text-[var(--theme-textSecondary)]'
    : 'border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelStrong)] text-[var(--theme-textMuted)]'
}

function openTaskDiff(scope = 'workspace', runId = '') {
  preferredDiffScope.value = scope === 'run' ? 'run' : scope === 'task' ? 'task' : 'workspace'
  preferredDiffRunId.value = preferredDiffScope.value === 'run' ? String(runId || '') : ''
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

function hasMobileDetailHistoryState(state) {
  return state?.[MOBILE_DETAIL_HISTORY_KEY] === 'detail'
}

function replaceMobileHistoryState(view = 'tasks') {
  if (typeof window === 'undefined') {
    return
  }

  const nextState = { ...(window.history.state || {}) }
  if (view === 'detail') {
    nextState[MOBILE_DETAIL_HISTORY_KEY] = 'detail'
  } else {
    delete nextState[MOBILE_DETAIL_HISTORY_KEY]
  }

  window.history.replaceState(nextState, '')
}

function pushMobileDetailHistoryState() {
  if (typeof window === 'undefined') {
    return
  }

  const nextState = {
    ...(window.history.state || {}),
    [MOBILE_DETAIL_HISTORY_KEY]: 'detail',
  }
  window.history.pushState(nextState, '')
}

function syncMobileViewFromHistory(state = null) {
  if (!isMobileLayout.value) {
    mobileView.value = 'detail'
    return
  }

  if (!currentTaskSlug.value) {
    mobileView.value = 'tasks'
    replaceMobileHistoryState('tasks')
    return
  }

  mobileView.value = hasMobileDetailHistoryState(state) ? 'detail' : 'tasks'
}

function updateMobileLayout(matches) {
  isMobileLayout.value = Boolean(matches)
  syncMobileViewFromHistory(typeof window === 'undefined' ? null : window.history.state)
}

function enterMobileDetail(options = {}) {
  const { pushHistory = true } = options
  mobileView.value = 'detail'
  if (!isMobileLayout.value) {
    return
  }

  if (pushHistory) {
    pushMobileDetailHistoryState()
    return
  }

  replaceMobileHistoryState('detail')
}

function leaveMobileDetail(options = {}) {
  const { useHistory = true } = options
  if (!isMobileLayout.value) {
    mobileView.value = 'tasks'
    return
  }

  if (useHistory && hasMobileDetailHistoryState(window.history.state)) {
    window.history.back()
    return
  }

  mobileView.value = 'tasks'
  replaceMobileHistoryState('tasks')
}

function handlePopState(event) {
  if (!isMobileLayout.value) {
    return
  }

  mobileView.value = hasMobileDetailHistoryState(event.state) && currentTaskSlug.value ? 'detail' : 'tasks'
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

function openDeleteDialog() {
  showDeleteDialog.value = true
}

function closeDeleteDialog() {
  if (removingTask.value) {
    return
  }

  showDeleteDialog.value = false
}

async function confirmRemoveCurrentTask() {
  await removeCurrentTask()
  showDeleteDialog.value = false
  if (isMobileLayout.value) {
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

async function copyCodexPrompt() {
  await navigator.clipboard.writeText(buildPromptForTask(currentTaskSlug.value))
  flashToast('已复制给 Codex')
}

async function handleCreateTask() {
  const created = await createTaskAndSelect()
  if (created && isMobileLayout.value) {
    enterMobileDetail()
  }
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
    enterMobileDetail()
  }
}

async function sendToCodex() {
  const taskSlug = currentTaskSlug.value
  if (!taskSlug) {
    return
  }

  updateLastPromptPreview(taskSlug, buildPromptForTask(taskSlug))
  const didSend = await getCurrentPanelRef(taskSlug)?.send?.()
  if (!didSend || taskSlug !== currentTaskSlug.value) {
    return
  }

  clearCurrentTaskContent({ silent: true })
  await saveTask({ auto: false, silent: true })
}

function stopCodex() {
  getCurrentPanelRef(currentTaskSlug.value)?.stop?.()
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
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    mobileMediaQueryList = window.matchMedia(MOBILE_BREAKPOINT_QUERY)
    updateMobileLayout(mobileMediaQueryList.matches)
    const handleMediaChange = (event) => {
      updateMobileLayout(event.matches)
    }

    if (typeof mobileMediaQueryList.addEventListener === 'function') {
      mobileMediaQueryList.addEventListener('change', handleMediaChange)
      removeMobileMediaQueryListener = () => mobileMediaQueryList?.removeEventListener('change', handleMediaChange)
    } else if (typeof mobileMediaQueryList.addListener === 'function') {
      mobileMediaQueryList.addListener(handleMediaChange)
      removeMobileMediaQueryListener = () => mobileMediaQueryList?.removeListener(handleMediaChange)
    }
  }
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('keydown', handleWindowKeydown)
  window.addEventListener('popstate', handlePopState)
})

onBeforeUnmount(() => {
  removeMobileMediaQueryListener()
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('keydown', handleWindowKeydown)
  window.removeEventListener('popstate', handlePopState)
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <TopToast :message="toastMessage" />

    <ConfirmDialog
      :open="showClearDialog"
      title="确认清空当前任务？"
      description="将清空右侧编辑区内容，但会保留当前任务本身。"
      confirm-text="确认清空"
      cancel-text="继续编辑"
      @cancel="closeClearDialog"
      @confirm="clearAllContent"
    />
    <ConfirmDialog
      :open="showDeleteDialog"
      title="确认删除当前任务？"
      :description="`将删除「${currentTaskDisplayTitle}」，删除后无法恢复。`"
      confirm-text="确认删除"
      cancel-text="先保留"
      :loading="removingTask"
      danger
      @cancel="closeDeleteDialog"
      @confirm="confirmRemoveCurrentTask"
    />
    <TaskDiffReviewDialog
      :open="showDiffDialog"
      :task-slug="currentTaskSlug"
      :task-title="currentTaskDisplayTitle"
      :preferred-scope="preferredDiffScope"
      :preferred-run-id="preferredDiffRunId"
      :focus-token="diffFocusToken"
      @close="closeTaskDiff"
    />
    <WorkbenchSettingsDialog
      :open="showSettingsDialog"
      @close="closeSettingsDialog"
    />

    <div v-if="!isMobileLayout" class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-1">
      <aside class="panel flex min-h-0 flex-col overflow-hidden">
        <div class="theme-divider border-b px-4 py-4">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-h-8 items-center">
              <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
                <Blocks class="h-4 w-4" />
                <span>PromptX 工作台</span>
              </div>
            </div>
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
              @click="openSettingsDialog"
            >
              <Settings2 class="h-4 w-4" />
              <span class="hidden sm:inline">设置</span>
            </button>
          </div>
          <button
            type="button"
            class="tool-button tool-button-primary mt-4 inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-sm"
            :disabled="creatingTask || loadingTask || uploading"
            @click="handleCreateTask"
          >
            <Plus class="h-4 w-4" />
            <span>{{ creatingTask ? '创建中...' : '新建任务' }}</span>
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div v-if="loadingTasks && !renderedTasks.length" class="theme-empty-state px-3 py-4 text-sm">
            正在加载任务...
          </div>

          <div v-else class="space-y-2">
            <article
              v-for="task in renderedTasks"
              :key="task.slug"
              class="group relative cursor-default rounded-sm border px-3 py-3 transition"
              :class="getTaskCardClass(task)"
              @click="handleTaskSelect(task.slug)"
            >
              <span
                v-if="task.slug === currentTaskSlug"
                class="absolute inset-y-2 left-0 w-1 rounded-full"
                :class="'bg-[var(--theme-accent)]'"
              />
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 h-5 flex-1 overflow-hidden">
                  <input
                    v-if="task.slug === currentTaskSlug && editingTaskTitleSlug === task.slug"
                    v-model="draft.title"
                    type="text"
                    maxlength="140"
                    data-task-title-input="current"
                    class="block h-5 min-h-0 w-full appearance-none border-0 bg-transparent p-0 text-left text-sm font-semibold leading-5 outline-none placeholder:text-[var(--theme-textMuted)]"
                    :placeholder="draft.autoTitle || currentTaskAutoTitle || '未命名任务'"
                    @click.stop
                    @keydown.enter.prevent="$event.target.blur()"
                    @keydown.esc.prevent="editingTaskTitleSlug = ''"
                    @blur="handleTaskTitleBlur"
                  >
                  <button
                    v-else
                    type="button"
                    class="block h-5 w-full cursor-pointer truncate bg-transparent p-0 text-left text-sm leading-5"
                    :class="task.slug === currentTaskSlug ? 'font-semibold' : 'font-medium'"
                    @click.stop="handleTaskTitleClick(task.slug)"
                  >{{ task.displayTitle }}</button>
                </div>
                <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
                  <span
                    v-if="task.sending"
                    class="inline-flex items-center gap-1.5 rounded-sm border border-dashed px-1.5 py-0.5"
                    :class="getTaskRunningBadgeClass(task)"
                  >
                    <span class="task-loading-dots" aria-hidden="true">
                      <span class="task-loading-dots__dot"></span>
                      <span class="task-loading-dots__dot"></span>
                      <span class="task-loading-dots__dot"></span>
                    </span>
                    <span>运行中</span>
                  </span>
                </div>
              </div>
              <div class="mt-2 truncate text-xs opacity-80">{{ task.lastPromptPreview || '还没有发送记录' }}</div>
              <div class="mt-2 flex items-center justify-between gap-3">
                <div class="min-w-0 text-[11px] opacity-70">{{ new Date(task.updatedAt).toLocaleString('zh-CN') }}</div>
                <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
                  <span
                    v-if="task.workspaceDiffSummary?.supported && task.workspaceDiffSummary?.fileCount"
                    class="inline-flex items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5"
                    :class="getTaskWorkspaceBadgeClass(task)"
                  >
                    <span>{{ task.workspaceDiffSummary?.fileCount }} 文件</span>
                  </span>
                </div>
              </div>
            </article>
          </div>
        </div>

        <div class="theme-divider border-t px-3 py-3">
          <div v-if="error" class="theme-danger-text mb-3 inline-flex min-w-0 items-start gap-2 text-xs">
            <CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
            <span class="min-w-0 break-words">{{ error }}</span>
          </div>
          <button
            type="button"
            class="tool-button theme-danger-text theme-danger-hover inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-sm"
            :disabled="!currentTaskSlug || removingTask || creatingTask || isCurrentTaskSending"
            @click="openDeleteDialog"
          >
            <Trash2 class="h-4 w-4" />
            <span>{{ removingTask ? '删除中...' : '删除当前任务' }}</span>
          </button>
        </div>
      </aside>

      <div class="grid min-h-0 gap-4 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
        <div class="min-h-0 min-w-0 overflow-hidden">
          <div v-if="currentRenderedTask" class="h-full min-h-0">
            <CodexSessionPanel
              ref="codexPanelRef"
              :active="Boolean(currentRenderedTask?.slug)"
              :task-slug="currentRenderedTask.slug"
              :build-prompt="() => prepareCodexPromptForTask(currentRenderedTask.slug)"
              :selected-session-id="currentRenderedTask.codexSessionId || ''"
              :session-selection-locked="Boolean(currentRenderedTask.sessionSelectionLocked)"
              :session-selection-lock-reason="currentRenderedTask.sessionSelectionLockReason || ''"
              @sending-change="handleTaskSendingChange(currentRenderedTask.slug, $event)"
              @selected-session-change="handleTaskSessionChange(currentRenderedTask.slug, $event)"
              @open-diff="openTaskDiff($event.scope, $event.runId)"
            />
          </div>
        </div>

        <div class="min-h-0 min-w-0 overflow-hidden">
          <section v-if="loadingTask && !draft.blocks.length" class="panel theme-muted-text flex h-full items-center px-5 py-4 text-sm">
            正在加载任务内容...
          </section>
          <BlockEditor
            v-else
            ref="editorRef"
            v-model="draft.blocks"
            :codex-session-id="currentSelectedSessionId"
            :uploading="uploading"
            @upload-files="handleUpload"
            @import-text-files="handleImportTextFiles"
            @import-pdf-files="handleImportPdfFiles"
            @clear-request="openClearDialog"
          >
            <template #header-actions>
              <button type="button" class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3" @click="editorRef?.openFilePicker?.()">
                <Upload class="h-4 w-4" />
                <span>选文件</span>
              </button>
              <button type="button" class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3" @click="openClearDialog">
                <WandSparkles class="h-4 w-4" />
                <span>清空</span>
              </button>
              <button type="button" class="tool-button hidden items-center justify-center gap-1.5 px-2 py-2 text-xs sm:inline-flex sm:w-auto sm:gap-2 sm:px-3" @click="copyCodexPrompt">
                <Copy class="h-4 w-4" />
                <span>复制</span>
              </button>
              <button
                v-if="!isCurrentTaskSending"
                type="button"
                class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
                @click="sendToCodex"
              >
                <SendHorizontal class="h-4 w-4" />
                <span>发送</span>
              </button>
              <button
                v-else
                type="button"
                class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
                @click="stopCodex"
              >
                <Square class="h-4 w-4" />
                <span>停止</span>
              </button>
            </template>
          </BlockEditor>
        </div>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-hidden">
      <aside v-if="mobileView === 'tasks'" class="panel flex h-full min-h-0 flex-col overflow-hidden">
        <div class="theme-divider border-b px-4 py-4">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-h-8 items-center">
              <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
                <Blocks class="h-4 w-4" />
                <span>PromptX 工作台</span>
              </div>
            </div>
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
              @click="openSettingsDialog"
            >
              <Settings2 class="h-4 w-4" />
              <span>设置</span>
            </button>
          </div>
          <button
            type="button"
            class="tool-button tool-button-primary mt-4 inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-sm"
            :disabled="creatingTask || loadingTask || uploading"
            @click="handleCreateTask"
          >
            <Plus class="h-4 w-4" />
            <span>{{ creatingTask ? '创建中...' : '新建任务' }}</span>
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div v-if="loadingTasks && !renderedTasks.length" class="theme-empty-state px-3 py-4 text-sm">
            正在加载任务...
          </div>

          <div v-else class="space-y-2">
            <article
              v-for="task in renderedTasks"
              :key="task.slug"
              class="group relative cursor-default rounded-sm border px-3 py-3 transition"
              :class="getTaskCardClass(task)"
              @click="handleTaskSelect(task.slug)"
            >
              <span
                v-if="task.slug === currentTaskSlug"
                class="absolute inset-y-2 left-0 w-1 rounded-full"
                :class="'bg-[var(--theme-accent)]'"
              />
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 h-5 flex-1 overflow-hidden">
                  <input
                    v-if="task.slug === currentTaskSlug && editingTaskTitleSlug === task.slug"
                    v-model="draft.title"
                    type="text"
                    maxlength="140"
                    data-task-title-input="current"
                    class="block h-5 min-h-0 w-full appearance-none border-0 bg-transparent p-0 text-left text-sm font-semibold leading-5 outline-none placeholder:text-[var(--theme-textMuted)]"
                    :placeholder="draft.autoTitle || currentTaskAutoTitle || '未命名任务'"
                    @click.stop
                    @keydown.enter.prevent="$event.target.blur()"
                    @keydown.esc.prevent="editingTaskTitleSlug = ''"
                    @blur="handleTaskTitleBlur"
                  >
                  <button
                    v-else
                    type="button"
                    class="block h-5 w-full cursor-pointer truncate bg-transparent p-0 text-left text-sm leading-5"
                    :class="task.slug === currentTaskSlug ? 'font-semibold' : 'font-medium'"
                    @click.stop="handleTaskTitleClick(task.slug)"
                  >{{ task.displayTitle }}</button>
                </div>
                <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
                  <span
                    v-if="task.sending"
                    class="inline-flex items-center gap-1.5 rounded-sm border border-dashed px-1.5 py-0.5"
                    :class="getTaskRunningBadgeClass(task)"
                  >
                    <span class="task-loading-dots" aria-hidden="true">
                      <span class="task-loading-dots__dot"></span>
                      <span class="task-loading-dots__dot"></span>
                      <span class="task-loading-dots__dot"></span>
                    </span>
                    <span>运行中</span>
                  </span>
                </div>
              </div>
              <div class="mt-2 truncate text-xs opacity-80">{{ task.lastPromptPreview || '还没有发送记录' }}</div>
              <div class="mt-2 flex items-center justify-between gap-3">
                <div class="min-w-0 text-[11px] opacity-70">{{ new Date(task.updatedAt).toLocaleString('zh-CN') }}</div>
                <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
                  <span
                    v-if="task.workspaceDiffSummary?.supported && task.workspaceDiffSummary?.fileCount"
                    class="inline-flex items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5"
                    :class="getTaskWorkspaceBadgeClass(task)"
                  >
                    <span>{{ task.workspaceDiffSummary?.fileCount }} 文件</span>
                  </span>
                </div>
              </div>
            </article>
          </div>
        </div>

        <div class="theme-divider border-t px-3 py-3">
          <div v-if="error" class="theme-danger-text mb-3 inline-flex min-w-0 items-start gap-2 text-xs">
            <CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
            <span class="min-w-0 break-words">{{ error }}</span>
          </div>
          <button
            type="button"
            class="tool-button theme-danger-text theme-danger-hover inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-sm"
            :disabled="!currentTaskSlug || removingTask || creatingTask || isCurrentTaskSending"
            @click="openDeleteDialog"
          >
            <Trash2 class="h-4 w-4" />
            <span>{{ removingTask ? '删除中...' : '删除当前任务' }}</span>
          </button>
        </div>
      </aside>

      <div v-else class="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
        <section class="panel shrink-0 overflow-hidden">
          <div class="theme-divider border-b px-4 py-3">
            <div class="flex items-center gap-3">
              <button
                type="button"
                class="tool-button inline-flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs"
                @click="leaveMobileDetail"
              >
                <ArrowLeft class="h-4 w-4" />
                <span>任务</span>
              </button>

              <div class="min-w-0 flex-1">
                <input
                  v-if="currentTaskSlug && editingTaskTitleSlug === currentTaskSlug"
                  v-model="draft.title"
                  type="text"
                  maxlength="140"
                  data-task-title-input="current"
                  class="block w-full appearance-none border-0 bg-transparent p-0 text-left text-sm font-semibold leading-6 outline-none placeholder:text-[var(--theme-textMuted)]"
                  :placeholder="draft.autoTitle || currentTaskAutoTitle || '未命名任务'"
                  @keydown.enter.prevent="$event.target.blur()"
                  @keydown.esc.prevent="editingTaskTitleSlug = ''"
                  @blur="handleTaskTitleBlur"
                >
                <button
                  v-else
                  type="button"
                  class="block w-full truncate bg-transparent p-0 text-left text-sm font-semibold leading-6"
                  :disabled="!currentTaskSlug"
                  @click="beginTaskTitleEdit(currentTaskSlug)"
                >{{ currentTaskDisplayTitle || '未命名任务' }}</button>
              </div>
            </div>
          </div>
        </section>

        <div class="grid min-h-0 flex-1 gap-3 grid-rows-[minmax(0,1.3fr)_minmax(0,0.7fr)] overflow-hidden">
          <div class="min-h-0 min-w-0 overflow-hidden">
            <div v-if="currentRenderedTask" class="h-full min-h-0">
              <CodexSessionPanel
                ref="codexPanelRef"
                :active="Boolean(currentRenderedTask?.slug)"
                :task-slug="currentRenderedTask.slug"
                :build-prompt="() => prepareCodexPromptForTask(currentRenderedTask.slug)"
                :selected-session-id="currentRenderedTask.codexSessionId || ''"
                :session-selection-locked="Boolean(currentRenderedTask.sessionSelectionLocked)"
                :session-selection-lock-reason="currentRenderedTask.sessionSelectionLockReason || ''"
                @sending-change="handleTaskSendingChange(currentRenderedTask.slug, $event)"
                @selected-session-change="handleTaskSessionChange(currentRenderedTask.slug, $event)"
                @open-diff="openTaskDiff($event.scope, $event.runId)"
              />
            </div>
            <section v-else class="panel theme-muted-text flex h-full items-center px-5 py-4 text-sm">
              请选择一个任务
            </section>
          </div>

          <div class="min-h-0 min-w-0 overflow-hidden">
            <section v-if="loadingTask && !draft.blocks.length" class="panel theme-muted-text flex h-full items-center px-5 py-4 text-sm">
              正在加载任务内容...
            </section>
            <BlockEditor
              v-else
              ref="editorRef"
              v-model="draft.blocks"
              :codex-session-id="currentSelectedSessionId"
              :uploading="uploading"
              @upload-files="handleUpload"
              @import-text-files="handleImportTextFiles"
              @import-pdf-files="handleImportPdfFiles"
              @clear-request="openClearDialog"
            >
              <template #header-actions>
                <button type="button" class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3" @click="editorRef?.openFilePicker?.()">
                  <Upload class="h-4 w-4" />
                  <span>选文件</span>
                </button>
                <button type="button" class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3" @click="openClearDialog">
                  <WandSparkles class="h-4 w-4" />
                  <span>清空</span>
                </button>
                <button type="button" class="tool-button hidden items-center justify-center gap-1.5 px-2 py-2 text-xs sm:inline-flex sm:w-auto sm:gap-2 sm:px-3" @click="copyCodexPrompt">
                  <Copy class="h-4 w-4" />
                  <span>复制</span>
                </button>
                <button
                  v-if="!isCurrentTaskSending"
                  type="button"
                  class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
                  @click="sendToCodex"
                >
                  <SendHorizontal class="h-4 w-4" />
                  <span>发送</span>
                </button>
                <button
                  v-else
                  type="button"
                  class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
                  @click="stopCodex"
                >
                  <Square class="h-4 w-4" />
                  <span>停止</span>
                </button>
              </template>
            </BlockEditor>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
