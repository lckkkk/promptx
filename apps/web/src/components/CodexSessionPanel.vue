<script setup>
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import {
  ArrowDown,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  FileDiff,
  Image as ImageIcon,
  LoaderCircle,
  PencilLine,
  Square,
} from 'lucide-vue-next'
import CodexSessionSelect from './CodexSessionSelect.vue'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'
import { useCodexSessionPanel } from '../composables/useCodexSessionPanel.js'
import { renderCodexMarkdown } from '../lib/codexMarkdown.js'

const CodexSessionManagerDialog = defineAsyncComponent(() => import('./CodexSessionManagerDialog.vue'))

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
  buildPromptBlocks: {
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
  diffSupported: {
    type: Boolean,
    default: false,
  },
})

const {
  closeManager,
  formatTurnTime,
  getProcessCardClass,
  getProcessStatus,
  getTurnAgentLabel,
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
  loadTurnEvents,
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
const renderedResponseCache = new Map()
const previewPromptImageUrl = ref('')

function exceedsCollapseThreshold(content, maxLines, maxChars) {
  const text = String(content || '').trimEnd()
  if (!text) {
    return false
  }

  const lines = text.split(/\r?\n/).length
  return lines > maxLines || text.length > maxChars
}

function shouldCollapseTurn(turn) {
  return turn?.status !== 'running'
    && !isLatestTurn(turn)
    && getTurnEventCount(turn) > 3
}

function shouldCollapsePrompt(turn) {
  return turn?.status !== 'running'
    && !isLatestTurn(turn)
    && canCollapsePrompt(turn)
}

function shouldCollapseResponse(turn) {
  return !turn?.errorMessage
    && !isLatestTurn(turn)
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

function getResponseCacheKey(turn) {
  return String(turn?.runId || turn?.id || '').trim()
}

function syncCollapsedTurns(nextTurns = []) {
  const validIds = new Set((nextTurns || []).map((turn) => getTurnEventCollapseKey(turn)).filter(Boolean))
  const validResponseCacheKeys = new Set((nextTurns || []).map((turn) => getResponseCacheKey(turn)).filter(Boolean))
  collapsedTurnMap.value = Object.fromEntries(
    Object.entries(collapsedTurnMap.value).filter(([id]) => validIds.has(id))
  )
  collapsedPromptMap.value = Object.fromEntries(
    Object.entries(collapsedPromptMap.value).filter(([id]) => validIds.has(id))
  )
  collapsedResponseMap.value = Object.fromEntries(
    Object.entries(collapsedResponseMap.value).filter(([id]) => validIds.has(id))
  )

  for (const key of renderedResponseCache.keys()) {
    if (!validResponseCacheKeys.has(key)) {
      renderedResponseCache.delete(key)
    }
  }

  const latestTurn = (nextTurns || []).at(-1) || null
  const latestKey = getTurnEventCollapseKey(latestTurn)
  if (latestKey) {
    if (!Object.prototype.hasOwnProperty.call(collapsedTurnMap.value, latestKey)) {
      collapsedTurnMap.value = {
        ...collapsedTurnMap.value,
        [latestKey]: false,
      }
    }
    if (!Object.prototype.hasOwnProperty.call(collapsedPromptMap.value, latestKey)) {
      collapsedPromptMap.value = {
        ...collapsedPromptMap.value,
        [latestKey]: false,
      }
    }
    if (!Object.prototype.hasOwnProperty.call(collapsedResponseMap.value, latestKey)) {
      collapsedResponseMap.value = {
        ...collapsedResponseMap.value,
        [latestKey]: false,
      }
    }
  }
}

function getTurnEventCollapseKey(turn) {
  return String(turn?.runId || turn?.id || '').trim()
}

function isLatestTurn(turn) {
  const key = getTurnEventCollapseKey(turn)
  return Boolean(key) && key === getTurnEventCollapseKey(turns.value.at(-1))
}

function isTurnEventsCollapsed(turn) {
  const key = getTurnEventCollapseKey(turn)
  if (!key) {
    return false
  }

  if (Object.prototype.hasOwnProperty.call(collapsedTurnMap.value, key)) {
    return Boolean(collapsedTurnMap.value[key])
  }

  return shouldCollapseTurn(turn)
}

function getTurnEventCount(turn) {
  return Math.max(
    Math.max(0, Number(turn?.eventCount) || 0),
    Array.isArray(turn?.events) ? turn.events.length : 0
  )
}

function hasTurnEventHistory(turn) {
  return getTurnEventCount(turn) > 0
}

async function toggleTurnEvents(turn) {
  const key = getTurnEventCollapseKey(turn)
  if (!key) {
    return
  }

  const nextCollapsed = !isTurnEventsCollapsed(turn)

  collapsedTurnMap.value = {
    ...collapsedTurnMap.value,
    [key]: nextCollapsed,
  }

  if (!nextCollapsed && hasTurnEventHistory(turn) && !turn.eventsLoaded && !turn.eventsLoading) {
    await loadTurnEvents(turn).catch(() => {})
  }
}

function isPromptCollapsed(turn) {
  const key = getTurnEventCollapseKey(turn)
  if (!key) {
    return false
  }

  if (Object.prototype.hasOwnProperty.call(collapsedPromptMap.value, key)) {
    return Boolean(collapsedPromptMap.value[key])
  }

  return shouldCollapsePrompt(turn)
}

function togglePrompt(turn) {
  const key = getTurnEventCollapseKey(turn)
  if (!key || !canCollapsePrompt(turn)) {
    return
  }

  collapsedPromptMap.value = {
    ...collapsedPromptMap.value,
    [key]: !isPromptCollapsed(turn),
  }
}

function isResponseCollapsed(turn) {
  const key = getTurnEventCollapseKey(turn)
  if (!key) {
    return false
  }

  if (Object.prototype.hasOwnProperty.call(collapsedResponseMap.value, key)) {
    return Boolean(collapsedResponseMap.value[key])
  }

  return shouldCollapseResponse(turn)
}

function toggleResponse(turn) {
  const key = getTurnEventCollapseKey(turn)
  if (!key || !canCollapseResponse(turn)) {
    return
  }

  collapsedResponseMap.value = {
    ...collapsedResponseMap.value,
    [key]: !isResponseCollapsed(turn),
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

function renderResponseBody(turn) {
  if (turn?.errorMessage) {
    return ''
  }

  const responseMessage = String(turn?.responseMessage || '')
  const cacheKey = getResponseCacheKey(turn)
  if (!cacheKey) {
    return renderCodexMarkdown(responseMessage)
  }

  const cached = renderedResponseCache.get(cacheKey)
  if (cached?.source === responseMessage) {
    return cached.html
  }

  const html = renderCodexMarkdown(responseMessage)
  renderedResponseCache.set(cacheKey, {
    source: responseMessage,
    html,
  })
  return html
}

function openPromptImage(url) {
  previewPromptImageUrl.value = String(url || '').trim()
}

const promptPreviewImages = computed(() => (
  turns.value.flatMap((turn) => (Array.isArray(turn?.promptBlocks) ? turn.promptBlocks : [])
    .filter((item) => item?.type === 'image')
    .map((item) => item.content))
))

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
      v-if="showManager"
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

    <div class="theme-divider border-b bg-[var(--theme-appPanelMuted)] p-3">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 shrink-0">
            <div class="theme-heading flex items-center gap-2 text-sm font-medium">
              <Bot class="h-4 w-4" />
              <span>项目</span>
            </div>
            <p v-if="helperText" class="theme-muted-text mt-1 text-xs">{{ helperText }}</p>
          </div>

          <div class="ml-auto flex items-center gap-2">
            <button
              v-if="diffSupported"
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
              :disabled="!taskSlug"
              @click="openTaskDiff"
            >
              <FileDiff class="h-4 w-4" />
              <span>代码变更</span>
            </button>
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
              :disabled="managerBusy"
              @click="openManager"
            >
              <PencilLine class="h-4 w-4" />
              <span>管理项目</span>
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

        <p v-if="sessionError" class="theme-danger-text inline-flex items-center gap-2 text-sm">
          <CircleAlert class="h-4 w-4" />
          <span>{{ sessionError }}</span>
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <div ref="transcriptRef" class="h-full space-y-4 overflow-y-auto px-4 py-4" @scroll="handleTranscriptScroll">
        <div
          v-if="!turns.length"
          class="theme-empty-state px-4 py-6 text-sm"
        >
          这里会显示项目执行过程和模型回复。
        </div>

        <div v-for="turn in turns" :key="turn.id" class="space-y-3">
          <div class="flex justify-end">
            <div class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed border-[var(--theme-promptBorder)] bg-[var(--theme-promptBg)] px-4 py-3 text-sm text-[var(--theme-promptText)]">
              <div class="flex items-center justify-between gap-3 text-xs opacity-75">
                <span>本轮提示词</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="canCollapsePrompt(turn)"
                    type="button"
                    class="inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
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
                <div
                  v-if="Array.isArray(turn.promptBlocks) && turn.promptBlocks.length"
                  class="space-y-3"
                  :class="canCollapsePrompt(turn) && isPromptCollapsed(turn) ? COLLAPSED_PREVIEW_CLASS : ''"
                >
                  <template v-for="(item, itemIndex) in turn.promptBlocks" :key="`${turn.id}-prompt-${itemIndex}`">
                    <pre
                      v-if="item.type === 'text' || item.type === 'imported_text'"
                      class="whitespace-pre-wrap break-all font-sans leading-7"
                    >{{ item.content }}</pre>
                    <div
                      v-else
                      class="overflow-hidden rounded-sm border border-dashed border-[var(--theme-promptBorder)]/70 bg-white/40"
                    >
                      <div class="flex items-center gap-2 border-b border-dashed border-[var(--theme-promptBorder)]/60 px-3 py-2 text-xs opacity-80">
                        <ImageIcon class="h-3.5 w-3.5" />
                        <span>本轮附图</span>
                      </div>
                      <div class="px-3 py-3">
                        <button
                          type="button"
                          class="inline-flex cursor-zoom-in justify-center"
                          @click="openPromptImage(item.content)"
                        >
                          <img
                            :src="item.content"
                            alt="本轮提示词图片"
                            class="max-h-52 w-auto max-w-full rounded-sm object-contain"
                          />
                        </button>
                      </div>
                    </div>
                  </template>
                </div>
                <pre
                  v-else
                  class="whitespace-pre-wrap break-all font-sans leading-7"
                  :class="canCollapsePrompt(turn) && isPromptCollapsed(turn) ? COLLAPSED_PREVIEW_CLASS : ''"
                >{{ turn.prompt }}</pre>
                <div
                  v-if="canCollapsePrompt(turn) && isPromptCollapsed(turn)"
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[var(--theme-promptBg)] via-[var(--theme-promptBg)] to-transparent"
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
                    v-if="hasTurnEventHistory(turn)"
                    type="button"
                    class="inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
                    :disabled="turn.eventsLoading"
                    @click="toggleTurnEvents(turn)"
                  >
                    <LoaderCircle v-if="turn.eventsLoading" class="h-3 w-3 animate-spin" />
                    <ChevronDown v-else-if="isTurnEventsCollapsed(turn)" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span>{{ turn.eventsLoading ? '加载中...' : isTurnEventsCollapsed(turn) ? `展开 (${getTurnEventCount(turn)})` : '收起' }}</span>
                  </button>
                  <span>{{ getProcessStatus(turn) }}</span>
                </div>
              </div>
              <div v-if="turn.eventsLoading && !turn.events.length" class="mt-3 rounded-sm border border-dashed border-current/15 bg-white/10 px-3 py-2 text-xs text-current/70">
                正在加载执行过程...
              </div>
              <div v-else-if="turn.events.length && !isTurnEventsCollapsed(turn)" class="mt-3 space-y-3">
                <div
                  v-for="item in turn.events"
                  :key="item.id"
                  class="rounded-sm border border-dashed px-3 py-2"
                  :class="{
                    'border-[var(--theme-borderMuted)] bg-[var(--theme-appPanelStrong)]': item.kind === 'info' || item.kind === 'command',
                    'theme-status-warning': item.kind === 'todo',
                    'theme-status-success': item.kind === 'result',
                    'theme-status-danger': item.kind === 'error',
                  }"
                >
                  <div class="text-sm font-medium leading-6">{{ item.title }}</div>
                  <pre v-if="item.detail" class="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-5 opacity-85">{{ item.detail }}</pre>
                </div>
              </div>
              <div
                v-else-if="hasTurnEventHistory(turn)"
                class="mt-3 rounded-sm border border-dashed border-current/15 bg-white/10 px-3 py-2 text-xs text-current/70"
              >
                {{ turn.eventsLoaded ? `已折叠 ${getTurnEventCount(turn)} 条过程日志` : `共 ${getTurnEventCount(turn)} 条过程日志，展开后加载` }}
              </div>
              <p v-else class="mt-3 text-xs text-current/80">{{ turn.status === 'running' ? `正在等待 ${getTurnAgentLabel(turn)} 返回事件...` : '本轮没有记录执行过程。' }}</p>
              <div
                v-if="hasTurnSummary(turn)"
                class="mt-3 rounded-sm border border-dashed border-current/15 bg-white/15 px-3 py-2 text-xs text-current/80"
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
                    v-if="diffSupported && turn.runId"
                    type="button"
                    class="shrink-0 inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
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
                ? 'border-[var(--theme-danger)] bg-[var(--theme-dangerSoft)] text-[var(--theme-dangerText)]'
                : 'border-[var(--theme-responseBorder)] bg-[var(--theme-responseBg)] text-[var(--theme-responseText)]'"
            >
              <div class="flex items-center justify-between gap-3 text-xs text-current/80">
                <span>{{ turn.errorMessage ? `${getTurnAgentLabel(turn)} 错误` : `${getTurnAgentLabel(turn)} 回复` }}</span>
                <button
                  v-if="canCollapseResponse(turn)"
                  type="button"
                  class="inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
                  @click="toggleResponse(turn)"
                >
                  <ChevronDown v-if="isResponseCollapsed(turn)" class="h-3 w-3" />
                  <ChevronUp v-else class="h-3 w-3" />
                  <span>{{ isResponseCollapsed(turn) ? '展开' : '收起' }}</span>
                </button>
              </div>
              <div class="relative mt-2">
                <div
                  v-if="turn.errorMessage"
                  :class="canCollapseResponse(turn) && isResponseCollapsed(turn) ? COLLAPSED_PREVIEW_CLASS : ''"
                  class="whitespace-pre-wrap break-all"
                >{{ turn.errorMessage }}</div>
                <div
                  v-else
                  :class="[
                    'prose-like codex-markdown',
                    canCollapseResponse(turn) && isResponseCollapsed(turn) ? COLLAPSED_PREVIEW_CLASS : '',
                  ]"
                  v-html="renderResponseBody(turn)"
                />
                <div
                  v-if="canCollapseResponse(turn) && isResponseCollapsed(turn)"
                  class="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t"
                  :class="turn.errorMessage
                    ? 'from-[var(--theme-dangerSoft)] via-[var(--theme-dangerSoft)] to-transparent'
                    : 'from-[var(--theme-responseBg)] via-[var(--theme-responseBg)] to-transparent'"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      <button
        v-if="hasNewerMessages"
        type="button"
        class="tool-button absolute right-4 z-10 inline-flex items-center gap-2 border-[var(--theme-borderStrong)] bg-[var(--theme-appOverlay)] px-3 py-2 text-xs shadow-sm backdrop-blur"
        :class="sending ? 'bottom-20' : 'bottom-4'"
        @click="scrollToBottom"
      >
        <ArrowDown class="h-4 w-4" />
        <span>有新消息，跳到底部</span>
      </button>
    </div>

    <div
      v-if="sending"
      class="theme-status-warning flex shrink-0 items-center justify-between gap-3 border-t border-dashed px-4 py-3 text-sm"
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

    <ImagePreviewOverlay
      v-model="previewPromptImageUrl"
      :images="promptPreviewImages"
    />
  </section>
</template>
