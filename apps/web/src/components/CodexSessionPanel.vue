<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  Bot,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Square,
  SendHorizontal,
} from 'lucide-vue-next'
import { listCodexSessions, streamPromptToCodexSession } from '../lib/api.js'

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
const loading = ref(false)
const sending = ref(false)
const error = ref('')
const responseMessage = ref('')
const eventLogs = ref([])
const currentController = ref(null)
const selectedSessionId = ref(window.localStorage.getItem(props.storageKey) || '')

const hasPrompt = computed(() => {
  if (typeof props.buildPrompt === 'function') {
    return true
  }
  return Boolean(String(props.prompt || '').trim())
})
const hasSessions = computed(() => sessions.value.length > 0)
const selectedSession = computed(() => sessions.value.find((session) => session.id === selectedSessionId.value) || null)
const helperText = computed(() => {
  if (loading.value) {
    return '正在读取本机 Codex session...'
  }
  if (!hasSessions.value) {
    return '还没有读取到本机 Codex session。'
  }
  return '会把当前文档提示词追加到选中的 Codex session。'
})

function formatUpdatedAt(value = '') {
  if (!value) {
    return '未知时间'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN')
}

function normalizeSessionOption(session) {
  const title = session.threadName || session.displayName || session.shortId
  return `${title} · ${formatUpdatedAt(session.updatedAt)} · ${session.shortId}`
}

function appendLog(message) {
  const text = String(message || '').trim()
  if (!text) {
    return
  }

  eventLogs.value = [...eventLogs.value, text].slice(-80)
}

function formatCodexEvent(event = {}) {
  const eventType = String(event.type || '').trim()
  if (!eventType) {
    return '收到一条 Codex 事件。'
  }

  if (eventType === 'thread.started') {
    return '已恢复目标 session。'
  }
  if (eventType === 'turn.started') {
    return 'Codex 开始处理这轮请求。'
  }
  if (eventType === 'turn.completed') {
    return 'Codex 已完成本轮执行。'
  }
  if (eventType === 'item.started') {
    return `开始处理 ${event.item?.type || '任务'}。`
  }
  if (eventType === 'item.completed') {
    if (event.item?.type === 'agent_message' && event.item?.text) {
      return 'Codex 已产出回复。'
    }
    return `完成 ${event.item?.type || '任务'}。`
  }

  return `事件：${eventType}`
}

function handleStreamEvent(payload = {}) {
  if (payload.type === 'session') {
    appendLog(`已连接 session：${payload.session?.displayName || payload.session?.shortId || '未知 session'}`)
    return
  }

  if (payload.type === 'status') {
    appendLog(payload.message || '状态已更新。')
    return
  }

  if (payload.type === 'stderr') {
    appendLog(`stderr: ${payload.text}`)
    return
  }

  if (payload.type === 'stdout') {
    appendLog(`stdout: ${payload.text}`)
    return
  }

  if (payload.type === 'codex') {
    appendLog(formatCodexEvent(payload.event))
    if (payload.event?.type === 'item.completed' && payload.event?.item?.type === 'agent_message' && payload.event?.item?.text) {
      responseMessage.value = payload.event.item.text
    }
    return
  }

  if (payload.type === 'completed') {
    if (payload.message) {
      responseMessage.value = payload.message
    }
    appendLog('已收到最终回复。')
    return
  }

  if (payload.type === 'error') {
    error.value = payload.message || 'Codex 执行失败。'
    appendLog(`错误：${error.value}`)
  }
}

async function loadSessions() {
  loading.value = true
  error.value = ''

  try {
    const payload = await listCodexSessions()
    sessions.value = payload.items || []

    if (selectedSessionId.value && sessions.value.some((session) => session.id === selectedSessionId.value)) {
      return
    }

    selectedSessionId.value = sessions.value[0]?.id || ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function handleSend() {
  if (!selectedSessionId.value || !hasPrompt.value || sending.value) {
    return
  }

  error.value = ''
  responseMessage.value = ''
  eventLogs.value = []
  sending.value = true
  const controller = new AbortController()
  currentController.value = controller

  try {
    if (typeof props.beforeSend === 'function') {
      const ready = await props.beforeSend()
      if (ready === false) {
        sending.value = false
        currentController.value = null
        return
      }
    }

    const prompt = typeof props.buildPrompt === 'function'
      ? await props.buildPrompt()
      : props.prompt

    if (!String(prompt || '').trim()) {
      error.value = '没有可发送的提示词。'
      appendLog(`错误：${error.value}`)
      return
    }

    await streamPromptToCodexSession(selectedSessionId.value, {
      prompt,
    }, {
      signal: controller.signal,
      onEvent: handleStreamEvent,
    })

    if (!responseMessage.value) {
      responseMessage.value = '已发送到 Codex session，但没有拿到最终文本。'
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      appendLog('已停止本次发送。')
    } else {
      error.value = err.message
      appendLog(`错误：${error.value}`)
    }
  } finally {
    sending.value = false
    currentController.value = null
  }
}

function stopSending() {
  currentController.value?.abort()
}

watch(selectedSessionId, (value) => {
  if (!value) {
    window.localStorage.removeItem(props.storageKey)
    return
  }
  window.localStorage.setItem(props.storageKey, value)
})

onMounted(loadSessions)
</script>

<template>
  <section class="dashed-panel p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
          <Bot class="h-4 w-4" />
          <span>发送到 Codex</span>
        </div>
        <p class="mt-1 text-xs text-stone-500 dark:text-stone-400">{{ helperText }}</p>
      </div>
      <button
        type="button"
        class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
        :disabled="loading || sending"
        @click="loadSessions"
      >
        <RefreshCw :class="loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'" />
        <span>刷新 session</span>
      </button>
    </div>

    <div class="mt-4 flex flex-col gap-3">
      <label class="text-xs text-stone-500 dark:text-stone-400">
        <span>选择 session</span>
        <select
          v-model="selectedSessionId"
          class="mt-2 w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-400"
          :disabled="loading || sending || !hasSessions"
        >
          <option value="" disabled>{{ hasSessions ? '请选择一个 Codex session' : '暂无可用 session' }}</option>
          <option v-for="session in sessions" :key="session.id" :value="session.id">
            {{ normalizeSessionOption(session) }}
          </option>
        </select>
      </label>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
          :disabled="loading || sending || !selectedSessionId || !hasPrompt"
          @click="handleSend"
        >
          <LoaderCircle v-if="sending" class="h-4 w-4 animate-spin" />
          <SendHorizontal v-else class="h-4 w-4" />
          <span>{{ sending ? '发送中...' : '发送到当前 session' }}</span>
        </button>
        <button
          v-if="sending"
          type="button"
          class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
          @click="stopSending"
        >
          <Square class="h-4 w-4" />
          <span>停止</span>
        </button>
        <span v-if="selectedSession" class="text-xs text-stone-500 dark:text-stone-400">
          当前：{{ selectedSession.displayName }} · {{ selectedSession.shortId }}
        </span>
      </div>

      <p v-if="error" class="inline-flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
        <CircleAlert class="h-4 w-4" />
        <span>{{ error }}</span>
      </p>

      <div v-if="responseMessage" class="rounded-sm border border-dashed border-emerald-300 bg-emerald-50 px-4 py-3 text-sm leading-7 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
        <div class="mb-1 text-xs uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">Codex 返回</div>
        <div class="whitespace-pre-wrap">{{ responseMessage }}</div>
      </div>

      <div v-if="eventLogs.length" class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-4 py-3 dark:border-stone-700 dark:bg-stone-950">
        <div class="mb-2 text-xs uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400">执行过程</div>
        <div class="max-h-64 space-y-2 overflow-y-auto text-xs leading-6 text-stone-700 dark:text-stone-300">
          <p v-for="(line, index) in eventLogs" :key="`${index}-${line}`">{{ line }}</p>
        </div>
      </div>
    </div>
  </section>
</template>
