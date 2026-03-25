import { nextTick } from 'vue'

export function useTranscriptAutoScroll(options = {}) {
  const {
    transcriptRef,
    hasNewerMessages,
    threshold = 48,
  } = options

  let pendingScrollJobId = 0
  let pendingScrollFrameIds = []
  let stickToBottom = true
  let touchActive = false
  let touchStartY = null
  let touchStartedAtBottom = true
  let touchMovedAwayFromBottom = false

  function clearPendingScrollFrames() {
    if (typeof window === 'undefined' || !pendingScrollFrameIds.length) {
      pendingScrollFrameIds = []
      return
    }

    pendingScrollFrameIds.forEach((frameId) => {
      window.cancelAnimationFrame(frameId)
    })
    pendingScrollFrameIds = []
  }

  function cancelScheduledScrollToBottom() {
    pendingScrollJobId += 1
    clearPendingScrollFrames()
  }

  function resetAutoStickToBottom() {
    stickToBottom = true
    touchActive = false
    touchStartY = null
    touchStartedAtBottom = true
    touchMovedAwayFromBottom = false
    if (hasNewerMessages?.value !== undefined) {
      hasNewerMessages.value = false
    }
  }

  function isTranscriptNearBottom(element = transcriptRef?.value) {
    if (!element) {
      return true
    }

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    return distanceToBottom <= threshold
  }

  function handleTranscriptScroll() {
    const nextStickToBottom = isTranscriptNearBottom()
    if (!nextStickToBottom) {
      cancelScheduledScrollToBottom()
    }

    stickToBottom = nextStickToBottom
    syncHasNewerMessagesState()
  }

  function syncHasNewerMessagesState() {
    if (hasNewerMessages?.value === undefined) {
      return
    }

    hasNewerMessages.value = !stickToBottom
  }

  function getTouchClientY(event) {
    const touch = event?.touches?.[0] || event?.changedTouches?.[0] || null
    const value = Number(touch?.clientY)
    return Number.isFinite(value) ? value : null
  }

  function handleTranscriptTouchStart(event) {
    touchActive = true
    touchStartY = getTouchClientY(event)
    touchStartedAtBottom = stickToBottom || isTranscriptNearBottom()
    touchMovedAwayFromBottom = false
  }

  function handleTranscriptTouchMove(event) {
    if (!touchActive) {
      return
    }

    const currentY = getTouchClientY(event)
    if (!Number.isFinite(currentY) || !Number.isFinite(touchStartY)) {
      return
    }

    if (currentY >= touchStartY - 4) {
      return
    }

    cancelScheduledScrollToBottom()
    stickToBottom = false
    touchMovedAwayFromBottom = true
    syncHasNewerMessagesState()
  }

  function handleTranscriptTouchEnd() {
    const wasTouchActive = touchActive
    const shouldRestoreFollow = wasTouchActive && touchStartedAtBottom && !touchMovedAwayFromBottom

    touchActive = false
    touchStartY = null
    touchStartedAtBottom = true
    touchMovedAwayFromBottom = false

    if (shouldRestoreFollow) {
      const element = transcriptRef?.value
      if (element) {
        element.scrollTop = element.scrollHeight
      }
      stickToBottom = true
    } else {
      stickToBottom = isTranscriptNearBottom()
    }
    syncHasNewerMessagesState()
  }

  function scheduleScrollToBottom(options = {}) {
    const { force = false } = options
    if (force) {
      resetAutoStickToBottom()
    }

    cancelScheduledScrollToBottom()
    const jobId = pendingScrollJobId

    nextTick(() => {
      const element = transcriptRef?.value
      if (!element || jobId !== pendingScrollJobId) {
        return
      }

      if (!force && (!stickToBottom || touchActive)) {
        if (hasNewerMessages?.value !== undefined) {
          hasNewerMessages.value = true
        }
        return
      }

      const run = () => {
        const currentElement = transcriptRef?.value
        if (!currentElement || jobId !== pendingScrollJobId) {
          return
        }

        currentElement.scrollTop = currentElement.scrollHeight
        stickToBottom = true
        touchActive = false
        touchStartY = null
        touchStartedAtBottom = true
        touchMovedAwayFromBottom = false
        if (hasNewerMessages?.value !== undefined) {
          hasNewerMessages.value = false
        }
      }

      run()
      const firstFrameId = requestAnimationFrame(() => {
        run()
        const secondFrameId = requestAnimationFrame(run)
        pendingScrollFrameIds = [secondFrameId]
      })
      pendingScrollFrameIds = [firstFrameId]
    })
  }

  function scrollToBottom() {
    scheduleScrollToBottom({ force: true })
  }

  function destroy() {
    cancelScheduledScrollToBottom()
  }

  return {
    cancelScheduledScrollToBottom,
    destroy,
    handleTranscriptScroll,
    handleTranscriptTouchEnd,
    handleTranscriptTouchMove,
    handleTranscriptTouchStart,
    isTranscriptNearBottom,
    resetAutoStickToBottom,
    scheduleScrollToBottom,
    scrollToBottom,
  }
}
