import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  createTranscriptFixture,
  openWorkbenchTask,
  shutdownPromptxE2EStack,
  updateTaskViaApi,
} from './helpers.js'

function buildSingleLongBlock() {
  return [
    {
      type: 'text',
      content: Array.from(
        { length: 220 },
        (_, index) => `第 ${index + 1} 行 这是用于撑高单个 textarea 的内容`.repeat(3)
      ).join('\n'),
    },
  ]
}

async function readEditorScrollState(page) {
  return page.evaluate(() => {
    const activeElement = document.activeElement
    const container = activeElement?.tagName === 'TEXTAREA'
      ? activeElement.closest('div.flex-1.overflow-y-auto.px-5.py-5')
      : null

    return {
      activeTag: activeElement?.tagName || '',
      scrollTop: container ? Math.round(container.scrollTop) : -1,
      maxScrollTop: container ? Math.round(Math.max(0, container.scrollHeight - container.clientHeight)) : -1,
      valueSuffix: activeElement?.tagName === 'TEXTAREA'
        ? String(activeElement.value || '').slice(-12)
        : '',
    }
  })
}

test('单个超长 textarea 在底部做中文组合输入时，编辑区不会跳回顶部', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor ime single textarea',
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

    const target = page.locator('textarea').first()
    await target.waitFor()
    await target.click()
    await target.press('End')

    await page.evaluate(() => {
      const activeElement = document.activeElement
      const container = activeElement?.tagName === 'TEXTAREA'
        ? activeElement.closest('div.flex-1.overflow-y-auto.px-5.py-5')
        : null
      if (!container) {
        return
      }
      container.scrollTop = Math.max(0, container.scrollHeight - container.clientHeight - 12)
      container.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    const before = await readEditorScrollState(page)
    assert.equal(before.activeTag, 'TEXTAREA')
    assert.ok(before.scrollTop > 0)

    const client = await page.context().newCDPSession(page)
    const textLength = await target.evaluate((element) => element.value.length)

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
    assert.equal(duringComposition.activeTag, 'TEXTAREA')
    assert.ok(duringComposition.scrollTop > 0)
    assert.ok(Math.abs(duringComposition.scrollTop - before.scrollTop) < 200)

    await client.send('Input.insertText', { text: '中文' })
    await page.waitForTimeout(400)

    const after = await readEditorScrollState(page)
    assert.equal(after.activeTag, 'TEXTAREA')
    assert.ok(after.valueSuffix.endsWith('中文'))
    assert.ok(after.scrollTop > 0)
    assert.ok(Math.abs(after.scrollTop - before.scrollTop) < 260)
    assert.ok(after.maxScrollTop - after.scrollTop < 360)
  } finally {
    await browser.close()
  }
})
