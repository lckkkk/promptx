<script setup>
import { computed, defineAsyncComponent, ref, watch } from 'vue'
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleStop,
  FileDiff,
  Image as ImageIcon,
  LoaderCircle,
  PencilLine,
} from 'lucide-vue-next'
import CodexSessionSelect from './CodexSessionSelect.vue'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'
import { useI18n } from '../composables/useI18n.js'
import { useCodexSessionPanel } from '../composables/useCodexSessionPanel.js'
import { useCodexTranscriptCollapse } from '../composables/useCodexTranscriptCollapse.js'
import { renderCodexMarkdown } from '../lib/codexMarkdown.js'

const CodexSessionManagerDialog = defineAsyncComponent(() => import('./CodexSessionManagerDialog.vue'))

const emit = defineEmits(['project-created', 'selected-session-change', 'sending-change', 'open-diff', 'toast'])

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
  taskRunning: {
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
  handleTranscriptTouchEnd,
  handleTranscriptTouchMove,
  handleTranscriptTouchStart,
  handleUpdateSession,
  helperText,
  loadTurnEvents,
  loading,
  managerBusy,
  openManager,
  refreshSessionsForSelection,
  selectedSessionId,
  sending,
  stopping,
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

const COLLAPSED_PREVIEW_CLASS = 'max-h-40 overflow-hidden'
const renderedResponseCache = new Map()
const previewPromptImageUrl = ref('')
const { t } = useI18n()

function shouldHideSystemEvent(item = {}) {
  const title = String(item?.title || '').trim()
  if (!title) {
    return false
  }

  return [
    /^已连接项目：/,
    /^工作目录：/,
    /^项目会话已更新$/,
    /^Codex 会话已创建$/,
    /^Claude Code 会话已创建$/,
    /^OpenCode 会话已创建$/,
    /^线程 ID:/,
    /^Thread ID:/,
    /^Connected project:/,
    /^Working directory:/,
    /^Project session updated$/,
    / session created$/,
  ].some((pattern) => pattern.test(title))
}

const {
  canCollapsePrompt,
  canCollapseResponse,
  getTurnEventCollapseKey,
  getTurnEventCount,
  hasTurnEventHistory,
  isPromptCollapsed,
  isResponseCollapsed,
  isTurnEventsCollapsed,
  togglePrompt,
  toggleResponse,
  toggleTurnEvents,
} = useCodexTranscriptCollapse({
  turns,
  loadTurnEvents,
})

function getResponseCacheKey(turn) {
  return String(turn?.runId || turn?.id || '').trim()
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

function getVisibleTurnEvents(turn) {
  const events = Array.isArray(turn?.events) ? turn.events : []
  const filtered = events.filter((item) => !shouldHideSystemEvent(item))
  return filtered.length ? filtered : events
}

function getTurnVisibleEventCount(turn) {
  if (!turn?.eventsLoaded) {
    return getTurnEventCount(turn)
  }

  return getTurnEventCount(turn, getVisibleTurnEvents(turn))
}

function shouldShowEventToggle(turn) {
  return hasTurnEventHistory(turn)
}

function shouldShowEventLoading(turn) {
  return Boolean(turn?.eventsLoading)
}

function shouldShowLoadedEvents(turn) {
  return Boolean(turn?.eventsLoaded) && getVisibleTurnEvents(turn).length > 0 && !isTurnEventsCollapsed(turn)
}

function shouldShowCollapsedEventHint(turn) {
  return hasTurnEventHistory(turn) && isTurnEventsCollapsed(turn)
}

function shouldShowDeferredEventHint(turn) {
  return hasTurnEventHistory(turn) && !turn?.eventsLoaded && !turn?.eventsLoading
}

watch(
  turns,
  (nextTurns) => {
    const validResponseCacheKeys = new Set((nextTurns || []).map((turn) => getResponseCacheKey(turn)).filter(Boolean))
    for (const key of renderedResponseCache.keys()) {
      if (!validResponseCacheKeys.has(key)) {
        renderedResponseCache.delete(key)
      }
    }
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
      @project-created="emit('project-created', $event)"
      @select-session="handleSelectSession"
    />

    <div class="workbench-panel-header theme-divider theme-muted-panel border-b p-3">
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <div class="min-w-0 flex-1" :title="helperText || ''">
            <CodexSessionSelect
              v-model="selectedSessionId"
              :sessions="sortedSessions"
              :loading="loading"
              :disabled="sending || managerBusy || sessionSelectionLocked"
              @refresh-intent="refreshSessionsForSelection"
            />
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            <button
              v-if="diffSupported"
              type="button"
              class="tool-button inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-2 text-xs sm:gap-2 sm:px-3"
              :disabled="!taskSlug"
              @click="openTaskDiff"
            >
              <FileDiff class="h-4 w-4" />
              <span class="sm:hidden">代码</span>
              <span class="hidden sm:inline">{{ t('sessionPanel.diff') }}</span>
            </button>
            <button
              type="button"
              class="tool-button inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-2 text-xs sm:gap-2 sm:px-3"
              :disabled="managerBusy"
              @click="openManager"
            >
              <PencilLine class="h-4 w-4" />
              <span class="sm:hidden">项目</span>
              <span class="hidden sm:inline">{{ t('sessionPanel.manageProjects') }}</span>
            </button>
          </div>
        </div>

        <p v-if="sessionError" class="theme-danger-text inline-flex items-center gap-2 text-sm">
          <CircleAlert class="h-4 w-4" />
          <span>{{ sessionError }}</span>
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <div
        ref="transcriptRef"
        class="h-full space-y-4 overflow-y-auto px-4 py-4"
        @scroll="handleTranscriptScroll"
        @touchstart.passive="handleTranscriptTouchStart"
        @touchmove.passive="handleTranscriptTouchMove"
        @touchend.passive="handleTranscriptTouchEnd"
        @touchcancel.passive="handleTranscriptTouchEnd"
      >
        <div
          v-if="!turns.length"
          class="theme-empty-state px-4 py-6 text-sm"
        >
          {{ t('sessionPanel.empty') }}
        </div>

        <div v-for="turn in turns" :key="turn.id" class="space-y-3">
          <div class="flex justify-end">
            <div class="transcript-card transcript-card--prompt min-w-0 w-full max-w-[92%] rounded-sm bg-[var(--theme-promptBg)] px-4 py-3 text-sm text-[var(--theme-promptText)]">
              <div class="flex items-center justify-between gap-3 text-xs opacity-75">
                <span>{{ t('sessionPanel.promptTitle') }}</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="canCollapsePrompt(turn)"
                    type="button"
                    class="transcript-card__toggle inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
                    @click="togglePrompt(turn)"
                  >
                    <ChevronDown v-if="isPromptCollapsed(turn)" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span>{{ isPromptCollapsed(turn) ? t('sessionPanel.expand') : t('sessionPanel.collapse') }}</span>
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
                      class="transcript-card__media overflow-hidden rounded-sm border border-dashed border-[var(--theme-promptBorder)]/70 bg-white/40"
                    >
                      <div class="flex items-center gap-2 border-b border-dashed border-[var(--theme-promptBorder)]/60 px-3 py-2 text-xs opacity-80">
                        <ImageIcon class="h-3.5 w-3.5" />
                        <span>{{ t('sessionPanel.promptImage') }}</span>
                      </div>
                      <div class="px-3 py-3">
                        <button
                          type="button"
                          class="inline-flex cursor-zoom-in justify-center"
                          @click="openPromptImage(item.content)"
                        >
                          <img
                            :src="item.content"
                            :alt="t('sessionPanel.promptImageAlt')"
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
            <div class="transcript-card transcript-card--process min-w-0 w-full max-w-[94%] rounded-sm px-4 py-3" :class="getProcessCardClass(turn)">
              <div class="flex items-center justify-between gap-3 text-xs">
                <span>{{ t('sessionPanel.processTitle') }}</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="shouldShowEventToggle(turn)"
                    type="button"
                    class="transcript-card__toggle inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
                    :disabled="turn.eventsLoading"
                    @click="toggleTurnEvents(turn)"
                  >
                    <LoaderCircle v-if="shouldShowEventLoading(turn)" class="h-3 w-3 animate-spin" />
                    <ChevronDown v-else-if="isTurnEventsCollapsed(turn)" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span>{{ turn.eventsLoading ? t('sessionPanel.loading') : isTurnEventsCollapsed(turn) ? `${t('sessionPanel.expand')} (${getTurnVisibleEventCount(turn)})` : t('sessionPanel.collapse') }}</span>
                  </button>
                  <span>{{ getProcessStatus(turn) }}</span>
                </div>
              </div>
              <div v-if="shouldShowEventLoading(turn)" class="transcript-card__subtle mt-3 rounded-sm bg-white/10 px-3 py-2 text-xs text-current/70">
                {{ t('sessionPanel.loadingEvents') }}
              </div>
              <div v-else-if="shouldShowLoadedEvents(turn)" class="mt-3 space-y-3">
                <div
                  v-for="item in getVisibleTurnEvents(turn)"
                  :key="item.id"
                  class="transcript-event-card rounded-sm px-3 py-2"
                  :class="{
                    'bg-[var(--theme-appPanelStrong)]': item.kind === 'info' || item.kind === 'command',
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
                v-else-if="shouldShowCollapsedEventHint(turn) || shouldShowDeferredEventHint(turn)"
                class="transcript-card__subtle mt-3 rounded-sm bg-white/10 px-3 py-2 text-xs text-current/70"
              >
                {{ turn.eventsLoaded
                  ? t('sessionPanel.hiddenEventsLoaded', { count: getTurnVisibleEventCount(turn) })
                  : t('sessionPanel.hiddenEventsLoadLater', { count: getTurnVisibleEventCount(turn) }) }}
              </div>
              <p v-else class="mt-3 text-xs text-current/80">{{ ['queued', 'starting', 'running', 'stopping'].includes(turn.status) ? t('sessionPanel.waitingEvents', { agent: getTurnAgentLabel(turn) }) : t('sessionPanel.noEvents') }}</p>
              <div
                v-if="hasTurnSummary(turn)"
                class="transcript-card__subtle mt-3 rounded-sm bg-white/15 px-3 py-2 text-xs text-current/80"
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
                    class="transcript-card__pill inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1"
                  >
                    <span class="opacity-75">{{ item.label }}</span>
                    <span class="font-medium">{{ item.value }}</span>
                  </span>
                </div>
                  </div>
                  <button
                    v-if="diffSupported && turn.runId"
                    type="button"
                    class="transcript-card__toggle shrink-0 inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
                    @click="openTurnDiff(turn)"
                  >
                    <FileDiff class="h-3 w-3" />
                    <span>{{ t('sessionPanel.view') }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-if="shouldShowResponse(turn)" class="flex justify-start">
            <div
              class="transcript-card transcript-card--response min-w-0 w-full max-w-[92%] rounded-sm px-4 py-3 text-sm leading-7"
              :class="turn.errorMessage
                ? 'bg-[var(--theme-dangerSoft)] text-[var(--theme-dangerText)]'
                : 'bg-[var(--theme-responseBg)] text-[var(--theme-responseText)]'"
            >
              <div class="flex items-center justify-between gap-3 text-xs text-current/80">
                <span>{{ turn.errorMessage ? t('sessionPanel.errorSuffix', { agent: getTurnAgentLabel(turn) }) : t('sessionPanel.responseSuffix', { agent: getTurnAgentLabel(turn) }) }}</span>
                <button
                  v-if="canCollapseResponse(turn)"
                  type="button"
                  class="transcript-card__toggle inline-flex items-center gap-1 rounded-sm border border-dashed border-current/30 px-2 py-1 text-[11px] transition hover:bg-white/15"
                  @click="toggleResponse(turn)"
                >
                  <ChevronDown v-if="isResponseCollapsed(turn)" class="h-3 w-3" />
                  <ChevronUp v-else class="h-3 w-3" />
                  <span>{{ isResponseCollapsed(turn) ? t('sessionPanel.expand') : t('sessionPanel.collapse') }}</span>
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

      <div class="pointer-events-none absolute bottom-1 right-1 z-10 flex flex-col items-end gap-1.5 sm:bottom-3 sm:right-3">
        <button
          v-if="hasNewerMessages"
          type="button"
          class="tool-button pointer-events-auto inline-flex items-center gap-1.5 border-[var(--theme-borderStrong)] bg-[var(--theme-appOverlay)] px-2.5 py-1.5 text-[11px] shadow-sm backdrop-blur"
          @click="scrollToBottom"
        >
          <ArrowDown class="h-3.5 w-3.5" />
          <span>{{ t('sessionPanel.jumpToLatest') }}</span>
        </button>
        <button
          v-if="sending"
          type="button"
          class="tool-button tool-button-warning-subtle pointer-events-auto inline-flex items-center gap-1.5 border-[var(--theme-borderStrong)] bg-[var(--theme-appOverlay)] px-2.5 py-1.5 text-[11px] shadow-sm backdrop-blur"
          :disabled="stopping"
          @click="stopSending"
        >
          <LoaderCircle v-if="stopping" class="h-3.5 w-3.5 animate-spin" />
          <CircleStop v-else class="h-3.5 w-3.5" />
          <span>{{ stopping ? t('sessionPanel.stopping') : t('sessionPanel.stop') }}</span>
          <span v-if="!stopping" class="task-loading-dots" aria-hidden="true">
            <span class="task-loading-dots__dot"></span>
            <span class="task-loading-dots__dot"></span>
            <span class="task-loading-dots__dot"></span>
          </span>
        </button>
      </div>
    </div>

    <ImagePreviewOverlay
      v-model="previewPromptImageUrl"
      :images="promptPreviewImages"
    />
  </section>
</template>
