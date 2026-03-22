import { clearTaskCodexRuns, listCodexRunEvents, listTaskCodexRuns } from '../lib/api.js'
import {
  applyRunEventToTurn,
  applyRunEventsPayloadToTurns,
  createTurnFromRun,
  findTurnByRunId,
  isTurnActiveStatus,
} from './codexSessionPanelTurns.js'

const FALLBACK_RUN_POLL_INTERVAL_MS = 1800
const FALLBACK_SESSION_POLL_INTERVAL_MS = 7200

function createEmptyTurnSummaryState() {
  return {
    commandCount: 0,
    webSearchCount: 0,
    fileChangeCount: 0,
    subAgentCount: 0,
    waitingAgentCount: 0,
    currentActivity: '',
    latestActivity: '',
    latestDetail: '',
  }
}

export function useCodexRunHistory(options = {}) {
  const {
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
    loadSessions,
  } = options

  let turnId = 0
  let logId = 0
  let runsLoadPromise = null
  let runPollTimer = null
  let lastRunFingerprint = ''
  let lastFallbackSessionPollAt = 0
  const runEventLoadPromises = new Map()

  function nextTurnIdValue() {
    turnId += 1
    return turnId
  }

  function nextLogIdValue() {
    logId += 1
    return logId
  }

  function clearRunPollTimer() {
    if (runPollTimer) {
      window.clearInterval(runPollTimer)
      runPollTimer = null
    }
  }

  function markFallbackSessionPollNow() {
    lastFallbackSessionPollAt = Date.now()
  }

  function resetRunHistoryState() {
    runEventLoadPromises.clear()
    turns.value = []
    sending.value = false
    sendingStartedAt.value = 0
    currentRunningRunId.value = ''
    lastRunFingerprint = ''
    turnId = 0
    logId = 0
    resetAutoStickToBottom()
  }

  function syncRunningStateFromTurns() {
    const runningTurn = [...turns.value].reverse().find((turn) => isTurnActiveStatus(turn.status)) || null

    currentRunningRunId.value = runningTurn?.runId || ''
    sending.value = Boolean(runningTurn)
    if (runningTurn?.startedAt) {
      const startedAt = Date.parse(String(runningTurn.startedAt || ''))
      sendingStartedAt.value = Number.isFinite(startedAt) ? startedAt : Date.now()
      return
    }

    sendingStartedAt.value = 0
  }

  function cloneTurnSummaryState(summary = null) {
    return summary ? { ...summary } : createEmptyTurnSummaryState()
  }

  function preserveTurnEventsState(nextTurn, previousTurn = null) {
    if (!previousTurn?.runId || nextTurn.eventsLoaded || !previousTurn.eventsLoaded) {
      if (runEventLoadPromises.has(nextTurn.runId)) {
        nextTurn.eventsLoading = true
      }
      return nextTurn
    }

    const previousCoverage = Math.max(
      Math.max(0, Number(previousTurn.lastEventSeq) || 0),
      Math.max(0, Number(previousTurn.eventCount) || 0),
      Array.isArray(previousTurn.events) ? previousTurn.events.length : 0
    )
    const nextCoverage = Math.max(0, Number(nextTurn.eventCount) || 0)
    if (previousCoverage < nextCoverage) {
      if (runEventLoadPromises.has(nextTurn.runId)) {
        nextTurn.eventsLoading = true
      }
      return nextTurn
    }

    nextTurn.events = Array.isArray(previousTurn.events) ? [...previousTurn.events] : []
    nextTurn.eventCount = Math.max(
      Math.max(0, Number(nextTurn.eventCount) || 0),
      Math.max(0, Number(previousTurn.eventCount) || 0),
      nextTurn.events.length
    )
    nextTurn.eventsLoaded = true
    nextTurn.eventsLoading = runEventLoadPromises.has(nextTurn.runId)
    nextTurn.lastEventSeq = Math.max(0, Number(previousTurn.lastEventSeq) || 0)
    nextTurn.summary = cloneTurnSummaryState(previousTurn.summary)
    return nextTurn
  }

  function setTurnEventsLoading(runId, loading) {
    const activeTurn = findTurnByRunId(turns.value, runId)
    if (!activeTurn) {
      return null
    }

    activeTurn.eventsLoading = Boolean(loading)
    turns.value = [...turns.value]
    return activeTurn
  }

  async function loadTurnEvents(turn, options = {}) {
    const runId = String(turn?.runId || '').trim()
    const { force = false } = options
    if (!runId) {
      return []
    }

    const currentTurn = findTurnByRunId(turns.value, runId) || turn
    if (currentTurn?.eventsLoaded && !force) {
      return currentTurn.events
    }

    if (runEventLoadPromises.has(runId)) {
      return runEventLoadPromises.get(runId)
    }

    setTurnEventsLoading(runId, true)

    const requestPromise = (async () => {
      try {
        const payload = await listCodexRunEvents(runId, {
          limit: 5000,
        })
        const appliedTurn = applyRunEventsPayloadToTurns(
          turns.value,
          runId,
          payload,
          nextLogIdValue,
          (session) => {
            mergeSession(session, { preserveRunning: true })
          }
        )

        if (!appliedTurn) {
          return Array.isArray(currentTurn?.events) ? currentTurn.events : []
        }

        turns.value = [...turns.value]
        if (props.active && turns.value.at(-1)?.runId === runId) {
          scheduleScrollToBottom()
        }
        return appliedTurn.events
      } catch (err) {
        sessionError.value = err.message
        throw err
      } finally {
        setTurnEventsLoading(runId, false)
        runEventLoadPromises.delete(runId)
      }
    })()

    runEventLoadPromises.set(runId, requestPromise)
    return requestPromise
  }

  function applyIncomingRunEvent(runId, event) {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId || !event) {
      return false
    }

    const turnIndex = turns.value.findIndex((turn) => turn.runId === normalizedRunId)
    if (turnIndex < 0) {
      return false
    }

    const turn = turns.value[turnIndex]
    const didApply = applyRunEventToTurn(turn, event, nextLogIdValue, (session) => {
      mergeSession(session, { preserveRunning: true })
    })
    if (!didApply) {
      return true
    }

    turns.value = [...turns.value]
    syncRunningStateFromTurns()
    scheduleScrollToBottom()
    return true
  }

  function updatePollingState() {
    clearRunPollTimer()
    if (supportsServerEvents || !props.active || !sending.value || !props.taskSlug) {
      return
    }

    runPollTimer = window.setInterval(() => {
      refreshRunHistory({ force: true }).catch(() => {})

      const now = Date.now()
      if (now - lastFallbackSessionPollAt < FALLBACK_SESSION_POLL_INTERVAL_MS) {
        return
      }

      lastFallbackSessionPollAt = now
      loadSessions({ force: true }).catch(() => {})
    }, FALLBACK_RUN_POLL_INTERVAL_MS)
  }

  function rebuildTurns(runs = []) {
    const nextSessions = [...sessions.value]
    const previousTurnsByRunId = new Map(
      turns.value
        .filter((turn) => String(turn?.runId || '').trim())
        .map((turn) => [String(turn.runId || '').trim(), turn])
    )
    const mergeRunSession = (session) => {
      if (!session?.id) {
        return
      }

      const index = nextSessions.findIndex((item) => item.id === session.id)
      if (index >= 0) {
        nextSessions[index] = mergeSessionRecord(nextSessions[index], session, { preserveRunning: true })
      } else {
        nextSessions.unshift(mergeSessionRecord(null, session, { preserveRunning: true }))
      }
    }

    turnId = 0
    logId = 0
    turns.value = [...(runs || [])]
      .reverse()
      .map((run) => {
        const nextTurn = createTurnFromRun(run, nextTurnIdValue, nextLogIdValue, mergeRunSession)
        return preserveTurnEventsState(nextTurn, previousTurnsByRunId.get(String(run?.id || '').trim()) || null)
      })
    sessions.value = nextSessions
    syncRunningStateFromTurns()
  }

  async function refreshRunHistory(options = {}) {
    const { force = false, scrollToLatest = false } = options
    const taskSlug = String(props.taskSlug || '').trim()
    if (!taskSlug || (!props.active && !force)) {
      return
    }

    if (runsLoadPromise && !force) {
      return runsLoadPromise
    }

    runsLoadPromise = (async () => {
      try {
        const payload = await listTaskCodexRuns(taskSlug, {
          limit: 30,
          events: 'latest',
        })
        const items = payload.items || []
        const fingerprint = JSON.stringify(items.map((item) => ({
          id: item.id,
          status: item.status,
          updatedAt: item.updatedAt,
          eventCount: Math.max(0, Number(item.eventCount) || 0),
        })))
        const shouldScroll = scrollToLatest || (lastRunFingerprint && fingerprint !== lastRunFingerprint)

        rebuildTurns(items)
        lastRunFingerprint = fingerprint
        updatePollingState()

        const latestTurn = turns.value.at(-1) || null
        if (latestTurn?.runId && !latestTurn.eventsLoaded) {
          loadTurnEvents(latestTurn).catch(() => {})
        }

        if (shouldScroll) {
          scheduleScrollToBottom()
        }
      } catch (err) {
        sessionError.value = err.message
      } finally {
        runsLoadPromise = null
      }
    })()

    return runsLoadPromise
  }

  function applyCreatedRun(result = {}) {
    const createdRun = result?.run || null
    const createdSession = result?.session || null

    if (createdSession) {
      mergeSession(createdSession, { preserveRunning: true })
    }

    if (!createdRun?.id) {
      syncRunningStateFromTurns()
      scheduleScrollToBottom({ force: true })
      return
    }

    const mergeRunSession = (session) => {
      mergeSession(session, { preserveRunning: true })
    }
    const nextTurn = createTurnFromRun(createdRun, nextTurnIdValue, nextLogIdValue, mergeRunSession)
    const existingTurnIndex = turns.value.findIndex((turn) => turn.runId === nextTurn.runId)

    if (existingTurnIndex >= 0) {
      const nextTurns = [...turns.value]
      nextTurns.splice(existingTurnIndex, 1, nextTurn)
      turns.value = nextTurns
    } else {
      turns.value = [...turns.value, nextTurn]
    }

    syncRunningStateFromTurns()
    scheduleScrollToBottom({ force: true })
  }

  async function clearTurns() {
    if (!props.taskSlug || sending.value) {
      return
    }

    try {
      await clearTaskCodexRuns(props.taskSlug)
      resetRunHistoryState()
      scheduleScrollToBottom({ force: true })
    } catch (err) {
      sessionError.value = err.message
    }
  }

  return {
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
  }
}
