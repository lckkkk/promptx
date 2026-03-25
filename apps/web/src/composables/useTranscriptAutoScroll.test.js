import test from 'node:test'
import assert from 'node:assert/strict'
import { nextTick, ref } from 'vue'

import { useTranscriptAutoScroll } from './useTranscriptAutoScroll.js'

function installWindowStubs() {
  const originalWindow = globalThis.window
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
  let nextFrameId = 1

  const requestAnimationFrameStub = (callback) => {
    const frameId = nextFrameId
    nextFrameId += 1
    callback()
    return frameId
  }
  const cancelAnimationFrameStub = () => {}

  globalThis.window = {
    requestAnimationFrame: requestAnimationFrameStub,
    cancelAnimationFrame: cancelAnimationFrameStub,
  }
  globalThis.requestAnimationFrame = requestAnimationFrameStub
  globalThis.cancelAnimationFrame = cancelAnimationFrameStub

  return () => {
    globalThis.window = originalWindow
    globalThis.requestAnimationFrame = originalRequestAnimationFrame
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  }
}

async function flushScrollScheduling() {
  await nextTick()
  await Promise.resolve()
}

test('移动端上滑时不会被自动滚到底部，回到底部后恢复跟随', async () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 800,
  })
  const hasNewerMessages = ref(false)

  try {
    const autoScroll = useTranscriptAutoScroll({
      transcriptRef,
      hasNewerMessages,
    })

    autoScroll.handleTranscriptTouchStart({
      touches: [{ clientY: 500 }],
    })
    autoScroll.handleTranscriptTouchMove({
      touches: [{ clientY: 460 }],
    })

    transcriptRef.value.scrollHeight = 1200
    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 800)
    assert.equal(hasNewerMessages.value, true)

    transcriptRef.value.scrollTop = 1000
    autoScroll.handleTranscriptScroll()
    autoScroll.handleTranscriptTouchEnd()

    assert.equal(hasNewerMessages.value, false)

    transcriptRef.value.scrollHeight = 1400
    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 1400)
    assert.equal(hasNewerMessages.value, false)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})

test('仅轻触 transcript 不会意外丢失底部跟随', async () => {
  const restoreWindow = installWindowStubs()
  const transcriptRef = ref({
    scrollHeight: 1000,
    clientHeight: 200,
    scrollTop: 800,
  })
  const hasNewerMessages = ref(false)

  try {
    const autoScroll = useTranscriptAutoScroll({
      transcriptRef,
      hasNewerMessages,
    })

    autoScroll.handleTranscriptTouchStart({
      touches: [{ clientY: 500 }],
    })

    transcriptRef.value.scrollHeight = 1200
    autoScroll.scheduleScrollToBottom()
    await flushScrollScheduling()

    assert.equal(transcriptRef.value.scrollTop, 800)
    assert.equal(hasNewerMessages.value, true)

    autoScroll.handleTranscriptTouchEnd()

    assert.equal(transcriptRef.value.scrollTop, 1200)
    assert.equal(hasNewerMessages.value, false)
    autoScroll.destroy()
  } finally {
    restoreWindow()
  }
})
