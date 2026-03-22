import { ref, watch } from 'vue'
import { isTurnActiveStatus } from './codexSessionPanelTurns.js'

const PROMPT_COLLAPSE_MAX_LINES = 8
const PROMPT_COLLAPSE_MAX_CHARS = 320
const RESPONSE_COLLAPSE_MAX_LINES = 10
const RESPONSE_COLLAPSE_MAX_CHARS = 400

function exceedsCollapseThreshold(content, maxLines, maxChars) {
  const text = String(content || '').trimEnd()
  if (!text) {
    return false
  }

  const lines = text.split(/\r?\n/).length
  return lines > maxLines || text.length > maxChars
}

export function useCodexTranscriptCollapse(options = {}) {
  const { turns, loadTurnEvents } = options

  const collapsedTurnMap = ref({})
  const collapsedPromptMap = ref({})
  const collapsedResponseMap = ref({})

  function getTurnEventCollapseKey(turn) {
    return String(turn?.runId || turn?.id || '').trim()
  }

  function isLatestTurn(turn) {
    const key = getTurnEventCollapseKey(turn)
    return Boolean(key) && key === getTurnEventCollapseKey(turns.value.at(-1))
  }

  function getTurnEventCount(turn) {
    return Math.max(
      Math.max(0, Number(turn?.eventCount) || 0),
      Array.isArray(turn?.events) ? turn.events.length : 0
    )
  }

  function shouldCollapseTurn(turn) {
    return !isTurnActiveStatus(turn?.status)
      && !isLatestTurn(turn)
      && getTurnEventCount(turn) > 3
  }

  function canCollapsePrompt(turn) {
    return exceedsCollapseThreshold(turn?.prompt, PROMPT_COLLAPSE_MAX_LINES, PROMPT_COLLAPSE_MAX_CHARS)
  }

  function shouldCollapsePrompt(turn) {
    return !isTurnActiveStatus(turn?.status)
      && !isLatestTurn(turn)
      && canCollapsePrompt(turn)
  }

  function getTurnResponseContent(turn) {
    return String(turn?.errorMessage || turn?.responseMessage || '')
  }

  function canCollapseResponse(turn) {
    return exceedsCollapseThreshold(getTurnResponseContent(turn), RESPONSE_COLLAPSE_MAX_LINES, RESPONSE_COLLAPSE_MAX_CHARS)
  }

  function shouldCollapseResponse(turn) {
    return !turn?.errorMessage
      && !isLatestTurn(turn)
      && canCollapseResponse(turn)
  }

  function hasTurnEventHistory(turn) {
    return getTurnEventCount(turn) > 0
  }

  function syncCollapsedTurns(nextTurns = []) {
    const validIds = new Set((nextTurns || []).map((turn) => getTurnEventCollapseKey(turn)).filter(Boolean))
    collapsedTurnMap.value = Object.fromEntries(
      Object.entries(collapsedTurnMap.value).filter(([id]) => validIds.has(id))
    )
    collapsedPromptMap.value = Object.fromEntries(
      Object.entries(collapsedPromptMap.value).filter(([id]) => validIds.has(id))
    )
    collapsedResponseMap.value = Object.fromEntries(
      Object.entries(collapsedResponseMap.value).filter(([id]) => validIds.has(id))
    )

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

  watch(
    turns,
    (nextTurns) => {
      syncCollapsedTurns(nextTurns)
    },
    { immediate: true, deep: true }
  )

  return {
    canCollapsePrompt,
    canCollapseResponse,
    getTurnEventCollapseKey,
    getTurnEventCount,
    hasTurnEventHistory,
    isLatestTurn,
    isPromptCollapsed,
    isResponseCollapsed,
    isTurnEventsCollapsed,
    togglePrompt,
    toggleResponse,
    toggleTurnEvents,
  }
}
