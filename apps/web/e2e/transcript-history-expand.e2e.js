import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  appendRunPayloads,
  buildAgentMessageEvent,
  buildCommandCompletedEvent,
  buildCommandStartedEvent,
  buildReasoningEvent,
  buildSessionPayload,
  buildThreadStartedEvent,
  buildTurnCompletedEvent,
  buildTurnStartedEvent,
  createTranscriptFixture,
  openWorkbenchTask,
  shutdownPromptxE2EStack,
} from './helpers.js'
import { createCodexRun, updateCodexRun } from '../../server/src/codexRuns.js'

test('历史 turn 展开后会拉取并展示执行过程', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E transcript history expand',
    prompt: '旧 turn',
    responseMessage: '旧回复',
    status: 'completed',
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const latestRun = createCodexRun({
    taskSlug: fixture.task.slug,
    sessionId: fixture.session.id,
    prompt: '最新 turn',
    promptBlocks: [
      {
        type: 'text',
        content: '最新 turn',
      },
    ],
  })
  updateCodexRun(latestRun.id, {
    status: 'completed',
    responseMessage: '最新回复',
    finishedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  await appendRunPayloads(fixture.run.id, [
    buildSessionPayload(fixture.session, {
      codexThreadId: 'thread-history-old',
      engineThreadId: 'thread-history-old',
    }),
    buildThreadStartedEvent('thread-history-old'),
    buildTurnStartedEvent(),
    buildReasoningEvent('旧 turn reasoning'),
    buildCommandStartedEvent('echo old'),
    buildCommandCompletedEvent('echo old', 'old'),
    buildAgentMessageEvent('旧回复'),
    buildTurnCompletedEvent(),
  ])

  await appendRunPayloads(latestRun.id, [
    buildSessionPayload(fixture.session, {
      codexThreadId: 'thread-history-new',
      engineThreadId: 'thread-history-new',
    }),
    buildThreadStartedEvent('thread-history-new'),
    buildTurnStartedEvent(),
    buildReasoningEvent('新 turn reasoning'),
    buildCommandStartedEvent('echo new'),
    buildCommandCompletedEvent('echo new', 'new'),
    buildAgentMessageEvent('最新回复'),
    buildTurnCompletedEvent(),
  ])

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    const transcript = page.locator('.h-full.space-y-4.overflow-y-auto.px-4.py-4')
    const oldTurn = transcript.locator('> div').first()
    const processCard = oldTurn.locator('.theme-process-completed').first()
    const toggleButton = processCard.locator('button').first()

    await assert.doesNotReject(() => oldTurn.getByText('旧 turn').waitFor())
    assert.equal(await processCard.getByText('展开后加载').count(), 1)

    await toggleButton.click()

    await assert.doesNotReject(() => processCard.getByText('旧 turn reasoning').waitFor())
    await assert.doesNotReject(() => processCard.getByText('echo old').first().waitFor())
    assert.equal(await processCard.getByText('展开后加载').count(), 0)
  } finally {
    await browser.close()
  }
})
