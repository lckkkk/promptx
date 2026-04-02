import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  createTranscriptFixture,
  focusTiptapBlock,
  openWorkbenchTask,
  readTiptapBlockText,
  readTiptapScrollState,
  shutdownPromptxE2EStack,
  updateTaskViaApi,
} from './helpers.js'

function buildSingleLongBlock() {
  return [
    {
      type: 'text',
      content: Array.from(
        { length: 220 },
        (_, index) => `第 ${index + 1} 行 这是用于撑高单个文本块的内容`.repeat(3)
      ).join('\n'),
    },
  ]
}

async function readEditorScrollState(page) {
  const state = await readTiptapScrollState(page)
  return {
    ...state,
    valueSuffix: String(state.selectedBlockText || '').slice(-12),
  }
}

test('单个超长文本块在底部做中文组合输入时，编辑区不会跳回顶部', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor ime single block',
    taskBlocks: buildSingleLongBlock(),
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  try {
    await updateTaskViaApi(fixture.task.slug, {
      blocks: buildSingleLongBlock(),
    })

    await openWorkbenchTask(page, fixture.task.slug)

    const target = page.locator('.ProseMirror').first()
    await target.waitFor()
    await focusTiptapBlock(page, { index: 0, position: 'end' })

    await page.evaluate(() => {
      const container = document.querySelector('[data-promptx-editor-scroll="tiptap"]')
      if (!container) {
        return
      }
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - 12)
      container.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    const before = await readEditorScrollState(page)
    assert.match(before.activeClassName, /ProseMirror/)
    assert.ok(before.scrollTop > 0)

    const client = await page.context().newCDPSession(page)
    const textLength = (await readTiptapBlockText(page, { index: 0 })).length

    await client.send('Input.imeSetComposition', {
      text: '中',
      selectionStart: 1,
      selectionEnd: 1,
      replacementStart: textLength,
      replacementEnd: textLength,
    })
    await page.waitForTimeout(250)

    await client.send('Input.imeSetComposition', {
      text: '中文',
      selectionStart: 2,
      selectionEnd: 2,
      replacementStart: textLength,
      replacementEnd: textLength + 1,
    })
    await page.waitForTimeout(250)

    const duringComposition = await readEditorScrollState(page)
    assert.match(duringComposition.activeClassName, /ProseMirror/)
    assert.ok(duringComposition.scrollTop > 0)
    assert.ok(Math.abs(duringComposition.scrollTop - before.scrollTop) < 200)

    await client.send('Input.insertText', { text: '中文' })
    await page.waitForTimeout(400)

    const after = await readEditorScrollState(page)
    assert.match(after.activeClassName, /ProseMirror/)
    assert.ok(after.selectedBlockText.includes('中文'))
    assert.ok(after.scrollTop > 0)
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) < 260)
    assert.ok(after.maxScrollTop - after.scrollTop < 360)
  } finally {
    await browser.close()
  }
})
