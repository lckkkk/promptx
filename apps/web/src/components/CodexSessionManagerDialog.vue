<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  Bot,
  CircleAlert,
  FolderOpen,
  PencilLine,
  Plus,
  Trash2,
  X,
} from 'lucide-vue-next'
import ConfirmDialog from './ConfirmDialog.vue'
import CodexDirectoryPickerDialog from './CodexDirectoryPickerDialog.vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  sessions: {
    type: Array,
    default: () => [],
  },
  workspaces: {
    type: Array,
    default: () => [],
  },
  selectedSessionId: {
    type: String,
    default: '',
  },
  selectionLocked: {
    type: Boolean,
    default: false,
  },
  selectionLockReason: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  sending: {
    type: Boolean,
    default: false,
  },
  onRefresh: {
    type: Function,
    default: null,
  },
  onCreate: {
    type: Function,
    default: null,
  },
  onUpdate: {
    type: Function,
    default: null,
  },
  onDelete: {
    type: Function,
    default: null,
  },
})

const emit = defineEmits(['close', 'select-session'])

const mode = ref('edit')
const editingSessionId = ref('')
const form = reactive({
  title: '',
  cwd: '',
})
const error = ref('')
const creating = ref(false)
const saving = ref(false)
const deleting = ref(false)
const showDeleteDialog = ref(false)
const showDirectoryPicker = ref(false)

const sortedSessions = computed(() => sortSessions(props.sessions))
const activeSession = computed(() => props.sessions.find((session) => session.id === editingSessionId.value) || null)
const hasSessions = computed(() => props.sessions.length > 0)
const currentSession = computed(() => props.sessions.find((session) => session.id === props.selectedSessionId) || null)
const canEditCwd = computed(() => !activeSession.value?.started)
const busy = computed(() => props.loading || creating.value || saving.value || deleting.value)
const workspaceSuggestions = computed(() => {
  const seen = new Set()
  const items = []

  ;[
    form.cwd,
    activeSession.value?.cwd,
    currentSession.value?.cwd,
    ...props.workspaces,
    ...props.sessions.map((session) => session.cwd),
  ].forEach((value) => {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    items.push(normalized)
  })

  return items.slice(0, 12)
})
const duplicateCwdSessions = computed(() => {
  const target = normalizeCwdForCompare(form.cwd)
  if (!target) {
    return []
  }

  return props.sessions.filter((session) => {
    if (session.id === activeSession.value?.id) {
      return false
    }
    return normalizeCwdForCompare(session.cwd) === target
  })
})
const duplicateCwdMessage = computed(() => {
  if (!duplicateCwdSessions.value.length) {
    return ''
  }

  const labels = duplicateCwdSessions.value
    .slice(0, 3)
    .map((session) => `「${session.title || '未命名项目'}」`)
    .join('、')
  const suffix = duplicateCwdSessions.value.length > 3 ? '等项目' : '项目'

  return `该目录已被${labels}${suffix}使用，建议优先复用，避免把同一目录拆成多个项目。`
})
const cwdReadonlyMessage = computed(() => {
  if (mode.value !== 'edit' || canEditCwd.value) {
    return ''
  }

  return '当前项目已绑定 Codex 线程，工作目录不能再修改；如需使用新目录，请新建项目。'
})
function getDateOrderValue(value = '') {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

function normalizeCwdForCompare(value = '') {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  const isWindowsPath = /^[a-z]:[\\/]/i.test(raw) || raw.includes('\\')
  let normalized = raw.replace(/\\/g, '/')

  if (normalized.length > 1 && !/^[a-z]:\/$/i.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '')
  }

  return isWindowsPath ? normalized.toLowerCase() : normalized
}

function isSessionRunning(sessionId) {
  return Boolean(props.sessions.find((session) => session.id === sessionId)?.running)
}

function isCurrentSession(sessionId) {
  return Boolean(sessionId) && sessionId === props.selectedSessionId
}

function sortSessions(items = []) {
  return [...items].sort((left, right) => {
    const runningDiff = Number(isSessionRunning(right.id)) - Number(isSessionRunning(left.id))
    if (runningDiff) {
      return runningDiff
    }

    const currentDiff = Number(isCurrentSession(right.id)) - Number(isCurrentSession(left.id))
    if (currentDiff) {
      return currentDiff
    }

    const updatedDiff = getDateOrderValue(right.updatedAt) - getDateOrderValue(left.updatedAt)
    if (updatedDiff) {
      return updatedDiff
    }

    return String(left.title || left.cwd || left.id).localeCompare(String(right.title || right.cwd || right.id), 'zh-CN')
  })
}

function getRuntimeStatusLabel(sessionId) {
  return isSessionRunning(sessionId) ? '运行中' : '空闲'
}

function getRuntimeStatusClass(sessionId) {
  return isSessionRunning(sessionId) ? 'theme-status-warning' : 'theme-status-success'
}

function getThreadStatusLabel(session) {
  return session?.started ? '已绑定线程' : '未启动'
}

function getThreadStatusClass(session) {
  return session?.started ? 'theme-status-success' : 'theme-status-neutral'
}

function formatUpdatedAt(value = '') {
  if (!value) {
    return '未知'
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return date.toLocaleString('zh-CN')
}

function syncFormFromSession(session) {
  form.title = String(session?.title || '')
  form.cwd = String(session?.cwd || '')
}

function openCreateMode() {
  mode.value = 'create'
  editingSessionId.value = ''
  error.value = ''
  form.title = ''
  form.cwd = ''
}

function openEditMode(sessionId) {
  const session = props.sessions.find((item) => item.id === sessionId)
  if (!session) {
    return
  }

  mode.value = 'edit'
  editingSessionId.value = session.id
  error.value = ''
  syncFormFromSession(session)
}

function handleDirectoryPicked(pathValue) {
  form.cwd = String(pathValue || '').trim()
}

function initializeDialog() {
  error.value = ''
  showDeleteDialog.value = false

  if (props.selectedSessionId && props.sessions.some((session) => session.id === props.selectedSessionId)) {
    openEditMode(props.selectedSessionId)
    return
  }

  if (sortedSessions.value[0]?.id) {
    openEditMode(sortedSessions.value[0].id)
    return
  }

  openCreateMode()
}

function handleKeydown(event) {
  if (!props.open || busy.value) {
    return
  }

  if (event.key === 'Escape') {
    emit('close')
  }
}

function selectSession(sessionId) {
  emit('select-session', sessionId)
}

async function handleRefresh() {
  if (busy.value || typeof props.onRefresh !== 'function') {
    return
  }

  error.value = ''

  try {
    await props.onRefresh()
  } catch (err) {
    error.value = err.message
  }
}

async function handleSubmit() {
  if (busy.value) {
    return
  }

  error.value = ''

  try {
    const submitAction = createSubmitAction()
    if (!submitAction) {
      return
    }

    await submitSession(submitAction)
  } catch (err) {
    error.value = err.message
  }
}

function createSubmitAction() {
  if (mode.value === 'create') {
    const cwd = String(form.cwd || '').trim()
    if (!cwd) {
      error.value = '请先填写工作目录。'
      return null
    }

    return {
      type: 'create',
      cwd,
      payload: {
        title: form.title,
        cwd,
      },
    }
  }

  if (!activeSession.value) {
    error.value = '当前项目不存在，请重新选择。'
    return null
  }

  const payload = {
    title: form.title,
  }

  if (canEditCwd.value) {
    payload.cwd = form.cwd
  }

  return {
    type: 'update',
    sessionId: activeSession.value.id,
    payload,
  }
}

async function submitSession(submitAction) {
  if (submitAction.type === 'create') {
    creating.value = true
    try {
      const session = await props.onCreate?.(submitAction.payload)
      if (session?.id) {
        openEditMode(session.id)
        emit('select-session', session.id)
      }
      return
    } finally {
      creating.value = false
    }
  }

  saving.value = true
  try {
    const session = await props.onUpdate?.(submitAction.sessionId, submitAction.payload)
    if (session?.id) {
      openEditMode(session.id)
    }
  } finally {
    saving.value = false
  }
}

async function handleDelete() {
  if (!activeSession.value || deleting.value) {
    return
  }

  const deletingSessionId = activeSession.value.id
  error.value = ''
  deleting.value = true

  try {
    const result = await props.onDelete?.(deletingSessionId)
    showDeleteDialog.value = false

    const remainingSessions = props.sessions.filter((session) => session.id !== deletingSessionId)
    const nextSessionId = result?.selectedSessionId || sortSessions(remainingSessions)[0]?.id || ''

    emit('select-session', nextSessionId)

    if (nextSessionId) {
      openEditMode(nextSessionId)
    } else {
      openCreateMode()
    }
  } catch (err) {
    error.value = err.message
  } finally {
    deleting.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    document.body.classList.toggle('overflow-hidden', open)

    if (open) {
      window.addEventListener('keydown', handleKeydown)
      initializeDialog()
      handleRefresh().catch(() => {})
      return
    }

    window.removeEventListener('keydown', handleKeydown)
    showDirectoryPicker.value = false
    showDeleteDialog.value = false
    error.value = ''
  }
)

watch(
  () => props.sessions,
  () => {
    if (!props.open) {
      return
    }

    if (mode.value === 'create') {
      return
    }

    if (activeSession.value) {
      syncFormFromSession(activeSession.value)
      return
    }

    if (props.selectedSessionId && props.sessions.some((session) => session.id === props.selectedSessionId)) {
      openEditMode(props.selectedSessionId)
      return
    }

    if (sortedSessions.value[0]?.id) {
      openEditMode(sortedSessions.value[0].id)
      return
    }

    openCreateMode()
  }
)

onBeforeUnmount(() => {
  document.body.classList.remove('overflow-hidden')
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-0 py-0 backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
      @click.self="!busy && emit('close')"
    >
      <section class="panel flex h-full w-full max-w-5xl flex-col overflow-hidden sm:h-auto sm:max-h-[88vh]">
        <ConfirmDialog
          :open="showDeleteDialog"
          title="确认删除 PromptX 项目？"
          :description="activeSession
            ? `将删除「${activeSession.title || '未命名项目'}」这条本地记录，不会删除工作目录，也不会删除 Codex 的历史数据。`
            : ''"
          confirm-text="确认删除"
          cancel-text="先保留"
          :loading="deleting"
          danger
          @cancel="showDeleteDialog = false"
          @confirm="handleDelete"
        />
        <CodexDirectoryPickerDialog
          :open="showDirectoryPicker"
          :initial-path="form.cwd"
          :suggestions="workspaceSuggestions"
          @close="showDirectoryPicker = false"
          @select="handleDirectoryPicked"
        />
        <div class="theme-divider flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3 sm:px-5 sm:py-4">
          <div>
            <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
              <Bot class="h-4 w-4" />
              <span>PromptX 项目管理</span>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="theme-icon-button h-9 w-9"
              :disabled="busy"
              @click="emit('close')"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div class="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <aside class="theme-divider border-b bg-[var(--theme-appPanelMuted)] px-3 py-3 sm:px-4 sm:py-4 lg:border-b-0 lg:border-r">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="theme-heading text-sm font-medium">项目列表</div>
                <p v-if="!hasSessions" class="theme-muted-text mt-1 text-xs">
                  还没有项目，先新建一个固定工作目录。
                </p>
              </div>
              <button
                type="button"
                class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                :disabled="busy"
                @click="openCreateMode"
              >
                <Plus class="h-4 w-4" />
                <span>新建</span>
              </button>
            </div>

            <div class="mt-4 max-h-52 space-y-2 overflow-y-auto pr-1 sm:max-h-64 lg:max-h-[calc(88vh-11rem)]">
              <article
                v-for="session in sortedSessions"
                :key="session.id"
                class="relative cursor-pointer rounded-sm border p-3 transition"
                :class="mode === 'edit' && editingSessionId === session.id
                  ? 'border-[var(--theme-accent)] bg-[var(--theme-appPanelStrong)] shadow-sm'
                  : isSessionRunning(session.id)
                    ? 'theme-status-warning'
                    : isCurrentSession(session.id)
                      ? 'theme-status-info'
                      : 'border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelStrong)] hover:border-[var(--theme-borderStrong)] hover:bg-[var(--theme-appPanel)]'"
                @click="!busy && openEditMode(session.id)"
              >
                <span
                  v-if="mode === 'edit' && editingSessionId === session.id"
                  class="absolute inset-y-3 left-0 w-1 rounded-full bg-[var(--theme-accent)]"
                />
                <div class="w-full text-left">
                  <div class="theme-heading flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span class="truncate">{{ session.title || '未命名项目' }}</span>
                    <span
                      v-if="isCurrentSession(session.id)"
                      class="theme-status-info rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
                    >
                      当前
                    </span>
                    <span
                      class="inline-flex items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
                      :class="getRuntimeStatusClass(session.id)"
                    >
                      <span v-if="isSessionRunning(session.id)" class="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
                      {{ getRuntimeStatusLabel(session.id) }}
                    </span>
                    <span class="rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]" :class="getThreadStatusClass(session)">
                      {{ getThreadStatusLabel(session) }}
                    </span>
                  </div>
                  <div class="theme-muted-text mt-2 break-all font-mono text-[11px] leading-5">
                    {{ session.cwd }}
                  </div>
                  <div class="theme-muted-text mt-2 text-[11px]">
                    最近更新：{{ formatUpdatedAt(session.updatedAt) }}
                  </div>
                </div>

              </article>
            </div>
          </aside>

          <div class="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
                  <PencilLine class="h-4 w-4" />
                  <span>{{ mode === 'create' ? '新建项目' : '编辑项目' }}</span>
                </div>
              </div>

            </div>

            <div class="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <label class="theme-muted-text block text-xs">
                <span>项目标题（可选）</span>
                <input
                  v-model="form.title"
                  type="text"
                  maxlength="140"
                  placeholder=""
                  class="tool-input mt-1"
                  :disabled="busy"
                >
              </label>

              <label class="theme-muted-text block text-xs">
                <span>工作目录</span>
                <div class="mt-1 flex gap-2">
                  <input
                    v-model="form.cwd"
                    type="text"
                    list="codex-manager-workspace-suggestions"
                    placeholder=""
                    class="tool-input min-w-0 flex-1 disabled:cursor-not-allowed disabled:opacity-80"
                    :class="duplicateCwdMessage
                      ? 'border-[var(--theme-warning)]'
                      : ''"
                    :disabled="busy || (mode === 'edit' && !canEditCwd)"
                  >
                  <button
                    type="button"
                    class="tool-button inline-flex shrink-0 items-center gap-2 px-3 py-2 text-xs"
                    :disabled="busy || (mode === 'edit' && !canEditCwd)"
                    @click="showDirectoryPicker = true"
                  >
                    <FolderOpen class="h-4 w-4" />
                    <span>选择目录</span>
                  </button>
                </div>
                <datalist id="codex-manager-workspace-suggestions">
                  <option v-for="item in workspaceSuggestions" :key="item" :value="item" />
                </datalist>
                <p v-if="duplicateCwdMessage" class="mt-2 text-[11px] leading-5 text-[var(--theme-warningText)]">
                  {{ duplicateCwdMessage }}
                </p>
                <p v-else-if="cwdReadonlyMessage" class="theme-muted-text mt-2 text-[11px] leading-5">
                  {{ cwdReadonlyMessage }}
                </p>
              </label>
            </div>

            <p v-if="error" class="theme-danger-text mt-4 inline-flex items-center gap-2 text-sm">
              <CircleAlert class="h-4 w-4" />
              <span>{{ error }}</span>
            </p>

            <div class="theme-divider mt-6 flex flex-col gap-3 border-t border-dashed pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-if="mode === 'edit' && activeSession"
                  type="button"
                  class="tool-button theme-danger-text theme-danger-hover inline-flex items-center gap-2 px-3 py-2 text-xs"
                  :disabled="busy || sending"
                  @click="showDeleteDialog = true"
                >
                  <Trash2 class="h-4 w-4" />
                  <span>{{ deleting ? '删除中...' : '删除项目' }}</span>
                </button>
              </div>

              <div class="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <button
                  type="button"
                  class="tool-button w-full px-3 py-2 text-xs sm:w-auto"
                  :disabled="busy"
                  @click="emit('close')"
                >
                  关闭
                </button>
                <button
                  v-if="mode === 'create' && hasSessions"
                  type="button"
                  class="tool-button w-full px-3 py-2 text-xs sm:w-auto"
                  :disabled="busy"
                  @click="initializeDialog"
                >
                  返回列表
                </button>
                <button
                  type="button"
                  class="tool-button tool-button-primary w-full px-3 py-2 text-xs sm:w-auto"
                  :disabled="busy"
                  @click="handleSubmit"
                >
                  {{ mode === 'create'
                    ? (creating ? '创建中...' : '创建项目')
                    : (saving ? '保存中...' : '保存修改') }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
