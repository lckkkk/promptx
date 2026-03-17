<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  Bot,
  CircleAlert,
  PencilLine,
  Plus,
  Trash2,
  X,
} from 'lucide-vue-next'
import ConfirmDialog from './ConfirmDialog.vue'

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
    .map((session) => `「${session.title || '未命名会话'}」`)
    .join('、')
  const suffix = duplicateCwdSessions.value.length > 3 ? '等会话' : '会话'

  return `该工作目录已被${labels}${suffix}使用，建议优先复用，避免把同一目录拆成多个会话。`
})
const selectionLockedMessage = computed(() =>
  props.selectionLockReason || '该任务已有会话历史，不能再切换会话；如需使用新会话，请新建任务。'
)
const cwdReadonlyMessage = computed(() => {
  if (mode.value !== 'edit' || canEditCwd.value) {
    return ''
  }

  return '当前会话已绑定 Codex 线程，工作目录不能再修改；如需使用新目录，请新建会话。'
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
  return isSessionRunning(sessionId)
    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
    : 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
}

function getThreadStatusLabel(session) {
  return session?.started ? '已绑定线程' : '未启动'
}

function getThreadStatusClass(session) {
  return session?.started
    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'border-stone-300 bg-white text-stone-600 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300'
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
  form.cwd = String(currentSession.value?.cwd || sortedSessions.value[0]?.cwd || props.workspaces[0] || '')
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
    error.value = '当前会话不存在，请重新选择。'
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
      class="fixed inset-0 z-50 flex items-end justify-center bg-stone-950/45 px-0 py-0 backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
      @click.self="!busy && emit('close')"
    >
      <section class="panel flex h-full w-full max-w-5xl flex-col overflow-hidden sm:h-auto sm:max-h-[88vh]">
        <ConfirmDialog
          :open="showDeleteDialog"
          title="确认删除 PromptX 会话？"
          :description="activeSession
            ? `将删除「${activeSession.title || '未命名会话'}」这条本地记录，不会删除工作目录，也不会删除 Codex 的历史数据。`
            : ''"
          confirm-text="确认删除"
          cancel-text="先保留"
          :loading="deleting"
          danger
          @cancel="showDeleteDialog = false"
          @confirm="handleDelete"
        />
        <div class="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800 sm:px-5 sm:py-4">
          <div>
            <div class="inline-flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
              <Bot class="h-4 w-4" />
              <span>PromptX 会话管理</span>
            </div>
          </div>

          <div class="flex items-center gap-2">
            <button
              type="button"
              class="inline-flex h-9 w-9 items-center justify-center rounded-sm text-stone-400 transition hover:bg-stone-200 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-stone-800 dark:hover:text-stone-200"
              :disabled="busy"
              @click="emit('close')"
            >
              <X class="h-4 w-4" />
            </button>
          </div>
        </div>

        <div class="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <aside class="border-b border-stone-200 bg-stone-50/80 px-3 py-3 dark:border-stone-800 dark:bg-stone-950/60 sm:px-4 sm:py-4 lg:border-b-0 lg:border-r">
            <div class="flex items-center justify-between gap-3">
              <div>
                <div class="text-sm font-medium text-stone-900 dark:text-stone-100">会话列表</div>
                <p v-if="!hasSessions" class="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  还没有会话，先新建一个固定工作目录。
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
                  ? 'border-emerald-500 bg-white shadow-sm dark:border-emerald-400 dark:bg-stone-900'
                  : isSessionRunning(session.id)
                    ? 'border-amber-300 bg-amber-50/70 hover:border-amber-400 dark:border-amber-800 dark:bg-amber-950/20 dark:hover:border-amber-700'
                    : isCurrentSession(session.id)
                      ? 'border-sky-300 bg-sky-50/70 hover:border-sky-400 dark:border-sky-800 dark:bg-sky-950/20 dark:hover:border-sky-700'
                      : 'border-stone-300 bg-white/70 hover:border-stone-500 hover:bg-white dark:border-stone-700 dark:bg-stone-900/70 dark:hover:border-stone-500 dark:hover:bg-stone-900'"
                @click="!busy && openEditMode(session.id)"
              >
                <span
                  v-if="mode === 'edit' && editingSessionId === session.id"
                  class="absolute inset-y-3 left-0 w-1 rounded-full bg-emerald-500 dark:bg-emerald-400"
                />
                <div class="w-full text-left">
                  <div class="flex flex-wrap items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
                    <span class="truncate">{{ session.title || '未命名会话' }}</span>
                    <span
                      v-if="isCurrentSession(session.id)"
                      class="rounded-sm border border-dashed border-sky-300 bg-sky-50 px-1.5 py-0.5 text-[10px] text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
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
                  <div class="mt-2 break-all font-mono text-[11px] leading-5 text-stone-500 dark:text-stone-400">
                    {{ session.cwd }}
                  </div>
                  <div class="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
                    最近更新：{{ formatUpdatedAt(session.updatedAt) }}
                  </div>
                </div>

              </article>
            </div>
          </aside>

          <div class="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div class="inline-flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
                  <PencilLine class="h-4 w-4" />
                  <span>{{ mode === 'create' ? '新建会话' : '编辑会话' }}</span>
                </div>
              </div>

            </div>

            <div class="mt-5 grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <label class="block text-xs text-stone-500 dark:text-stone-400">
                <span>会话标题（可选）</span>
                <input
                  v-model="form.title"
                  type="text"
                  maxlength="140"
                  placeholder="例如：yuyang-web"
                  class="mt-1 w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-400"
                  :disabled="busy"
                >
              </label>

              <label class="block text-xs text-stone-500 dark:text-stone-400">
                <span class="inline-flex items-center gap-2">
                  <span>工作目录</span>
                  <span
                    v-if="mode === 'edit' && !canEditCwd"
                    class="inline-flex items-center rounded-sm border border-dashed border-stone-300 bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
                  >
                    已锁定
                  </span>
                </span>
                <input
                  v-model="form.cwd"
                  type="text"
                  list="codex-manager-workspace-suggestions"
                  placeholder="例如：D:\\code\\yuyang-web"
                  class="mt-1 w-full rounded-sm border bg-white px-3 py-2 text-sm text-stone-900 outline-none transition disabled:cursor-not-allowed disabled:border-stone-200 disabled:bg-stone-100 disabled:text-stone-500 disabled:opacity-80 dark:bg-stone-950 dark:text-stone-100 dark:disabled:border-stone-800 dark:disabled:bg-stone-900 dark:disabled:text-stone-500"
                  :class="duplicateCwdMessage
                    ? 'border-amber-300 focus:border-amber-500 dark:border-amber-800 dark:focus:border-amber-500'
                    : 'border-stone-300 focus:border-stone-500 dark:border-stone-700 dark:focus:border-stone-400'"
                  :disabled="busy || (mode === 'edit' && !canEditCwd)"
                >
                <datalist id="codex-manager-workspace-suggestions">
                  <option v-for="item in workspaceSuggestions" :key="item" :value="item" />
                </datalist>
                <p v-if="duplicateCwdMessage" class="mt-2 text-[11px] leading-5 text-amber-700 dark:text-amber-300">
                  {{ duplicateCwdMessage }}
                </p>
                <p v-else-if="cwdReadonlyMessage" class="mt-2 text-[11px] leading-5 text-stone-500 dark:text-stone-400">
                  {{ cwdReadonlyMessage }}
                </p>
              </label>
            </div>

            <p v-if="error" class="mt-4 inline-flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
              <CircleAlert class="h-4 w-4" />
              <span>{{ error }}</span>
            </p>

            <div class="mt-6 flex flex-col gap-3 border-t border-dashed border-stone-300 pt-4 dark:border-stone-700 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-if="mode === 'edit' && activeSession"
                  type="button"
                  class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs text-red-700 hover:text-red-900 dark:text-red-300 dark:hover:text-red-200"
                  :disabled="busy || sending"
                  @click="showDeleteDialog = true"
                >
                  <Trash2 class="h-4 w-4" />
                  <span>{{ deleting ? '删除中...' : '删除会话' }}</span>
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
                    ? (creating ? '创建中...' : '创建会话')
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
