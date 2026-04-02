import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'
import { createTask, deleteTask, updateTask } from '../../server/src/repository.js'

import {
  ensurePromptxE2EStack,
  focusTiptapBlock,
  shutdownPromptxE2EStack,
} from './helpers.js'

const INLINE_IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg=='

function buildMixedBlocks() {
  const fillerBefore = Array.from({ length: 6 }, (_, index) => ({
    type: 'text',
    content: `前置段落 ${index + 1}\n${'前置内容 '.repeat(12)}`,
  }))

  const fillerAfter = Array.from({ length: 6 }, (_, index) => ({
    type: 'text',
    content: `后置段落 ${index + 1}\n${'后置内容 '.repeat(12)}`,
  }))

  return [
    ...fillerBefore,
    {
      type: 'text',
      content: `文本A\n${'A 段内容 '.repeat(10)}\n${'A 段补充 '.repeat(10)}`,
    },
    {
      type: 'image',
      content: INLINE_IMAGE_DATA_URL,
      meta: {},
    },
    {
      type: 'text',
      content: `文本C\n${'C 段内容 '.repeat(10)}\n${'C 段补充 '.repeat(10)}`,
    },
    ...fillerAfter,
  ]
}

test('可视区域内从文本A切到文本C时，编辑区不应滚动', async (t) => {
  const task = createTask({
    title: 'E2E block editor visible focus switch',
  })
  updateTask(task.slug, {
    blocks: buildMixedBlocks(),
  })

  t.after(async () => {
    deleteTask(task.slug)
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  try {
    await ensurePromptxE2EStack()
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('promptx:locale', 'zh-CN')
      } catch {
      }
    })
    await page.goto('http://127.0.0.1:5174/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    })
    await page.waitForSelector('aside article', { timeout: 30000 })
    await page.locator('aside article', { hasText: task.title }).first().click()
    await page.waitForFunction(() => {
      const values = Array.from(document.querySelectorAll('[data-promptx-node="text"] [data-promptx-node-content="text"]'))
        .map((item) => item.textContent || '')
      return values.some((value) => value.includes('文本A')) && values.some((value) => value.includes('文本C'))
    }, { timeout: 15000 })

    const prepareState = await page.evaluate(() => {
      const container = document.querySelector('[data-promptx-editor-scroll="tiptap"]')
      const textBlocks = Array.from(document.querySelectorAll('[data-promptx-node="text"]'))
      const textA = textBlocks.find((item) => item.textContent.includes('文本A'))
      const textC = textBlocks.find((item) => item.textContent.includes('文本C'))

      if (!container || !textA || !textC) {
        return { ok: false }
      }

      const topA = textA.offsetTop
      const bottomC = textC.offsetTop + textC.offsetHeight
      const targetRangeHeight = bottomC - topA
      const centeredScrollTop = topA - Math.max(0, (container.clientHeight - targetRangeHeight) / 2)
      container.scrollTop = Math.max(0, centeredScrollTop)
      container.dispatchEvent(new Event('scroll', { bubbles: true }))

      let rectA = textA.getBoundingClientRect()
      let rectC = textC.getBoundingClientRect()
      let containerRect = container.getBoundingClientRect()

      for (let index = 0; index < 4; index += 1) {
        let adjusted = false

        if (rectA.top < containerRect.top + 8) {
          container.scrollTop = Math.max(0, container.scrollTop - (containerRect.top + 8 - rectA.top))
          adjusted = true
        }

        if (rectC.bottom > containerRect.bottom - 8) {
          container.scrollTop += rectC.bottom - (containerRect.bottom - 8)
          adjusted = true
        }

        if (!adjusted) {
          break
        }

        container.dispatchEvent(new Event('scroll', { bubbles: true }))
        rectA = textA.getBoundingClientRect()
        rectC = textC.getBoundingClientRect()
        containerRect = container.getBoundingClientRect()
      }

      return {
        ok: true,
        visibleA: rectA.top >= containerRect.top + 8 && rectA.bottom <= containerRect.bottom - 8,
        visibleC: rectC.top >= containerRect.top + 8 && rectC.bottom <= containerRect.bottom - 8,
        scrollTop: container.scrollTop,
      }
    })

    assert.equal(prepareState.ok, true)
    assert.ok(
      prepareState.visibleA && prepareState.visibleC,
      `A/C 未同时可见：${JSON.stringify(prepareState)}`
    )

    await focusTiptapBlock(page, { index: 6 })
    await page.waitForTimeout(150)
    const scrollAfterFocusA = await page.evaluate(() => {
      const container = document.querySelector('[data-promptx-editor-scroll="tiptap"]')
      return container ? Math.round(container.scrollTop) : -1
    })

    await focusTiptapBlock(page, { index: 7 })
    await page.waitForTimeout(250)
    const scrollAfterFocusC = await page.evaluate(() => {
      const container = document.querySelector('[data-promptx-editor-scroll="tiptap"]')
      return container ? Math.round(container.scrollTop) : -1
    })

    assert.ok(Math.abs(scrollAfterFocusA - prepareState.scrollTop) <= 2)
    assert.ok(Math.abs(scrollAfterFocusC - scrollAfterFocusA) <= 2)
  } finally {
    await browser.close()
  }
})
