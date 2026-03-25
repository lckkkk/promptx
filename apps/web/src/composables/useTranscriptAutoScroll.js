import { nextTick } from 'vue'

export function useTranscriptAutoScroll(options = {}) {
  const {
    transcriptRef,
    hasNewerMessages,
    threshold = 48,
  } = options

  let pendingScrollJobId = 0
  let pendingScrollFrameIds = []
  let userInteracting = false
  let detachedHasNewMessages = false
  let interactionReleaseJobId = 0
  let followingBottom = true

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

  function setHasNewerMessages(nextValue) {
    detachedHasNewMessages = Boolean(nextValue)
    if (hasNewerMessages?.value !== undefined) {
      hasNewerMessages.value = detachedHasNewMessages
    }
  }

  function resetAutoStickToBottom() {
    userInteracting = false
    interactionReleaseJobId += 1
    followingBottom = true
    setHasNewerMessages(false)
  }

  function isTranscriptNearBottom(element = transcriptRef?.value) {
    if (!element) {
      return true
    }

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    return distanceToBottom <= threshold
  }

  function shouldAutoFollow() {
    return followingBottom && !userInteracting
  }

  function clearDetachedMessagesIfNeeded() {
    if (followingBottom && !userInteracting) {
      setHasNewerMessages(false)
    }
  }

  function handleTranscriptScroll() {
    followingBottom = isTranscriptNearBottom()
    if (!followingBottom) {
      cancelScheduledScrollToBottom()
      return
    }

    clearDetachedMessagesIfNeeded()
  }

  function handleTranscriptTouchStart() {
    interactionReleaseJobId += 1
    userInteracting = true
    cancelScheduledScrollToBottom()
  }

  function scheduleInteractionRelease() {
    const jobId = interactionReleaseJobId + 1
    interactionReleaseJobId = jobId

    nextTick(() => {
      if (jobId !== interactionReleaseJobId) {
        return
      }

      requestAnimationFrame(() => {
        if (jobId !== interactionReleaseJobId) {
          return
        }

        userInteracting = false
        followingBottom = isTranscriptNearBottom()
        clearDetachedMessagesIfNeeded()
      })
    })
  }

  function handleTranscriptTouchMove() {
    userInteracting = true
    cancelScheduledScrollToBottom()
  }

  function handleTranscriptTouchEnd() {
    scheduleInteractionRelease()
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

      if (!force && !shouldAutoFollow()) {
        setHasNewerMessages(true)
        return
      }

      const run = () => {
        const currentElement = transcriptRef?.value
        if (!currentElement || jobId !== pendingScrollJobId) {
          return
        }

        currentElement.scrollTop = currentElement.scrollHeight
        followingBottom = true
        setHasNewerMessages(false)
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
    interactionReleaseJobId += 1
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
