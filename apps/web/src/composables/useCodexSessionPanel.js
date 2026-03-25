import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  subscribeTaskRunEvents,
  useWorkbenchRealtime,
} from './useWorkbenchRealtime.js'
import { useCodexRunHistory } from './useCodexRunHistory.js'
import { useCodexSessionActions } from './useCodexSessionActions.js'
import { useTranscriptAutoScroll } from './useTranscriptAutoScroll.js'
import { getCurrentLocale, translate } from './useI18n.js'

const SERVER_SYNC_DELAY = 150

export {
  applyRunEventToTurn,
  applyRunEventsPayloadToTurns,
  classifyCodexIssue,
  createTurnFromRun,
  extractCodexEventErrorText,
  findTurnByRunId,
  formatCodexEvent,
  formatCodexIssueMessage,
  formatElapsedDuration,
  getProcessStatus,
  getTurnSummaryDetail,
  getTurnSummaryItems,
  getTurnSummaryStatus,
  hasTurnSummary,
  sortSessions,
  syncTurnStateFromRun,
} from './codexSessionPanelTurns.js'

import {
  formatElapsedDuration,
  getProcessStatus,
  getTurnAgentLabel,
  getTurnSummaryDetail,
  getTurnSummaryItems,
  getTurnSummaryStatus,
  hasTurnSummary,
} from './codexSessionPanelTurns.js'

export function useCodexSessionPanel(props, emit) {
  const realtime = useWorkbenchRealtime()
  const sessions = ref([])
  const workspaces = ref([])
  const loading = ref(false)
  const managerBusy = ref(false)
  const sending = ref(false)
  const stopping = ref(false)
  const sessionError = ref('')
  const turns = ref([])
  const transcriptRef = ref(null)
  const sendingStartedAt = ref(0)
  const sendingElapsedSeconds = ref(0)
  const showManager = ref(false)
  const currentRunningRunId = ref('')
  const hasNewerMessages = ref(false)
  const supportsServerEvents = typeof window !== 'undefined' && typeof window.EventSource !== 'undefined'

  let sendingTimer = null
  let unsubscribeTaskRunEvents = null
  let serverSyncTimer = null
  let pendingServerSync = {
    sessions: false,
    runs: false,
  }

  const selectedSessionId = computed({
    get() {
      return String(props.selectedSessionId || '').trim()
    },
    set(value) {
      emit('selected-session-change', String(value || '').trim())
    },
  })

  const workingLabel = computed(() => (
    stopping.value
      ? translate('sessionPanel.stopping')
      : `${translate('projectManager.running')} (${formatElapsedDuration(sendingElapsedSeconds.value)})`
  ))

  const {
    destroy: destroyTranscriptAutoScroll,
    handleTranscriptScroll,
    resetAutoStickToBottom,
    scheduleScrollToBottom,
    scrollToBottom,
  } = useTranscriptAutoScroll({
    transcriptRef,
    hasNewerMessages,
  })

  function mergeSessionRecord(currentSession, nextSession, options = {}) {
    const { preserveRunning = false } = options
    if (!nextSession?.id) {
      return currentSession || null
    }

    if (!preserveRunning) {
      return nextSession
    }

    return {
      ...nextSession,
      running: Boolean(currentSession?.running),
    }
  }

  function mergeSession(nextSession, options = {}) {
    if (!nextSession?.id) {
      return
    }

    const nextList = [...sessions.value]
    const index = nextList.findIndex((item) => item.id === nextSession.id)
    if (index >= 0) {
      nextList[index] = mergeSessionRecord(nextList[index], nextSession, options)
    } else {
      nextList.unshift(mergeSessionRecord(null, nextSession, options))
    }
    sessions.value = nextList
  }

  const {
    applyCreatedRun,
    applyIncomingRunEvent,
    clearRunPollTimer,
    clearTurns,
    loadTurnEvents,
    markFallbackSessionPollNow,
    refreshRunHistory,
    resetRunHistoryState,
    syncRunningStateFromTurns,
    updatePollingState,
  } = useCodexRunHistory({
    props,
    turns,
    sessions,
    sending,
    sendingStartedAt,
    currentRunningRunId,
    sessionError,
    supportsServerEvents,
    scheduleScrollToBottom,
    resetAutoStickToBottom,
    mergeSessionRecord,
    mergeSession,
    loadSessions: (...args) => loadSessions(...args),
  })

  const {
    closeManager,
    handleCreateSession,
    handleDeleteSession,
    handleSelectSession,
    handleSend,
    handleUpdateSession,
    helperText,
    loadSessions,
    loadSessionResources,
    loadWorkspaces,
    openManager,
    refreshSessionsForSelection,
    sortedSessions,
    stopSending,
  } = useCodexSessionActions({
    props,
    sessions,
    workspaces,
    loading,
    managerBusy,
    sending,
    stopping,
    sessionError,
    showManager,
    selectedSessionId,
    currentRunningRunId,
    supportsServerEvents,
    mergeSession,
    applyCreatedRun,
    refreshRunHistory,
    markFallbackSessionPollNow,
  })

  function clearSendingTimer() {
    if (sendingTimer) {
      window.clearInterval(sendingTimer)
      sendingTimer = null
    }
  }

  function startSendingTimer() {
    clearSendingTimer()
    if (!sendingStartedAt.value) {
      sendingStartedAt.value = Date.now()
    }
    sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
    sendingTimer = window.setInterval(() => {
      sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
    }, 1000)
  }

  function clearServerSyncTimer() {
    if (serverSyncTimer) {
      window.clearTimeout(serverSyncTimer)
      serverSyncTimer = null
    }
  }

  function flushServerSync() {
    clearServerSyncTimer()

    const nextSync = pendingServerSync
    pendingServerSync = {
      sessions: false,
      runs: false,
    }

    if (nextSync.sessions) {
      loadSessions({ force: true }).catch(() => {})
    }

    if (nextSync.runs) {
      refreshRunHistory({ force: true }).catch(() => {})
    }
  }

  function scheduleServerSync(options = {}) {
    if (typeof window === 'undefined') {
      return
    }

    pendingServerSync = {
      sessions: pendingServerSync.sessions || Boolean(options.sessions),
      runs: pendingServerSync.runs || Boolean(options.runs),
    }

    if (serverSyncTimer || (!pendingServerSync.sessions && !pendingServerSync.runs)) {
      return
    }

    serverSyncTimer = window.setTimeout(() => {
      flushServerSync()
    }, SERVER_SYNC_DELAY)
  }

  function getDisplayTurnSummaryItems(turn) {
    return getTurnSummaryItems(turn, {
      currentRunningRunId: currentRunningRunId.value,
      runningElapsedSeconds: sendingElapsedSeconds.value,
      nowMs: Date.now(),
    })
  }

  function formatTurnTime(value = '') {
    if (!value) {
      return ''
    }

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return ''
    }

    return date.toLocaleTimeString(getCurrentLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  function getProcessCardClass(turn) {
    if (turn.status === 'error' || turn.status === 'stop_timeout') {
      return 'theme-process-error'
    }
    if (turn.status === 'interrupted' || turn.status === 'stopped') {
      return 'theme-process-stopped'
    }
    if (turn.status === 'completed') {
      return 'theme-process-completed'
    }
    return 'theme-process-running'
  }

  function shouldShowResponse(turn) {
    return Boolean(turn.responseMessage || turn.errorMessage || turn.status === 'completed')
  }

  watch(
    sending,
    (value) => {
      if (value) {
        if (!sendingStartedAt.value) {
          sendingStartedAt.value = Date.now()
        }
        startSendingTimer()
      } else {
        clearSendingTimer()
        sendingStartedAt.value = 0
        sendingElapsedSeconds.value = 0
        stopping.value = false
      }
      updatePollingState()
      emit('sending-change', value)
    },
    { immediate: true }
  )

  watch(
    () => Boolean(props.taskRunning),
    (taskRunning) => {
      if (!props.active || taskRunning || !sending.value) {
        return
      }

      scheduleServerSync({
        sessions: true,
        runs: true,
      })
    }
  )

  watch(
    () => props.active,
    (active) => {
      if (active) {
        loadSessionResources({
          forceSessions: true,
        }).catch(() => {})
        refreshRunHistory({ force: true, scrollToLatest: true }).catch(() => {})
        return
      }

      clearServerSyncTimer()
      clearRunPollTimer()
    },
    { immediate: true }
  )

  watch(
    () => props.taskSlug,
    () => {
      resetRunHistoryState()
      showManager.value = false
      sessionError.value = ''
      if (props.active) {
        refreshRunHistory({ force: true, scrollToLatest: true }).catch(() => {})
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    clearSendingTimer()
    clearRunPollTimer()
    clearServerSyncTimer()
    destroyTranscriptAutoScroll()
    unsubscribeTaskRunEvents?.()
  })

  watch(
    () => realtime.readyVersion.value,
    () => {
      const currentTaskSlug = String(props.taskSlug || '').trim()
      if (!props.active && !showManager.value) {
        return
      }

      if (showManager.value) {
        loadWorkspaces().catch(() => {})
      }

      scheduleServerSync({
        sessions: true,
        runs: Boolean(currentTaskSlug),
      })
    }
  )

  watch(
    () => realtime.sessionsSyncVersion.value,
    () => {
      if (!props.active && !showManager.value) {
        return
      }

      scheduleServerSync({ sessions: true })
    }
  )

  watch(
    () => realtime.getTaskRunSyncVersion(props.taskSlug),
    () => {
      if (!props.active || !props.taskSlug) {
        return
      }

      scheduleServerSync({
        sessions: true,
        runs: true,
      })
    }
  )

  watch(
    () => String(props.taskSlug || '').trim(),
    (taskSlug) => {
      unsubscribeTaskRunEvents?.()
      unsubscribeTaskRunEvents = null

      if (!taskSlug) {
        return
      }

      unsubscribeTaskRunEvents = subscribeTaskRunEvents(taskSlug, ({ runId, event }) => {
        if (!props.active) {
          return
        }

        const applied = applyIncomingRunEvent(runId, event)
        if (!applied) {
          scheduleServerSync({
            sessions: true,
            runs: true,
          })
        }
      })
    },
    { immediate: true }
  )

  return {
    clearTurns,
    closeManager,
    formatTurnTime,
    getProcessCardClass,
    getProcessStatus,
    getTurnAgentLabel,
    getTurnSummaryDetail,
    getDisplayTurnSummaryItems,
    getTurnSummaryStatus,
    handleCreateSession,
    handleDeleteSession,
    handleSelectSession,
    handleSend,
    handleUpdateSession,
    loadTurnEvents,
    hasTurnSummary,
    helperText,
    loading,
    managerBusy,
    openManager,
    refreshSessionsForSelection,
    selectedSessionId,
    sending,
    stopping,
    sessionError,
    shouldShowResponse,
    showManager,
    sortedSessions,
    stopSending,
    hasNewerMessages,
    transcriptRef,
    turns,
    workspaces,
    workingLabel,
    sessions,
    loadSessions,
    handleTranscriptScroll,
    scrollToBottom,
  }
}
