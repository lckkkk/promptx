<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  Bot,
  CircleAlert,
  LoaderCircle,
  PencilLine,
  RefreshCcw,
  Square,
} from 'lucide-vue-next'
import CodexSessionManagerDialog from './CodexSessionManagerDialog.vue'
import {
  createCodexSession,
  deleteCodexSession,
  listCodexSessions,
  listCodexWorkspaces,
  streamPromptToCodexSession,
  updateCodexSession,
} from '../lib/api.js'

const emit = defineEmits(['sending-change'])

const props = defineProps({
  prompt: {
    type: String,
    default: '',
  },
  buildPrompt: {
    type: Function,
    default: null,
  },
  beforeSend: {
    type: Function,
    default: null,
  },
  storageKey: {
    type: String,
    default: 'promptx:codex-session-id',
  },
})

const sessions = ref([])
const workspaces = ref([])
const loading = ref(false)
const managerBusy = ref(false)
const sending = ref(false)
const sessionError = ref('')
const turns = ref([])
const currentController = ref(null)
const selectedSessionId = ref('')
const transcriptRef = ref(null)
const sendingStartedAt = ref(0)
const sendingElapsedSeconds = ref(0)
const showManager = ref(false)
const runningSessionId = ref('')

let turnId = 0
let logId = 0
let sendingTimer = null

const hasPrompt = computed(() => {
  if (typeof props.buildPrompt === 'function') {
    return true
  }
  return Boolean(String(props.prompt || '').trim())
})

const hasSessions = computed(() => sessions.value.length > 0)
const sortedSessions = computed(() => sortSessions(sessions.value))
const selectedSession = computed(() => sessions.value.find((session) => session.id === selectedSessionId.value) || null)
const helperText = computed(() => {
  if (loading.value) {
    return '正在读取 PromptX 会话...'
  }
  if (!hasSessions.value) {
    return '还没有 PromptX 会话，请先在管理弹窗里新建一个固定工作目录。'
  }
  return '发送区只负责当前会话，其他维护动作统一放到管理弹窗里。'
})
const workingLabel = computed(() => `处理中 (${sendingElapsedSeconds.value}s)`)

function getDateOrderValue(value = '') {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

function isSessionRunning(sessionId) {
  return Boolean(sessionId) && sessionId === runningSessionId.value
}

function isCurrentSession(sessionId) {
  return Boolean(sessionId) && sessionId === selectedSessionId.value
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

function clearSendingTimer() {
  if (sendingTimer) {
    window.clearInterval(sendingTimer)
    sendingTimer = null
  }
}

function startSendingTimer() {
  sendingStartedAt.value = Date.now()
  sendingElapsedSeconds.value = 0
  clearSendingTimer()
  sendingTimer = window.setInterval(() => {
    sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
  }, 1000)
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

function formatTurnTime(value = '') {
  if (!value) {
    return ''
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }

  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function getRuntimeStatusLabel(sessionId) {
  return isSessionRunning(sessionId) ? '执行中' : '空闲'
}

function getRuntimeStatusClass(sessionId) {
  return isSessionRunning(sessionId)
    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
    : 'border-stone-300 bg-white text-stone-600 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300'
}

function getThreadStatusLabel(session) {
  return session?.started ? '已绑定线程' : '未启动'
}

function getThreadStatusClass(session) {
  return session?.started
    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
    : 'border-stone-300 bg-white text-stone-600 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300'
}

function normalizeSessionOption(session) {
  const title = session.title || '未命名会话'
  const tags = []

  if (isSessionRunning(session.id)) {
    tags.push('执行中')
  }
  if (isCurrentSession(session.id)) {
    tags.push('当前')
  }
  tags.push(getThreadStatusLabel(session))

  return `${title} - ${tags.join(' / ')}`
}

function normalizeLogEntry(entry) {
  if (!entry) {
    return null
  }

  if (typeof entry === 'string') {
    const text = entry.trim()
    if (!text) {
      return null
    }
    return {
      id: ++logId,
      kind: 'info',
      title: text,
      detail: '',
    }
  }

  const title = String(entry.title || '').trim()
  const detail = String(entry.detail || '').trim()
  if (!title && !detail) {
    return null
  }

  return {
    id: ++logId,
    kind: entry.kind || 'info',
    title: title || detail,
    detail: title ? detail : '',
  }
}

function scheduleScrollToBottom() {
  nextTick(() => {
    if (!transcriptRef.value) {
      return
    }

    const scrollToBottom = () => {
      if (!transcriptRef.value) {
        return
      }
      transcriptRef.value.scrollTop = transcriptRef.value.scrollHeight
    }

    scrollToBottom()
    requestAnimationFrame(() => {
      scrollToBottom()
      requestAnimationFrame(scrollToBottom)
    })
  })
}

function appendTurnEvent(turn, entry) {
  const normalized = normalizeLogEntry(entry)
  if (!normalized) {
    return
  }

  turn.events.push(normalized)
  if (turn.events.length > 120) {
    turn.events.splice(0, turn.events.length - 120)
  }
  scheduleScrollToBottom()
}

function formatCommandOutput(output = '', limit = 500) {
  const text = String(output || '').trim()
  if (!text) {
    return ''
  }
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}...`
}

function formatTodoItems(items = []) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) {
    return ''
  }

  return list
    .map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text || '未命名任务'}`)
    .join('\n')
}

function formatCodexEvent(event = {}) {
  const eventType = String(event.type || '').trim()
  const item = event.item || {}

  if (!eventType) {
    return {
      title: '收到 Codex 事件',
      detail: '',
    }
  }

  if (eventType === 'thread.started') {
    return {
      title: 'Codex 线程已创建',
      detail: event.thread_id ? `线程 ID：${event.thread_id}` : '',
    }
  }

  if (eventType === 'turn.started') {
    return {
      title: 'Codex 开始执行',
      detail: '',
    }
  }

  if (eventType === 'turn.completed') {
    const usage = event.usage
      ? `输入 ${event.usage.input_tokens || 0} / 输出 ${event.usage.output_tokens || 0}`
      : ''
    return {
      title: 'Codex 执行完成',
      detail: usage,
    }
  }

  if (eventType === 'item.started') {
    if (item.type === 'command_execution') {
      return {
        kind: 'command',
        title: '开始执行命令',
        detail: item.command || '',
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '更新待办列表',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `开始处理 ${item.type || '未知项目'}`,
      detail: '',
    }
  }

  if (eventType === 'item.updated' && item.type === 'todo_list') {
    return {
      kind: 'todo',
      title: '更新待办列表',
      detail: formatTodoItems(item.items),
    }
  }

  if (eventType === 'item.completed') {
    if (item.type === 'agent_message' && item.text) {
      return {
        kind: 'result',
        title: 'Codex 已返回结果',
        detail: '',
      }
    }

    if (item.type === 'command_execution') {
      const success = item.exit_code === 0 || item.status === 'completed'
      return {
        kind: success ? 'command' : 'error',
        title: success ? '命令执行完成' : `命令执行失败（exit ${item.exit_code ?? '?'}）`,
        detail: [item.command, formatCommandOutput(item.aggregated_output)].filter(Boolean).join('\n\n'),
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '更新待办列表',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `完成 ${item.type || '未知项目'}`,
      detail: '',
    }
  }

  return {
    title: `事件：${eventType}`,
    detail: '',
  }
}

function createTurn(promptText) {
  const turn = reactive({
    id: ++turnId,
    prompt: String(promptText || '').trim(),
    status: 'running',
    startedAt: new Date().toISOString(),
    events: [],
    responseMessage: '',
    errorMessage: '',
  })
  turns.value.push(turn)
  scheduleScrollToBottom()
  return turn
}

function getProcessStatus(turn) {
  if (turn.status === 'running') {
    return '进行中'
  }
  if (turn.status === 'error') {
    return '失败'
  }
  if (turn.status === 'stopped') {
    return '已停止'
  }
  return '已完成'
}

function getProcessCardClass(turn) {
  if (turn.status === 'error') {
    return 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100'
  }
  if (turn.status === 'stopped') {
    return 'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200'
  }
  if (turn.status === 'completed') {
    return 'border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'
  }
  return 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100'
}

function shouldShowResponse(turn) {
  return Boolean(turn.responseMessage || turn.errorMessage || turn.status === 'completed')
}

function mergeSession(nextSession) {
  if (!nextSession?.id) {
    return
  }

  const nextList = [...sessions.value]
  const index = nextList.findIndex((item) => item.id === nextSession.id)
  if (index >= 0) {
    nextList[index] = nextSession
  } else {
    nextList.unshift(nextSession)
  }
  sessions.value = nextList
}

function handleStreamEvent(payload = {}, turn) {
  if (payload.type === 'session') {
    mergeSession(payload.session)
    appendTurnEvent(turn, {
      title: `已连接 PromptX 会话：${payload.session?.title || '未命名会话'}`,
      detail: payload.session?.cwd ? `工作目录：${payload.session.cwd}` : '',
    })
    return
  }

  if (payload.type === 'session.updated') {
    mergeSession(payload.session)
    appendTurnEvent(turn, {
      title: '会话线程已更新',
      detail: payload.session?.started ? '后续请求会继续复用当前 PromptX 会话。' : '',
    })
    return
  }

  if (payload.type === 'status') {
    appendTurnEvent(turn, {
      title: payload.message || '状态已更新',
      detail: '',
    })
    return
  }

  if (payload.type === 'stderr') {
    appendTurnEvent(turn, {
      kind: 'error',
      title: 'stderr',
      detail: payload.text,
    })
    return
  }

  if (payload.type === 'stdout') {
    appendTurnEvent(turn, {
      kind: 'command',
      title: 'stdout',
      detail: payload.text,
    })
    return
  }

  if (payload.type === 'codex') {
    appendTurnEvent(turn, formatCodexEvent(payload.event))
    if (payload.event?.type === 'item.completed' && payload.event?.item?.type === 'agent_message' && payload.event?.item?.text) {
      turn.responseMessage = payload.event.item.text
    }
    return
  }

  if (payload.type === 'completed') {
    turn.status = 'completed'
    if (payload.message) {
      turn.responseMessage = payload.message
    }
    if (!turn.responseMessage) {
      turn.responseMessage = '本轮 Codex 执行已完成，没有返回额外文本。'
    }
    appendTurnEvent(turn, {
      kind: 'result',
      title: '本轮执行结束',
      detail: '',
    })
    return
  }

  if (payload.type === 'error') {
    turn.status = 'error'
    turn.errorMessage = payload.message || 'Codex 执行失败'
    appendTurnEvent(turn, {
      kind: 'error',
      title: '执行失败',
      detail: turn.errorMessage,
    })
  }
}

function hydrateSelectedSession() {
  if (!props.storageKey) {
    return
  }

  const saved = window.localStorage.getItem(props.storageKey)
  if (saved) {
    selectedSessionId.value = saved
  }
}

function persistSelectedSession(sessionId) {
  if (!props.storageKey) {
    return
  }

  if (sessionId) {
    window.localStorage.setItem(props.storageKey, sessionId)
  } else {
    window.localStorage.removeItem(props.storageKey)
  }
}

async function loadSessions() {
  loading.value = true
  sessionError.value = ''

  try {
    const [sessionPayload, workspacePayload] = await Promise.all([
      listCodexSessions(),
      listCodexWorkspaces(),
    ])
    const nextSessions = sessionPayload.items || []

    sessions.value = nextSessions
    workspaces.value = workspacePayload.items || []

    if (selectedSessionId.value && nextSessions.some((session) => session.id === selectedSessionId.value)) {
      return
    }

    selectedSessionId.value = sortSessions(nextSessions)[0]?.id || ''
  } catch (err) {
    sessionError.value = err.message
    throw err
  } finally {
    loading.value = false
  }
}

function upsertWorkspace(cwd = '') {
  const normalized = String(cwd || '').trim()
  if (!normalized || workspaces.value.includes(normalized)) {
    return
  }
  workspaces.value = [normalized, ...workspaces.value]
}

function openManager() {
  showManager.value = true
}

function closeManager() {
  showManager.value = false
}

function handleSelectSession(sessionId) {
  selectedSessionId.value = String(sessionId || '').trim()
}

async function handleCreateSession(payload) {
  managerBusy.value = true
  sessionError.value = ''

  try {
    const session = await createCodexSession(payload)
    mergeSession(session)
    upsertWorkspace(session.cwd)
    selectedSessionId.value = session.id
    return session
  } catch (err) {
    sessionError.value = err.message
    throw err
  } finally {
    managerBusy.value = false
  }
}

async function handleUpdateSession(sessionId, payload) {
  managerBusy.value = true
  sessionError.value = ''

  try {
    const session = await updateCodexSession(sessionId, payload)
    mergeSession(session)
    upsertWorkspace(session.cwd)
    return session
  } catch (err) {
    sessionError.value = err.message
    throw err
  } finally {
    managerBusy.value = false
  }
}

async function handleDeleteSession(sessionId) {
  const targetId = String(sessionId || '').trim()
  if (!targetId) {
    return {
      deletedSessionId: '',
      selectedSessionId: selectedSessionId.value,
    }
  }

  managerBusy.value = true
  sessionError.value = ''

  try {
    await deleteCodexSession(targetId)
    const remainingSessions = sessions.value.filter((session) => session.id !== targetId)
    sessions.value = remainingSessions

    let nextSelectedSessionId = selectedSessionId.value
    if (selectedSessionId.value === targetId) {
      nextSelectedSessionId = sortSessions(remainingSessions)[0]?.id || ''
      selectedSessionId.value = nextSelectedSessionId
    }

    return {
      deletedSessionId: targetId,
      selectedSessionId: nextSelectedSessionId,
    }
  } catch (err) {
    sessionError.value = err.message
    throw err
  } finally {
    managerBusy.value = false
  }
}

async function handleSend() {
  if (!hasPrompt.value || sending.value) {
    return false
  }

  if (!selectedSessionId.value) {
    openManager()
    sessionError.value = '请先选择一个 PromptX 会话。'
    return false
  }

  sessionError.value = ''

  try {
    if (typeof props.beforeSend === 'function') {
      const ready = await props.beforeSend()
      if (ready === false) {
        return false
      }
    }

    const prompt = typeof props.buildPrompt === 'function'
      ? await props.buildPrompt()
      : props.prompt

    if (!String(prompt || '').trim()) {
      sessionError.value = '没有可发送的提示词。'
      return false
    }

    const session = selectedSession.value
    if (!session) {
      sessionError.value = '当前会话不存在，请重新选择。'
      return false
    }

    runningSessionId.value = session.id
    sending.value = true
    const controller = new AbortController()
    const turn = createTurn(prompt)
    currentController.value = controller

    ;(async () => {
      try {
        await streamPromptToCodexSession(selectedSessionId.value, {
          prompt,
        }, {
          signal: controller.signal,
          onEvent(payload) {
            handleStreamEvent(payload, turn)
          },
        })
      } catch (err) {
        if (err.name === 'AbortError') {
          turn.status = 'stopped'
          appendTurnEvent(turn, {
            title: '执行已手动停止',
            detail: '',
          })
        } else {
          turn.status = 'error'
          turn.errorMessage = err.message
          appendTurnEvent(turn, {
            kind: 'error',
            title: '执行失败',
            detail: turn.errorMessage,
          })
        }
      } finally {
        sending.value = false
        runningSessionId.value = ''
        currentController.value = null
      }
    })()

    return true
  } catch (err) {
    sessionError.value = err.message
    return false
  }
}

function stopSending() {
  currentController.value?.abort()
}

function clearTurns() {
  turns.value = []
}

watch(
  sending,
  (value) => {
    if (value) {
      startSendingTimer()
      scheduleScrollToBottom()
    } else {
      clearSendingTimer()
      sendingStartedAt.value = 0
      sendingElapsedSeconds.value = 0
    }
    emit('sending-change', value)
  },
  { immediate: true }
)

watch(selectedSessionId, persistSelectedSession)

watch(
  turns,
  () => {
    scheduleScrollToBottom()
  },
  { deep: true, flush: 'post' }
)

defineExpose({
  send: handleSend,
  stop: stopSending,
})

onMounted(() => {
  hydrateSelectedSession()
  loadSessions().catch(() => {})
})

onBeforeUnmount(() => {
  clearSendingTimer()
})
</script>

<template>
  <section class="panel relative flex h-full min-h-0 flex-col overflow-hidden">
    <CodexSessionManagerDialog
      :open="showManager"
      :sessions="sessions"
      :workspaces="workspaces"
      :selected-session-id="selectedSessionId"
      :running-session-id="runningSessionId"
      :loading="loading"
      :sending="sending"
      :on-refresh="loadSessions"
      :on-create="handleCreateSession"
      :on-update="handleUpdateSession"
      :on-delete="handleDeleteSession"
      @close="closeManager"
      @select-session="handleSelectSession"
    />

    <div class="border-b border-stone-300 bg-stone-50/80 p-3 dark:border-stone-700 dark:bg-stone-900/80">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 shrink-0">
            <div class="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
              <Bot class="h-4 w-4" />
              <span>PromptX 会话</span>
            </div>
            <p class="mt-1 text-xs text-stone-500 dark:text-stone-400">{{ helperText }}</p>
          </div>

          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
              :disabled="loading || sending || managerBusy"
              @click="loadSessions().catch(() => {})"
            >
              <RefreshCcw class="h-4 w-4" />
              <span>刷新</span>
            </button>
            <button
              type="button"
              class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
              :disabled="sending || managerBusy"
              @click="openManager"
            >
              <PencilLine class="h-4 w-4" />
              <span>管理会话</span>
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label class="min-w-0 flex-1">
            <select
              v-model="selectedSessionId"
              class="w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-400"
              :disabled="loading || sending || managerBusy || !hasSessions"
            >
              <option value="" disabled>{{ hasSessions ? '请选择 PromptX 会话' : '暂无会话' }}</option>
              <option v-for="session in sortedSessions" :key="session.id" :value="session.id">
                {{ normalizeSessionOption(session) }}
              </option>
            </select>
          </label>

          <button
            type="button"
            class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs sm:self-stretch"
            :disabled="sending"
            @click="clearTurns"
          >
            <span>清空记录</span>
          </button>
        </div>

        <div
          v-if="selectedSession"
          class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
        >
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span class="rounded-sm border border-dashed px-2 py-1" :class="getThreadStatusClass(selectedSession)">
              {{ getThreadStatusLabel(selectedSession) }}
            </span>
            <span class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1" :class="getRuntimeStatusClass(selectedSession.id)">
              <span v-if="isSessionRunning(selectedSession.id)" class="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
              {{ getRuntimeStatusLabel(selectedSession.id) }}
            </span>
            <span
              class="rounded-sm border border-dashed border-sky-300 bg-sky-50 px-2 py-1 text-sky-700 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-300"
            >
              当前会话
            </span>
            <span>最近更新时间：{{ formatUpdatedAt(selectedSession.updatedAt) }}</span>
          </div>
          <div class="mt-1 break-all font-mono text-[11px] text-stone-500 dark:text-stone-400">{{ selectedSession.cwd }}</div>
        </div>

        <p v-if="sessionError" class="inline-flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <CircleAlert class="h-4 w-4" />
          <span>{{ sessionError }}</span>
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <div ref="transcriptRef" class="h-full space-y-4 overflow-y-auto px-4 py-4">
        <div
          v-if="!turns.length"
          class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
        >
          这里会显示 PromptX 管理的会话执行过程，包括状态、命令日志和 Codex 回复。
        </div>

        <div v-for="turn in turns" :key="turn.id" class="space-y-3">
          <div class="flex justify-end">
            <div class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed border-stone-300 bg-stone-100 px-4 py-3 text-sm text-stone-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
              <div class="flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
                <span>本轮提示词</span>
                <span>{{ formatTurnTime(turn.startedAt) }}</span>
              </div>
              <pre class="mt-2 whitespace-pre-wrap break-all font-sans leading-7">{{ turn.prompt }}</pre>
            </div>
          </div>

          <div class="flex justify-start">
            <div class="min-w-0 w-full max-w-[94%] rounded-sm border border-dashed px-4 py-3" :class="getProcessCardClass(turn)">
              <div class="flex items-center justify-between gap-3 text-xs">
                <span>执行过程</span>
                <span>{{ getProcessStatus(turn) }}</span>
              </div>
              <div v-if="turn.events.length" class="mt-3 space-y-3">
                <div
                  v-for="item in turn.events"
                  :key="item.id"
                  class="rounded-sm border border-dashed px-3 py-2"
                  :class="{
                    'border-stone-300/70 bg-white/70 dark:border-stone-700 dark:bg-stone-950/60': item.kind === 'info' || item.kind === 'command',
                    'border-amber-300/70 bg-amber-100/60 dark:border-amber-800 dark:bg-amber-950/40': item.kind === 'todo',
                    'border-emerald-300/70 bg-emerald-100/60 dark:border-emerald-800 dark:bg-emerald-950/40': item.kind === 'result',
                    'border-red-300/70 bg-red-100/60 dark:border-red-800 dark:bg-red-950/40': item.kind === 'error',
                  }"
                >
                  <div class="font-medium">{{ item.title }}</div>
                  <pre v-if="item.detail" class="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{{ item.detail }}</pre>
                </div>
              </div>
              <p v-else class="mt-3 text-xs text-current/80">正在等待 Codex 返回事件...</p>
            </div>
          </div>

          <div v-if="shouldShowResponse(turn)" class="flex justify-start">
            <div
              class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed px-4 py-3 text-sm leading-7"
              :class="turn.errorMessage
                ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100'
                : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100'"
            >
              <div class="text-xs text-current/80">{{ turn.errorMessage ? 'Codex 错误' : 'Codex 回复' }}</div>
              <div class="mt-2 whitespace-pre-wrap break-all">{{ turn.errorMessage || turn.responseMessage }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="sending"
      class="flex shrink-0 items-center justify-between gap-3 border-t border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div class="flex items-center gap-2">
        <LoaderCircle class="h-4 w-4 animate-spin" />
        <span>{{ workingLabel }}</span>
      </div>
      <button
        type="button"
        class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
        @click="stopSending"
      >
        <Square class="h-4 w-4" />
        <span>停止</span>
      </button>
    </div>
  </section>
</template>
