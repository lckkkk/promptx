import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { promises as fs } from 'node:fs'
import { chromium } from 'playwright'

import {
  createTranscriptFixture,
  focusTiptapBlock,
  openWorkbenchTask,
  readTiptapSelectionState,
  readTiptapScrollState,
  shutdownPromptxE2EStack,
} from './helpers.js'

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

test('长编辑区导入文本块展开与收起时，不会主动改动滚动位置', async (t) => {
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
    await openWorkbenchTask(page, fixture.task.slug, { editor: 'tiptap' })

    const textBlocks = page.locator('[data-promptx-node="text"]')
    await textBlocks.last().scrollIntoViewIfNeeded()
    await focusTiptapBlock(page, { index: 17, position: 'end' })

    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tempFiles.markdownPath)
    const importedBlock = page.locator('[data-promptx-node="imported_text"]').last()
    await importedBlock.getByText('focus-follow.md').waitFor({ timeout: 10000 })
    await page.waitForTimeout(800)

    const beforeExpand = await readTiptapScrollState(page)
    assert.match(beforeExpand.activeClassName, /ProseMirror/)

    await importedBlock.locator('[data-promptx-imported-actions] button').filter({ hasText: '展开' }).click()
    await page.waitForTimeout(800)

    const afterExpand = await readTiptapScrollState(page)
    assert.match(afterExpand.activeClassName, /ProseMirror/)
    assert.ok(Math.abs(afterExpand.scrollTop - beforeExpand.scrollTop) < 40)

    await importedBlock.locator('[data-promptx-imported-actions] button').filter({ hasText: '折叠' }).click()
    await page.waitForTimeout(800)

    const afterCollapse = await readTiptapScrollState(page)
    assert.match(afterCollapse.activeClassName, /ProseMirror/)
    assert.ok(Math.abs(afterCollapse.scrollTop - afterExpand.scrollTop) < 40)

    await page.keyboard.insertText(' 插入后继续输入')
    await page.waitForTimeout(300)

    const afterTyping = await readTiptapScrollState(page)
    const selectionState = await readTiptapSelectionState(page)
    assert.match(afterTyping.activeClassName, /ProseMirror/)
    assert.match(selectionState.blockText, /插入后继续输入/)
  } finally {
    await browser.close()
  }
})

test('点击导入块后的空白区域时，焦点会回到最后一个文本块', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E block editor blank focus after import',
    taskBlocks: [
      { type: 'text', content: '第一段' },
    ],
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
    await openWorkbenchTask(page, fixture.task.slug, { editor: 'tiptap' })

    const fileInput = page.locator('input[type="file"]')
    await fileInput.setInputFiles(tempFiles.markdownPath)
    await page.getByText('focus-follow.md').waitFor({ timeout: 10000 })
    await page.waitForTimeout(500)

    await page.evaluate(() => {
      const container = document.querySelector('[data-promptx-editor-scroll="tiptap"]')
      if (!(container instanceof HTMLElement)) {
        return
      }

      const rect = container.getBoundingClientRect()
      const target = document.elementFromPoint(rect.left + rect.width / 2, rect.bottom - 24)
      target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.bottom - 24 }))
    })
    await page.keyboard.insertText(' 继续补充')
    await page.waitForTimeout(300)

    const selectionState = await readTiptapSelectionState(page)
    assert.equal(selectionState.blockType, 'text')
    assert.match(selectionState.blockText, /继续补充/)
  } finally {
    await browser.close()
  }
})
