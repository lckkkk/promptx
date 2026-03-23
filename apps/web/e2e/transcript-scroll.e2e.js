import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  appendRunPayloads,
  buildCommandCompletedEvent,
  buildCommandStartedEvent,
  buildReasoningEvent,
  buildSessionPayload,
  buildThreadStartedEvent,
  buildTurnStartedEvent,
  createTranscriptFixture,
  openWorkbenchTask,
  readTranscriptState,
  shutdownPromptxE2EStack,
} from './helpers.js'

test('执行过程面板遵循 IM 式滚动跟随规则', async (t) => {
  const initialPayloads = []
  for (let index = 1; index <= 16; index += 1) {
    initialPayloads.push(buildCommandStartedEvent(`echo init-${index}`))
    initialPayloads.push(buildCommandCompletedEvent(`echo init-${index}`, `init-${index}`))
  }

  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E transcript scroll',
    prompt: '测试滚动跟随逻辑',
    status: 'running',
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const threadId = 'thread-e2e-scroll'
  await appendRunPayloads(fixture.run.id, [
    buildSessionPayload(fixture.session, {
      codexThreadId: threadId,
      engineThreadId: threadId,
    }),
    buildThreadStartedEvent(threadId),
    buildTurnStartedEvent(),
    buildReasoningEvent('先生成一批初始执行过程'),
    ...initialPayloads,
  ])

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', {
      value: undefined,
      configurable: true,
    })
  })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    const initialState = await readTranscriptState(page)
    assert.equal(initialState.distanceToBottom, 0)
    assert.equal(initialState.hasNewerButton, false)

    await page.evaluate(() => {
      const transcript = document.querySelector('.h-full.space-y-4.overflow-y-auto.px-4.py-4')
      if (!transcript) {
        return
      }
      transcript.scrollTop = Math.max(0, transcript.scrollHeight - transcript.clientHeight - 600)
      transcript.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await page.waitForTimeout(300)

    const scrolledUpState = await readTranscriptState(page)
    assert.ok(scrolledUpState.distanceToBottom > 0)

    await appendRunPayloads(fixture.run.id, [
      buildCommandStartedEvent('echo step-up'),
      buildCommandCompletedEvent('echo step-up', 'step-up'),
    ], {
      updatedAt: new Date().toISOString(),
    })

    await page.waitForTimeout(2500)
    const afterIncomingWhileUp = await readTranscriptState(page)
    assert.equal(afterIncomingWhileUp.scrollTop, scrolledUpState.scrollTop)
    assert.ok(afterIncomingWhileUp.distanceToBottom > scrolledUpState.distanceToBottom)
    assert.ok(afterIncomingWhileUp.logCount > scrolledUpState.logCount)
    assert.equal(afterIncomingWhileUp.hasNewerButton, true)

    await page.evaluate(() => {
      const transcript = document.querySelector('.h-full.space-y-4.overflow-y-auto.px-4.py-4')
      if (!transcript) {
        return
      }
      transcript.scrollTop = transcript.scrollHeight
      transcript.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await page.waitForTimeout(300)
    const backToBottomState = await readTranscriptState(page)
    assert.equal(backToBottomState.distanceToBottom, 0)

    await appendRunPayloads(fixture.run.id, [
      buildCommandStartedEvent('echo step-bottom'),
      buildCommandCompletedEvent('echo step-bottom', 'step-bottom'),
    ], {
      updatedAt: new Date().toISOString(),
    })

    await page.waitForTimeout(2500)
    const afterIncomingWhileBottom = await readTranscriptState(page)
    assert.equal(afterIncomingWhileBottom.distanceToBottom, 0)
    assert.ok(afterIncomingWhileBottom.logCount > backToBottomState.logCount)
  } finally {
    await browser.close()
  }
})
