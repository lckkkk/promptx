<script setup>
import { computed, ref, watch } from 'vue'
import {
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileDiff,
  LoaderCircle,
  PencilLine,
  Square,
} from 'lucide-vue-next'
import CodexSessionManagerDialog from './CodexSessionManagerDialog.vue'
import CodexSessionSelect from './CodexSessionSelect.vue'
import { useCodexSessionPanel } from '../composables/useCodexSessionPanel.js'

const emit = defineEmits(['selected-session-change', 'sending-change', 'open-diff'])

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
  afterSend: {
    type: Function,
    default: null,
  },
  taskSlug: {
    type: String,
    default: '',
  },
  selectedSessionId: {
    type: String,
    default: '',
  },
  active: {
    type: Boolean,
    default: false,
  },
  sessionSelectionLocked: {
    type: Boolean,
    default: false,
  },
  sessionSelectionLockReason: {
    type: String,
    default: '',
  },
})

const {
  closeManager,
  formatTurnTime,
  getProcessCardClass,
  getProcessStatus,
  getDisplayTurnSummaryItems,
  getTurnSummaryDetail,
  getTurnSummaryStatus,
  handleCreateSession,
  handleDeleteSession,
  handleSelectSession,
  handleSend,
  handleTranscriptScroll,
  handleUpdateSession,
  helperText,
  loading,
  managerBusy,
  openManager,
  refreshSessionsForSelection,
  selectedSessionId,
  sending,
  hasTurnSummary,
  hasNewerMessages,
  sessionError,
  shouldShowResponse,
  showManager,
  sortedSessions,
  stopSending,
  transcriptRef,
  turns,
  workspaces,
  workingLabel,
  sessions,
  loadSessions,
  scrollToBottom,
} = useCodexSessionPanel(props, emit)

const collapsedTurnMap = ref({})
const collapsedPromptMap = ref({})
const collapsedResponseMap = ref({})
const PROMPT_COLLAPSE_MAX_LINES = 8
const PROMPT_COLLAPSE_MAX_CHARS = 320
const RESPONSE_COLLAPSE_MAX_LINES = 10
const RESPONSE_COLLAPSE_MAX_CHARS = 400
const COLLAPSED_PREVIEW_CLASS = 'max-h-40 overflow-hidden'
const latestTurnId = computed(() => turns.value.at(-1)?.id || '')

const sessionSelectionHelperText = computed(() => {
  if (props.sessionSelectionLocked) {
    return props.sessionSelectionLockReason || '该任务已有会话历史，不能再切换会话；如需使用新会话，请新建任务。'
  }

  return helperText.value || ''
})

function exceedsCollapseThreshold(content, maxLines, maxChars) {
  const text = String(content || '').trimEnd()
  if (!text) {
    return false
  }

  const lines = text.split(/\r?\n/).length
  return lines > maxLines || text.length > maxChars
}

function shouldCollapseTurn(turn) {
  return turn?.status !== 'running' && (turn?.events?.length || 0) > 3
}

function shouldCollapsePrompt(turn) {
  return turn?.status !== 'running'
    && turn?.id !== latestTurnId.value
    && canCollapsePrompt(turn)
}

function shouldCollapseResponse(turn) {
  return !turn?.errorMessage
    && turn?.id !== latestTurnId.value
    && canCollapseResponse(turn)
}

function canCollapsePrompt(turn) {
  return exceedsCollapseThreshold(turn?.prompt, PROMPT_COLLAPSE_MAX_LINES, PROMPT_COLLAPSE_MAX_CHARS)
}

function getTurnResponseContent(turn) {
  return String(turn?.errorMessage || turn?.responseMessage || '')
}

function canCollapseResponse(turn) {
  return exceedsCollapseThreshold(getTurnResponseContent(turn), RESPONSE_COLLAPSE_MAX_LINES, RESPONSE_COLLAPSE_MAX_CHARS)
}

function syncCollapsedTurns(nextTurns = []) {
  const validIds = new Set((nextTurns || []).map((turn) => turn.id).filter(Boolean))

  collapsedTurnMap.value = Object.fromEntries(
    Object.entries(collapsedTurnMap.value).filter(([id]) => validIds.has(id))
  )
  collapsedPromptMap.value = Object.fromEntries(
    Object.entries(collapsedPromptMap.value).filter(([id]) => validIds.has(id))
  )
  collapsedResponseMap.value = Object.fromEntries(
    Object.entries(collapsedResponseMap.value).filter(([id]) => validIds.has(id))
  )
}

function isTurnEventsCollapsed(turn) {
  if (!turn?.id) {
    return false
  }

  if (Object.prototype.hasOwnProperty.call(collapsedTurnMap.value, turn.id)) {
    return Boolean(collapsedTurnMap.value[turn.id])
  }

  return shouldCollapseTurn(turn)
}

function toggleTurnEvents(turn) {
  if (!turn?.id) {
    return
  }

  collapsedTurnMap.value = {
    ...collapsedTurnMap.value,
    [turn.id]: !isTurnEventsCollapsed(turn),
  }
}

function isPromptCollapsed(turn) {
  if (!turn?.id) {
    return false
  }

  if (Object.prototype.hasOwnProperty.call(collapsedPromptMap.value, turn.id)) {
    return Boolean(collapsedPromptMap.value[turn.id])
  }

  return shouldCollapsePrompt(turn)
}

function togglePrompt(turn) {
  if (!turn?.id || !canCollapsePrompt(turn)) {
    return
  }

  collapsedPromptMap.value = {
    ...collapsedPromptMap.value,
    [turn.id]: !isPromptCollapsed(turn),
  }
}

function isResponseCollapsed(turn) {
  if (!turn?.id) {
    return false
  }

  if (Object.prototype.hasOwnProperty.call(collapsedResponseMap.value, turn.id)) {
    return Boolean(collapsedResponseMap.value[turn.id])
  }

  return shouldCollapseResponse(turn)
}

function toggleResponse(turn) {
  if (!turn?.id || !canCollapseResponse(turn)) {
    return
  }

  collapsedResponseMap.value = {
    ...collapsedResponseMap.value,
    [turn.id]: !isResponseCollapsed(turn),
  }
}

function openTurnDiff(turn) {
  if (!turn?.runId) {
    return
  }

  emit('open-diff', {
    scope: 'run',
    runId: turn.runId,
  })
}

function openTaskDiff() {
  emit('open-diff', {
    scope: 'workspace',
    runId: '',
  })
}

watch(
  turns,
  (nextTurns) => {
    syncCollapsedTurns(nextTurns)
  },
  { immediate: true, deep: true }
)

defineExpose({
  send: handleSend,
  scrollToBottom,
  stop: stopSending,
})
</script>

<template>
  <section class="panel relative flex h-full min-h-0 flex-col overflow-hidden">
    <CodexSessionManagerDialog
      :open="showManager"
      :sessions="sessions"
      :workspaces="workspaces"
      :selected-session-id="selectedSessionId"
      :selection-locked="sessionSelectionLocked"
      :selection-lock-reason="sessionSelectionLockReason"
      :loading="loading"
      :sending="sending"
      :on-refresh="loadSessions"
      :on-create="handleCreateSession"
      :on-update="handleUpdateSession"
      :on-delete="handleDeleteSession"
      @close="closeManager"
      @select-session="handleSelectSession"
    />

    <div class="border-b border-stone-300 bg-stone-50/80 p-3 dark:border-[#342d29] dark:bg-[#221d1a]">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 shrink-0">
            <div class="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
              <Bot class="h-4 w-4" />
              <span>会话</span>
            </div>
            <p v-if="helperText" class="mt-1 text-xs text-stone-500 dark:text-stone-400">{{ helperText }}</p>
          </div>

          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs dark:border-[#4c423c] dark:bg-[#2b2521] dark:hover:bg-[#342d28]"
              :disabled="!taskSlug"
              @click="openTaskDiff"
            >
              <FileDiff class="h-4 w-4" />
              <span>代码变更</span>
            </button>
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs dark:border-[#5a4d45] dark:bg-[#342d28] dark:text-stone-100 dark:hover:bg-[#3d3530]"
              :disabled="sending || managerBusy"
              @click="openManager"
            >
              <PencilLine class="h-4 w-4" />
              <span>管理会话</span>
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div class="min-w-0 flex-1">
            <CodexSessionSelect
              v-model="selectedSessionId"
              :sessions="sortedSessions"
              :loading="loading"
              :disabled="sending || managerBusy || sessionSelectionLocked"
              @refresh-intent="refreshSessionsForSelection"
            />
          </div>

        </div>

        <p
          v-if="sessionSelectionLocked"
          class="text-xs text-stone-500 dark:text-stone-400"
        >
          {{ sessionSelectionHelperText }}
        </p>

        <p v-if="sessionError" class="inline-flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <CircleAlert class="h-4 w-4" />
          <span>{{ sessionError }}</span>
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <div ref="transcriptRef" class="h-full space-y-4 overflow-y-auto px-4 py-4" @scroll="handleTranscriptScroll">
        <div
          v-if="!turns.length"
          class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-sm text-stone-500 dark:border-[#544941] dark:bg-[#2d2723] dark:text-stone-400"
        >
          这里会显示会话执行过程和 Codex 回复。
        </div>

        <div v-for="turn in turns" :key="turn.id" class="space-y-3">
          <div class="flex justify-end">
            <div class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed border-amber-400 bg-amber-100/85 px-4 py-3 text-sm text-amber-950 dark:border-[#9a7650] dark:bg-[#4a3727] dark:text-[#fff3df]">
              <div class="flex items-center justify-between gap-3 text-xs text-amber-800/70 dark:text-amber-100/70">
                <span>本轮提示词</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="canCollapsePrompt(turn)"
                    type="button"
                    class="inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/20 dark:hover:bg-black/10"
                    @click="togglePrompt(turn)"
                  >
                    <ChevronDown v-if="isPromptCollapsed(turn)" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span>{{ isPromptCollapsed(turn) ? '展开' : '收起' }}</span>
                  </button>
                  <span>{{ formatTurnTime(turn.startedAt) }}</span>
                </div>
              </div>
              <div class="relative mt-2">
                <pre
                  class="whitespace-pre-wrap break-all font-sans leading-7"
                  :class="canCollapsePrompt(turn) && isPromptCollapsed(turn) ? COLLAPSED_PREVIEW_CLASS : ''"
                >{{ turn.prompt }}</pre>
                <div
                  v-if="canCollapsePrompt(turn) && isPromptCollapsed(turn)"
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-amber-100 via-amber-100 to-amber-100/15 dark:from-[#4a3727] dark:via-[#4a3727] dark:to-[#4a3727]/15"
                />
              </div>
            </div>
          </div>

          <div class="flex justify-start">
            <div class="min-w-0 w-full max-w-[94%] rounded-sm border border-dashed px-4 py-3" :class="getProcessCardClass(turn)">
              <div class="flex items-center justify-between gap-3 text-xs">
                <span>执行过程</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="turn.events.length"
                    type="button"
                    class="inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/20 dark:hover:bg-black/10"
                    @click="toggleTurnEvents(turn)"
                  >
                    <ChevronDown v-if="isTurnEventsCollapsed(turn)" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span>{{ isTurnEventsCollapsed(turn) ? `展开 (${turn.events.length})` : '收起' }}</span>
                  </button>
                  <span>{{ getProcessStatus(turn) }}</span>
                </div>
              </div>
              <div v-if="turn.events.length && !isTurnEventsCollapsed(turn)" class="mt-3 space-y-3">
                <div
                  v-for="item in turn.events"
                  :key="item.id"
                  class="rounded-sm border border-dashed px-3 py-2"
                  :class="{
                    'border-stone-200/70 bg-white/45 dark:border-[#403832] dark:bg-[#24201d]': item.kind === 'info' || item.kind === 'command',
                    'border-amber-200/70 bg-amber-50/45 dark:border-[#6f5d46] dark:bg-[#31271d]': item.kind === 'todo',
                    'border-emerald-200/70 bg-emerald-50/45 dark:border-[#536a59] dark:bg-[#222d25]': item.kind === 'result',
                    'border-red-200/70 bg-red-50/45 dark:border-[#6f4a45] dark:bg-[#32211f]': item.kind === 'error',
                  }"
                >
                  <div class="font-medium">{{ item.title }}</div>
                  <pre v-if="item.detail" class="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{{ item.detail }}</pre>
                </div>
              </div>
              <div
                v-else-if="turn.events.length"
                class="mt-3 rounded-sm border border-dashed border-current/15 bg-white/10 px-3 py-2 text-xs text-current/70 dark:bg-black/5"
              >
                已折叠 {{ turn.events.length }} 条过程日志
              </div>
              <p v-else class="mt-3 text-xs text-current/80">正在等待 Codex 返回事件...</p>
              <div
                v-if="hasTurnSummary(turn)"
                class="mt-3 rounded-sm border border-dashed border-current/15 bg-white/15 px-3 py-2 text-xs text-current/80 dark:bg-black/5"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0 flex-1">
                <div v-if="getTurnSummaryStatus(turn)" class="leading-5">
                  {{ getTurnSummaryStatus(turn) }}
                </div>
                <div v-if="getTurnSummaryDetail(turn)" class="mt-1 break-all leading-5 opacity-75">
                  {{ getTurnSummaryDetail(turn) }}
                </div>
                <div v-if="getDisplayTurnSummaryItems(turn).length" class="mt-2 flex flex-wrap gap-2">
                  <span
                    v-for="item in getDisplayTurnSummaryItems(turn)"
                    :key="item.key"
                    class="inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1"
                  >
                    <span class="opacity-75">{{ item.label }}</span>
                    <span class="font-medium">{{ item.value }}</span>
                  </span>
                </div>
                  </div>
                  <button
                    v-if="turn.runId"
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/20 dark:hover:bg-black/10"
                    @click="openTurnDiff(turn)"
                  >
                    <FileDiff class="h-3 w-3" />
                    <span>查看</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-if="shouldShowResponse(turn)" class="flex justify-start">
            <div
              class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed px-4 py-3 text-sm leading-7"
              :class="turn.errorMessage
                ? 'border-red-300 bg-red-50 text-red-900 dark:border-[#7b4f4a] dark:bg-[#372321] dark:text-[#f0dfdc]'
                : 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-[#6b8a72] dark:bg-[#243228] dark:text-[#eef7ef]'"
            >
              <div class="flex items-center justify-between gap-3 text-xs text-current/80">
                <span>{{ turn.errorMessage ? 'Codex 错误' : 'Codex 回复' }}</span>
                <button
                  v-if="canCollapseResponse(turn)"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/20 dark:hover:bg-black/10"
                  @click="toggleResponse(turn)"
                >
                  <ChevronDown v-if="isResponseCollapsed(turn)" class="h-3 w-3" />
                  <ChevronUp v-else class="h-3 w-3" />
                  <span>{{ isResponseCollapsed(turn) ? '展开' : '收起' }}</span>
                </button>
              </div>
              <div class="relative mt-2">
                <div
                  class="whitespace-pre-wrap break-all"
                  :class="canCollapseResponse(turn) && isResponseCollapsed(turn) ? COLLAPSED_PREVIEW_CLASS : ''"
                >{{ turn.errorMessage || turn.responseMessage }}</div>
                <div
                  v-if="canCollapseResponse(turn) && isResponseCollapsed(turn)"
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t"
                  :class="turn.errorMessage
                    ? 'from-red-50 via-red-50 to-red-50/15 dark:from-[#372321] dark:via-[#372321] dark:to-[#372321]/15'
                    : 'from-emerald-50 via-emerald-50 to-emerald-50/15 dark:from-[#243228] dark:via-[#243228] dark:to-[#243228]/15'"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        v-if="hasNewerMessages"
        type="button"
        class="tool-button absolute right-4 z-10 inline-flex items-center gap-2 border-stone-400 bg-stone-100/95 px-3 py-2 text-xs shadow-sm backdrop-blur dark:border-[#5a4d45] dark:bg-[#342d28]/95 dark:text-stone-100"
        :class="sending ? 'bottom-20' : 'bottom-4'"
        @click="scrollToBottom"
      >
        <ArrowDown class="h-4 w-4" />
        <span>有新消息，跳到底部</span>
      </button>
    </div>

    <div
      v-if="sending"
      class="flex shrink-0 items-center justify-between gap-3 border-t border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-[#7f6949] dark:bg-[#392f20] dark:text-[#e5ce9a]"
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
