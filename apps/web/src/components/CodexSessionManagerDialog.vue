<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  PencilLine,
  Trash2,
  X,
} from 'lucide-vue-next'
import { useMediaQuery } from '../composables/useMediaQuery.js'
import ConfirmDialog from './ConfirmDialog.vue'
import CodexDirectoryPickerDialog from './CodexDirectoryPickerDialog.vue'
import CodexSessionManagerForm from './CodexSessionManagerForm.vue'
import CodexSessionManagerList from './CodexSessionManagerList.vue'
import CodexSessionManagerStatus from './CodexSessionManagerStatus.vue'
import { getEnabledAgentEngineOptions, normalizeAgentEngine } from '../lib/agentEngines.js'

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
  engine: 'codex',
  cwd: '',
})
const error = ref('')
const creating = ref(false)
const saving = ref(false)
const deleting = ref(false)
const showDeleteDialog = ref(false)
const showDirectoryPicker = ref(false)
const { matches: isMobileLayout } = useMediaQuery('(max-width: 767px)')
const mobileView = ref('list')
const mobileDetailTab = ref('basic')

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
const engineOptions = computed(() => getEnabledAgentEngineOptions())
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

  return '当前项目已绑定执行引擎会话，工作目录不能再修改；如需使用新目录，请新建项目。'
})
const engineReadonlyMessage = computed(() => {
  if (mode.value !== 'edit' || !activeSession.value) {
    return ''
  }

  return '项目创建后暂不支持直接切换执行引擎；如需更换，请新建项目。'
})
const desktopSubmitLabel = computed(() => (mode.value === 'create'
  ? (creating.value ? '创建中...' : '创建项目')
  : (saving.value ? '保存中...' : '保存修改')))
const mobileTitle = computed(() => (mode.value === 'create' ? '新建项目' : activeSession.value?.title || '未命名项目'))
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
  form.engine = normalizeAgentEngine(session?.engine)
  form.cwd = String(session?.cwd || '')
}

function openCreateMode() {
  mode.value = 'create'
  editingSessionId.value = ''
  error.value = ''
  form.title = ''
  form.engine = 'codex'
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

function getPreferredSessionId() {
  if (props.selectedSessionId && props.sessions.some((session) => session.id === props.selectedSessionId)) {
    return props.selectedSessionId
  }

  return sortedSessions.value[0]?.id || ''
}

function enterMobileDetail(tab = 'basic') {
  mobileView.value = 'detail'
  mobileDetailTab.value = tab
}

function returnToMobileList() {
  mobileView.value = 'list'
  mobileDetailTab.value = 'basic'
}

function handleCreateIntent() {
  openCreateMode()
  if (isMobileLayout.value) {
    enterMobileDetail('basic')
  }
}

function handleSessionCardClick(sessionId) {
  if (busy.value) {
    return
  }

  openEditMode(sessionId)
  if (isMobileLayout.value) {
    enterMobileDetail('basic')
  }
}

function handleDirectoryPicked(pathValue) {
  form.cwd = String(pathValue || '').trim()
}

function updateFormTitle(value) {
  form.title = String(value || '')
}

function updateFormEngine(value) {
  form.engine = normalizeAgentEngine(value)
}

function updateFormCwd(value) {
  form.cwd = String(value || '')
}

function initializeDialog() {
  error.value = ''
  showDeleteDialog.value = false
  mobileDetailTab.value = 'basic'
  mobileView.value = isMobileLayout.value ? 'list' : 'detail'

  const preferredSessionId = getPreferredSessionId()
  if (preferredSessionId) {
    openEditMode(preferredSessionId)
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
        engine: form.engine,
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
    engine: form.engine,
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
      if (isMobileLayout.value) {
        returnToMobileList()
      }
    } else {
      openCreateMode()
      if (isMobileLayout.value) {
        returnToMobileList()
      }
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
  },
  { immediate: true }
)

watch(
  isMobileLayout,
  (matches) => {
    if (!matches) {
      mobileView.value = 'detail'
    }
  },
  { immediate: true }
)

watch(
  () => props.sessions,
  () => {
    if (!props.open) {
      return
    }

    if (mode.value === 'create') {
      const hasDraft = Boolean(String(form.title || '').trim() || String(form.cwd || '').trim())
      if (hasDraft) {
        return
      }

      const preferredSessionId = getPreferredSessionId()
      if (preferredSessionId) {
        openEditMode(preferredSessionId)
      }
      return
    }

    if (activeSession.value) {
      syncFormFromSession(activeSession.value)
      return
    }

    const preferredSessionId = getPreferredSessionId()
    if (preferredSessionId) {
      openEditMode(preferredSessionId)
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

        <div v-if="!isMobileLayout" class="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <aside class="theme-divider border-b bg-[var(--theme-appPanelMuted)] px-3 py-3 sm:px-4 sm:py-4 lg:border-b-0 lg:border-r">
            <CodexSessionManagerList
              :busy="busy"
              :editing-session-id="editingSessionId"
              :format-updated-at="formatUpdatedAt"
              :get-runtime-status-class="getRuntimeStatusClass"
              :get-runtime-status-label="getRuntimeStatusLabel"
              :get-thread-status-class="getThreadStatusClass"
              :get-thread-status-label="getThreadStatusLabel"
              :has-sessions="hasSessions"
              :is-current-session="isCurrentSession"
              :is-session-running="isSessionRunning"
              :mode="mode"
              :sessions="sortedSessions"
              @create="handleCreateIntent"
              @select="handleSessionCardClick"
            />
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

            <div class="mt-5">
              <CodexSessionManagerForm
              :busy="busy"
                :can-edit-engine="mode !== 'edit'"
                :can-edit-cwd="mode !== 'edit' || canEditCwd"
                :cwd="form.cwd"
                :cwd-readonly-message="cwdReadonlyMessage"
                :duplicate-cwd-message="duplicateCwdMessage"
                :engine="form.engine"
                :engine-options="engineOptions"
                :engine-readonly-message="engineReadonlyMessage"
                :title="form.title"
                :workspace-suggestions="workspaceSuggestions"
                @open-directory-picker="showDirectoryPicker = true"
                @update:cwd="updateFormCwd"
                @update:engine="updateFormEngine"
                @update:title="updateFormTitle"
              />
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
                  {{ desktopSubmitLabel }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div v-if="mobileView === 'list'" class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div class="min-h-0 flex-1 overflow-hidden px-3 py-3">
              <CodexSessionManagerList
                mobile
                :busy="busy"
                :editing-session-id="editingSessionId"
                :format-updated-at="formatUpdatedAt"
                :get-runtime-status-class="getRuntimeStatusClass"
                :get-runtime-status-label="getRuntimeStatusLabel"
                :get-thread-status-class="getThreadStatusClass"
                :get-thread-status-label="getThreadStatusLabel"
                :has-sessions="hasSessions"
                :is-current-session="isCurrentSession"
                :is-session-running="isSessionRunning"
                :mode="mode"
                :sessions="sortedSessions"
                @create="handleCreateIntent"
                @select="handleSessionCardClick"
              />
            </div>
          </div>

          <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div class="theme-divider flex items-center gap-3 border-b px-4 py-3">
              <button
                type="button"
                class="tool-button inline-flex items-center gap-1.5 px-3 py-2 text-xs"
                :disabled="busy"
                @click="returnToMobileList"
              >
                <ArrowLeft class="h-4 w-4" />
                <span>列表</span>
              </button>
              <div class="min-w-0 flex-1">
                <div class="theme-heading truncate text-sm font-medium">
                  {{ mobileTitle }}
                </div>
                <p v-if="mode === 'edit' && activeSession?.cwd" class="theme-muted-text mt-1 truncate text-xs">
                  {{ activeSession.cwd }}
                </p>
              </div>
            </div>

            <div class="theme-divider border-b px-4 py-3">
              <div class="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  class="tool-button px-3 py-2 text-sm"
                  :class="mobileDetailTab === 'basic' ? 'tool-button-primary' : ''"
                  @click="mobileDetailTab = 'basic'"
                >
                  基本信息
                </button>
                <button
                  type="button"
                  class="tool-button px-3 py-2 text-sm"
                  :class="mobileDetailTab === 'status' ? 'tool-button-primary' : ''"
                  :disabled="mode === 'create'"
                  @click="mobileDetailTab = 'status'"
                >
                  状态
                </button>
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div v-if="mobileDetailTab === 'basic'">
                <CodexSessionManagerForm
                  mobile
                  :busy="busy"
                  :can-edit-engine="mode !== 'edit'"
                  :can-edit-cwd="mode !== 'edit' || canEditCwd"
                  :cwd="form.cwd"
                  :cwd-readonly-message="cwdReadonlyMessage"
                  :duplicate-cwd-message="duplicateCwdMessage"
                  :engine="form.engine"
                  :engine-options="engineOptions"
                  :engine-readonly-message="engineReadonlyMessage"
                  :title="form.title"
                  :workspace-suggestions="workspaceSuggestions"
                  @open-directory-picker="showDirectoryPicker = true"
                  @update:cwd="updateFormCwd"
                  @update:engine="updateFormEngine"
                  @update:title="updateFormTitle"
                />

                <p v-if="error" class="theme-danger-text mt-4 inline-flex items-center gap-2 text-sm">
                  <CircleAlert class="h-4 w-4" />
                  <span>{{ error }}</span>
                </p>

                <div class="theme-divider mt-6 flex flex-col gap-3 border-t border-dashed pt-4">
                  <button
                    type="button"
                    class="tool-button tool-button-primary w-full px-3 py-2 text-sm"
                    :disabled="busy"
                    @click="handleSubmit"
                  >
                    {{ desktopSubmitLabel }}
                  </button>
                  <button
                    v-if="mode === 'edit' && activeSession"
                    type="button"
                    class="tool-button theme-danger-text theme-danger-hover w-full px-3 py-2 text-sm"
                    :disabled="busy || sending"
                    @click="showDeleteDialog = true"
                  >
                    {{ deleting ? '删除中...' : '删除项目' }}
                  </button>
                </div>
              </div>

              <CodexSessionManagerStatus
                v-else
                :active-session="activeSession"
                :format-updated-at="formatUpdatedAt"
                :get-runtime-status-class="getRuntimeStatusClass"
                :get-runtime-status-label="getRuntimeStatusLabel"
                :get-thread-status-class="getThreadStatusClass"
                :get-thread-status-label="getThreadStatusLabel"
                :is-current-session="isCurrentSession"
                :is-session-running="isSessionRunning"
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
