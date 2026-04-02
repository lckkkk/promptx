import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'

import {
  createTranscriptFixture,
  focusTiptapBlock,
  openWorkbenchTask,
  readTiptapBlockText,
  readTiptapSelectionState,
  shutdownPromptxE2EStack,
  updateTaskViaApi,
} from './helpers.js'

function buildTextBlocks(content) {
  return [
    {
      type: 'text',
      content,
    },
  ]
}

test('聚焦编辑时，服务端刷新不会覆盖本地输入', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor sync focus',
    taskBlocks: buildTextBlocks('初始内容'),
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    await page.locator('.ProseMirror').first().waitFor()
    await focusTiptapBlock(page, { index: 0, position: 'end' })
    await page.keyboard.insertText(' 本地新增-聚焦态')

    await updateTaskViaApi(fixture.task.slug, {
      blocks: buildTextBlocks('服务端覆盖内容-聚焦态'),
    })

    await page.waitForTimeout(1200)

    const value = await readTiptapBlockText(page, { index: 0 })
    assert.match(value, /本地新增-聚焦态/)
    assert.doesNotMatch(value, /服务端覆盖内容-聚焦态/)
  } finally {
    await browser.close()
  }
})

test('刚输入后短暂失焦时，服务端刷新不会覆盖本地输入', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor sync grace',
    taskBlocks: buildTextBlocks('初始内容'),
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    await page.locator('.ProseMirror').first().waitFor()
    await focusTiptapBlock(page, { index: 0, position: 'end' })
    await page.keyboard.insertText(' 本地新增-失焦保护')
    await page.evaluate(() => {
      document.activeElement?.blur?.()
    })

    await updateTaskViaApi(fixture.task.slug, {
      blocks: buildTextBlocks('服务端覆盖内容-失焦态'),
    })

    await page.waitForTimeout(900)

    const value = await readTiptapBlockText(page, { index: 0 })
    assert.match(value, /本地新增-失焦保护/)
    assert.doesNotMatch(value, /服务端覆盖内容-失焦态/)
  } finally {
    await browser.close()
  }
})

test('真正空闲后，服务端刷新仍可同步到编辑区', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor sync idle',
    taskBlocks: buildTextBlocks('初始内容'),
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    await page.locator('.ProseMirror').first().waitFor()
    await page.evaluate(() => {
      document.activeElement?.blur?.()
    })
    await page.waitForTimeout(1800)

    await updateTaskViaApi(fixture.task.slug, {
      blocks: buildTextBlocks('服务端新内容-空闲同步'),
    })

    await page.waitForTimeout(1200)

    const value = await readTiptapBlockText(page, { index: 0 })
    assert.equal(value, '服务端新内容-空闲同步')
  } finally {
    await browser.close()
  }
})

test('聚焦编辑且自动保存完成后，服务端刷新仍不会覆盖本地输入', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor sync autosaved focus',
    taskBlocks: buildTextBlocks('初始内容'),
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    await page.locator('.ProseMirror').first().waitFor()
    await focusTiptapBlock(page, { index: 0, position: 'end' })
    await page.keyboard.insertText(' 本地新增-自动保存后')

    await page.waitForTimeout(2400)

    await updateTaskViaApi(fixture.task.slug, {
      blocks: buildTextBlocks('服务端覆盖内容-自动保存后'),
    })

    await page.waitForTimeout(1200)

    const value = await readTiptapBlockText(page, { index: 0 })
    assert.match(value, /本地新增-自动保存后/)
    assert.doesNotMatch(value, /服务端覆盖内容-自动保存后/)
  } finally {
    await browser.close()
  }
})

test('长内容中间输入时，编辑区不会自动跳到底部', async (t) => {
  const longBlocks = Array.from({ length: 20 }, (_, index) => ({
    type: 'text',
    content: `第 ${index + 1} 段\n${'内容 '.repeat(30)}`,
  }))
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor scroll stable',
    taskBlocks: longBlocks,
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } })

  try {
    await updateTaskViaApi(fixture.task.slug, {
      blocks: longBlocks,
    })

    await openWorkbenchTask(page, fixture.task.slug)

    const textBlocks = page.locator('[data-promptx-node="text"]')
    await textBlocks.first().waitFor()
    assert.ok((await textBlocks.count()) >= 5)

    const beforeScrollTop = await page.evaluate(() => {
      const container = document.querySelector('[data-promptx-editor-scroll="tiptap"]')
      if (!container) {
        return -1
      }
      container.scrollTop = 420
      container.dispatchEvent(new Event('scroll', { bubbles: true }))
      return container.scrollTop
    })

    await textBlocks.nth(4).scrollIntoViewIfNeeded()
    await focusTiptapBlock(page, { index: 4, position: 'end' })
    await page.keyboard.insertText(' 中间继续输入')
    await page.waitForTimeout(300)

    const afterScroll = await page.evaluate(() => {
      const container = document.querySelector('[data-promptx-editor-scroll="tiptap"]')
      if (!container) {
        return { scrollTop: -1, maxScrollTop: -1 }
      }

      return {
        scrollTop: container.scrollTop,
        maxScrollTop: Math.max(0, container.scrollHeight - container.clientHeight),
      }
    })

    assert.ok(beforeScrollTop >= 0)
    assert.ok(Math.abs(afterScroll.scrollTop - beforeScrollTop) < 120)
    assert.ok(afterScroll.maxScrollTop - afterScroll.scrollTop > 200)
  } finally {
    await browser.close()
  }
})

test('删除前置 block 时，当前输入焦点与内容保持稳定', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor stable block key',
    taskBlocks: [
      {
        type: 'text',
        content: '第一段',
      },
      {
        type: 'image',
        content: 'https://example.com/test.png',
      },
      {
        type: 'text',
        content: '第二段',
      },
    ],
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  try {
    await updateTaskViaApi(fixture.task.slug, {
      blocks: [
        {
          type: 'text',
          content: '第一段',
        },
        {
          type: 'image',
          content: 'https://example.com/test.png',
        },
        {
          type: 'text',
          content: '第二段',
        },
      ],
    })

    await openWorkbenchTask(page, fixture.task.slug)

    const textBlocks = page.locator('[data-promptx-node="text"]')
    await textBlocks.first().waitFor()
    assert.ok((await textBlocks.count()) >= 2)
    await textBlocks.nth(1).scrollIntoViewIfNeeded()
    await focusTiptapBlock(page, { index: 1, position: 'end' })
    await page.keyboard.insertText(' 保持焦点')

    const imageBlock = page.locator('[data-promptx-node="image"]').first()
    await imageBlock.hover()
    await imageBlock.getByRole('button', { name: '删除' }).click()
    await page.waitForTimeout(300)

    const focusedState = await readTiptapSelectionState(page)

    assert.match(focusedState.activeClassName, /ProseMirror/)
    assert.equal(focusedState.blockType, 'text')
    assert.match(focusedState.blockText, /第二段 保持焦点/)
  } finally {
    await browser.close()
  }
})

test('点击编辑器工具栏按钮后，继续输入不会立刻丢焦点', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E editor toolbar focus',
    taskBlocks: buildTextBlocks('待办前内容'),
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

  try {
    await openWorkbenchTask(page, fixture.task.slug)

    await page.locator('.ProseMirror').first().waitFor()
    await focusTiptapBlock(page, { index: 0, position: 'end' })
    await page.keyboard.insertText(' 先收进代办')

    await page.getByRole('button', { name: '代办', exact: true }).first().click()
    await page.keyboard.insertText('继续输入不会丢焦点')
    await page.waitForTimeout(300)

    const activeState = await readTiptapSelectionState(page)
    const value = await readTiptapBlockText(page, { index: 0 })

    assert.match(activeState.activeClassName, /ProseMirror/)
    assert.equal(value, '继续输入不会丢焦点')
  } finally {
    await browser.close()
  }
})
