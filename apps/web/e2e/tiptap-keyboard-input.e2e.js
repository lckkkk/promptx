import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  createTranscriptFixture,
  focusTiptapBlock,
  openWorkbenchTask,
  readTiptapBlockText,
  shutdownPromptxE2EStack,
  updateTaskViaApi,
} from './helpers.js'

async function readTextBlockCount(page) {
  return page.evaluate(() => document.querySelectorAll('[data-promptx-node="text"]').length)
}

test('Tiptap 支持真实键盘英文输入与 Enter 拆分文本块', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap keyboard input',
    taskBlocks: [
      { type: 'text', content: '第一段' },
    ],
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  try {
    await updateTaskViaApi(fixture.task.slug, {
      blocks: [
        { type: 'text', content: '第一段' },
      ],
    })

    await openWorkbenchTask(page, fixture.task.slug, { editor: 'tiptap' })
    await focusTiptapBlock(page, { index: 0, position: 'end' })

    await page.keyboard.type(' abc')
    await page.keyboard.press('Enter')
    await page.keyboard.type('def')
    await page.waitForTimeout(400)

    const firstBlockText = await readTiptapBlockText(page, { index: 0 })
    const secondBlockText = await readTiptapBlockText(page, { index: 1 })
    const textBlockCount = await readTextBlockCount(page)

    assert.equal(firstBlockText, '第一段 abc')
    assert.equal(secondBlockText, 'def')
    assert.equal(textBlockCount, 2)
  } finally {
    await browser.close()
  }
})

test('点击编辑区空白区域后，会聚焦到最后一个文本块末尾', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap blank area focus',
    taskBlocks: [
      { type: 'text', content: '第一段' },
      { type: 'text', content: '第二段' },
    ],
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  try {
    await updateTaskViaApi(fixture.task.slug, {
      blocks: [
        { type: 'text', content: '第一段' },
        { type: 'text', content: '第二段' },
      ],
    })

    await openWorkbenchTask(page, fixture.task.slug, { editor: 'tiptap' })

    const scrollContainer = page.locator('[data-promptx-editor-scroll="tiptap"]')
    const box = await scrollContainer.boundingBox()
    assert.ok(box)

    await page.mouse.click(box.x + Math.round(box.width * 0.6), box.y + box.height - 24)
    await page.keyboard.type(' 末尾追加')
    await page.waitForTimeout(300)

    const firstBlockText = await readTiptapBlockText(page, { index: 0 })
    const secondBlockText = await readTiptapBlockText(page, { index: 1 })

    assert.equal(firstBlockText, '第一段')
    assert.equal(secondBlockText, '第二段 末尾追加')
  } finally {
    await browser.close()
  }
})

test('点击代办按钮前会先 flush 最新输入', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap flush before todo',
    taskBlocks: [
      { type: 'text', content: '第一段' },
    ],
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  try {
    await updateTaskViaApi(fixture.task.slug, {
      blocks: [
        { type: 'text', content: '第一段' },
      ],
    })

    await openWorkbenchTask(page, fixture.task.slug, { editor: 'tiptap' })
    await focusTiptapBlock(page, { index: 0, position: 'end' })

    await page.keyboard.type(' 立即收进代办')
    await page.getByRole('button', { name: '代办' }).first().click()
    await page.getByRole('button', { name: '代办 (1)' }).click()
    await page.getByText('管理代办').waitFor()
    await assert.doesNotReject(() => page.getByText('第一段 立即收进代办').waitFor())
  } finally {
    await browser.close()
  }
})
