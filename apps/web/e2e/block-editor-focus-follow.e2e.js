import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { chromium } from 'playwright'

import { createTranscriptFixture, openWorkbenchTask, shutdownPromptxE2EStack } from './helpers.js'

function buildLongEditorBlocks() {
  return Array.from({ length: 18 }, (_, index) => ({
    type: 'text',
    content: `第 ${index + 1} 段\n${'内容 '.repeat(18)}`,
  }))
}

async function createTempFixtureFiles() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptx-editor-follow-'))
  const markdownPath = path.join(tempDir, 'focus-follow.md')

  await fs.writeFile(markdownPath, [
    '# 导入标题',
    '',
    '这是用于验证编辑区焦点跟随的 Markdown 文件。',
    '',
    '- 第一项',
    '- 第二项',
    '- 第三项',
    '',
    '下面补几段内容，确保展开后高度会明显增加。',
    '',
    ...Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行扩展内容`),
  ].join('\n'))

  return {
    markdownPath,
    async cleanup() {
      await fs.rm(tempDir, { recursive: true, force: true })
    },
  }
}

async function readEditorFocusState(page) {
  return page.evaluate(() => {
    const container = document.querySelector('section.panel.relative.flex.h-full.min-h-0.flex-col.overflow-hidden .flex-1.overflow-y-auto.px-5.py-5')
    const activeElement = document.activeElement
    const containerRect = container?.getBoundingClientRect?.()
    const activeRect = activeElement?.tagName === 'TEXTAREA'
      ? activeElement.getBoundingClientRect()
      : null

    return {
      activeTag: activeElement?.tagName || '',
      activeValueLength: activeElement?.tagName === 'TEXTAREA'
        ? activeElement.value.length
        : -1,
      scrollTop: container ? Math.round(container.scrollTop) : -1,
      visible: Boolean(
        containerRect
          && activeRect
          && activeRect.top >= containerRect.top + 20
          && activeRect.bottom <= containerRect.bottom - 20
      ),
    }
  })
}

test('长编辑区导入文本并触发内容高度变化后，当前焦点输入框始终保持可见', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E block editor focus follow',
    taskBlocks: buildLongEditorBlocks(),
  })
  const tempFiles = await createTempFixtureFiles()

  t.after(async () => {
    await tempFiles.cleanup()
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    const textareas = page.locator('textarea')
    await textareas.last().scrollIntoViewIfNeeded()
    await textareas.last().click()
    await textareas.last().press('End')

    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tempFiles.markdownPath)
    await page.getByText('focus-follow.md').waitFor({ timeout: 10000 })
    await page.waitForTimeout(800)

    const afterMarkdown = await readEditorFocusState(page)
    assert.equal(afterMarkdown.activeTag, 'TEXTAREA')
    assert.equal(afterMarkdown.visible, true)

    await page.evaluate(() => {
      const expandButton = Array.from(document.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('展开'))
      expandButton?.click()
    })
    await page.waitForTimeout(800)

    const afterExpand = await readEditorFocusState(page)
    assert.equal(afterExpand.activeTag, 'TEXTAREA')
    assert.equal(afterExpand.visible, true)

    await page.keyboard.type(' 插入后继续输入')
    await page.waitForTimeout(300)

    const afterTyping = await readEditorFocusState(page)
    assert.equal(afterTyping.activeTag, 'TEXTAREA')
    assert.equal(afterTyping.visible, true)
    assert.ok(afterTyping.activeValueLength >= afterExpand.activeValueLength)
  } finally {
    await browser.close()
  }
})
