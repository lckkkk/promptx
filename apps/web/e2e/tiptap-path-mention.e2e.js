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

test('Tiptap 编辑器支持通过快捷键插入路径 mention', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap path mention',
    taskBlocks: [
      {
        type: 'text',
        content: '请参考 ',
      },
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
      codexSessionId: fixture.session.id,
      blocks: [
        {
          type: 'text',
          content: '请参考 ',
        },
      ],
    })

    await openWorkbenchTask(page, fixture.task.slug)
    await page.locator('.ProseMirror').first().waitFor()
    await focusTiptapBlock(page, { index: 0, position: 'end' })

    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K')
    await page.keyboard.insertText('package')

    const packageJsonOption = page.getByText('package.json').first()
    await packageJsonOption.waitFor({ timeout: 10000 })
    await packageJsonOption.click()
    await page.waitForTimeout(400)

    const value = await readTiptapBlockText(page, { index: 0 })
    assert.match(value, /请参考 /)
    assert.match(value, /package\.json/)
    assert.doesNotMatch(value, /@package/)
  } finally {
    await browser.close()
  }
})
