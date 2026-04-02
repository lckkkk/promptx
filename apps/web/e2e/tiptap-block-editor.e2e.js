import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { chromium } from 'playwright'
import {
  createTranscriptFixture,
  focusTiptapBlock,
  openWorkbenchTask,
  readTiptapSelectionState,
  shutdownPromptxE2EStack,
  updateTaskViaApi,
} from './helpers.js'

const SAMPLE_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAHgAAAA8CAIAAAAiz+n/AAAAs0lEQVR4nO3cMQ6AIBAAQTD+/8v4AkOjG2NmWgrI5hoKmGutwfuOYA+E7pjoiNARoSNCR4SOCB0ROnJu1ueMDvIP99dsEx0ROiJ0ROiI0BGhI0JHhI4IHRE6InRE6IjQEaEjQkeEjggdEToidEToiNARoSNCR4SOCB0ROiJ0ROiI0BGhI0JHhI4IHRE6InRE6IjQEaEjQkeE/siDTh8BPcRER4SOCB0ROiJ0ROiI0BGhR+MCKJwHdw1TU3EAAAAASUVORK5CYII='
const SAMPLE_PDF_BASE64 = 'JVBERi0xLjMKJZOMi54gUmVwb3J0TGFiIEdlbmVyYXRlZCBQREYgZG9jdW1lbnQgKG9wZW5zb3VyY2UpCjEgMCBvYmoKPDwKL0YxIDIgMCBSIC9GMiAzIDAgUgo+PgplbmRvYmoKMiAwIG9iago8PAovQmFzZUZvbnQgL0hlbHZldGljYSAvRW5jb2RpbmcgL1dpbkFuc2lFbmNvZGluZyAvTmFtZSAvRjEgL1N1YnR5cGUgL1R5cGUxIC9UeXBlIC9Gb250Cj4+CmVuZG9iagozIDAgb2JqCjw8Ci9CYXNlRm9udCAvWmFwZkRpbmdiYXRzIC9OYW1lIC9GMiAvU3VidHlwZSAvVHlwZTEgL1R5cGUgL0ZvbnQKPj4KZW5kb2JqCjQgMCBvYmoKPDwKL0JpdHNQZXJDb21wb25lbnQgOCAvQ29sb3JTcGFjZSAvRGV2aWNlUkdCIC9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvSGVpZ2h0IDYwIC9MZW5ndGggMTQwIC9TdWJ0eXBlIC9JbWFnZSAKICAvVHlwZSAvWE9iamVjdCAvV2lkdGggMTIwCj4+CnN0cmVhbQpHYiIwSjBiIis6JSlCKzwtZiJnVVs8JUoqK1JsTlo4V2s+aj0jNTttMVshMlYzTEFtUFxNUnNFVilgVExjJ2BXZWNDQE9LayQ0PzJrTCxrXFFmY04mMWhZKzEzSEhndFI8KilmUzRkcWM+YWRKM2RbVz1hazAxQG1CP20+IjhXa0BgVCsyVGZlRyd+PmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PAovQ29udGVudHMgOSAwIFIgL01lZGlhQm94IFsgMCAwIDYxMiA3OTIgXSAvUGFyZW50IDggMCBSIC9SZXNvdXJjZXMgPDwKL0ZvbnQgMSAwIFIgL1Byb2NTZXQgWyAvUERGIC9UZXh0IC9JbWFnZUIgL0ltYWdlQyAvSW1hZ2VJIF0gL1hPYmplY3QgPDwKL0Zvcm1Yb2IuZThkNTVhMjBhYjMyMDk2ZDliNGRjZTJhMTRkYjEzMWUgNCAwIFIKPj4KPj4gL1JvdGF0ZSAwIC9UcmFucyA8PAoKPj4gCiAgL1R5cGUgL1BhZ2UKPj4KZW5kb2JqCjYgMCBvYmoKPDwKL1BhZ2VNb2RlIC9Vc2VOb25lIC9QYWdlcyA4IDAgUiAvVHlwZSAvQ2F0YWxvZwo+PgplbmRvYmoKNyAwIG9iago8PAovQXV0aG9yIChhbm9ueW1vdXMpIC9DcmVhdGlvbkRhdGUgKEQ6MjAyNjAzMTIxODQ0MTYrMDgnMDAnKSAvQ3JlYXRvciAoYW5vbnltb3VzKSAvS2V5d29yZHMgKCkgL01vZERhdGUgKEQ6MjAyNjAzMTIxODQ0MTYrMDgnMDAnKSAvUHJvZHVjZXIgKFJlcG9ydExhYiBQREYgTGlicmFyeSAtIFwob3BlbnNvdXJjZVwpKSAKICAvU3ViamVjdCAodW5zcGVjaWZpZWQpIC9UaXRsZSAodW50aXRsZWQpIC9UcmFwcGVkIC9GYWxzZQo+PgplbmRvYmoKOCAwIG9iago8PAovQ291bnQgMSAvS2lkcyBbIDUgMCBSIF0gL1R5cGUgL1BhZ2VzCj4+CmVuZG9iago5IDAgb2JqCjw8Ci9GaWx0ZXIgWyAvQVNDSUk4NURlY29kZSAvRmxhdGVEZWNvZGUgXSAvTGVuZ3RoIDIwNQo+PgpzdHJlYW0KR2FzYlJZbXVAPiY7S3BDYEJVKCFnbShvSzI5PWpPYVVQRDtfSS04dV5BaFJlXC5CQFhHOSxFO14zZz9ITFdAIjleZDQoNCUrXkxdQ2YxP3FpQCshMzQmOltHTl9QVEhQQnJOZ21bcjJ1REA8QkdrR2xQb1xbOzxIOlVVV0hVdDcwS0ouS1UmTlBxIjo4L25IOS5dXD47XC4xLlkkPydkVldII0pHRXAkKS5JLCFuP05IXm42TE1CWVBSP2ZgMUJXXG00XWA/XzhCJ11+PmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDEwCjAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDA2MSAwMDAwMCBuIAowMDAwMDAwMTAyIDAwMDAwIG4gCjAwMDAwMDAyMDkgMDAwMDAgbiAKMDAwMDAwMDI5MiAwMDAwMCBuIAowMDAwMDAwNjIxIDAwMDAwIG4gCjAwMDAwMDA4NzcgMDAwMDAgbiAKMDAwMDAwMDk0NSAwMDAwMCBuIAowMDAwMDAxMjA2IDAwMDAwIG4gCjAwMDAwMDEyNjUgMDAwMDAgbiAKdHJhaWxlcgo8PAovSUQgCls8MzY1YmRmYTIyODlkYzBjZTdhNDgyZDQ0ZjA1NzFjZGQ+PDM2NWJkZmEyMjg5ZGMwY2U3YTQ4MmQ0NGYwNTcxY2RkPl0KJSBSZXBvcnRMYWIgZ2VuZXJhdGVkIFBERiBkb2N1bWVudCAtLSBkaWdlc3QgKG9wZW5zb3VyY2UpCgovSW5mbyA3IDAgUgovUm9vdCA2IDAgUgovU2l6ZSAxMAo+PgpzdGFydHhyZWYKMTU2MAolJUVPRgo='

async function writeFixtureFile(fileName, base64) {
  const targetPath = path.join(os.tmpdir(), fileName)
  await fs.writeFile(targetPath, Buffer.from(base64, 'base64'))
  return targetPath
}

async function readEditorSummary(page) {
  return page.evaluate(() => ({
    textContent: document.querySelector('[data-promptx-editor-content="tiptap"] .ProseMirror')?.textContent || '',
    imageCount: document.querySelectorAll('[data-promptx-node="image"]').length,
    importedCount: document.querySelectorAll('[data-promptx-node="imported_text"]').length,
    textCount: document.querySelectorAll('[data-promptx-node="text"]').length,
  }))
}

function buildLargeMixedBlocks() {
  const blocks = []

  for (let index = 0; index < 24; index += 1) {
    blocks.push({
      type: 'text',
      content: `第 ${index + 1} 段\n${'正文内容 '.repeat(18)}`,
    })

    if (index % 4 === 1) {
      blocks.push({
        type: 'imported_text',
        content: [
          `导入块 ${index + 1}`,
          `导入块 ${index + 1} 第二行`,
          `导入块 ${index + 1} 第三行`,
          `导入块 ${index + 1} 第四行`,
          `导入块 ${index + 1} 第五行`,
        ].join('\n'),
        meta: {
          fileName: `imported-${index + 1}.md`,
          collapsed: true,
        },
      })
    }
  }

  return blocks
}

test('Tiptap 原型支持图文混排、文本导入与 PDF 导入', async (t) => {
  const imagePath = await writeFixtureFile('promptx-tiptap-sample.png', SAMPLE_PNG_BASE64)
  const textPath = path.join(os.tmpdir(), 'promptx-tiptap-sample.txt')
  const pdfPath = await writeFixtureFile('promptx-tiptap-sample.pdf', SAMPLE_PDF_BASE64)
  await fs.writeFile(textPath, '导入内容\\n第二行')

  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap block editor',
    taskBlocks: [
      { type: 'text', content: '第一段' },
      { type: 'text', content: '第二段' },
    ],
  })

  t.after(async () => {
    await fs.rm(imagePath, { force: true })
    await fs.rm(textPath, { force: true })
    await fs.rm(pdfPath, { force: true })
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

    await page.locator('[data-promptx-editor-content="tiptap"] .ProseMirror').click()
    await page.keyboard.press('End')
    await page.keyboard.type(' 新增文本块验证')
    await page.waitForTimeout(300)

    await page.locator('input[type="file"]').setInputFiles(textPath)
    await page.waitForSelector('[data-promptx-node="imported_text"]', { timeout: 10000 })

    await page.locator('input[type="file"]').setInputFiles(imagePath)
    await page.waitForFunction(() => document.querySelectorAll('[data-promptx-node="image"]').length >= 1)

    const beforePdf = await readEditorSummary(page)
    await page.locator('input[type="file"]').setInputFiles(pdfPath)
    await page.waitForFunction(
      (prevImageCount, prevTextCount) => {
        const nextImageCount = document.querySelectorAll('[data-promptx-node="image"]').length
        const nextTextCount = document.querySelectorAll('[data-promptx-node="text"]').length
        return nextImageCount > prevImageCount || nextTextCount > prevTextCount
      },
      beforePdf.imageCount,
      beforePdf.textCount
    )

    const summary = await readEditorSummary(page)
    assert.match(summary.textContent, /第一段/)
    assert.match(summary.textContent, /新增文本块验证/)
    assert.match(summary.textContent, /导入文件/)
    assert.ok(summary.importedCount >= 1)
    assert.ok(summary.imageCount >= 1)
    assert.ok(summary.textCount >= 3)
  } finally {
    await browser.close()
  }
})

test('Tiptap 特殊块提供显式删除入口', async (t) => {
  const textPath = path.join(os.tmpdir(), 'promptx-tiptap-delete-imported.txt')
  await fs.writeFile(textPath, '导入后删除')

  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap explicit delete',
    taskBlocks: [
      { type: 'text', content: '第一段' },
    ],
  })

  t.after(async () => {
    await fs.rm(textPath, { force: true })
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
    await page.locator('input[type="file"]').setInputFiles(textPath)
    await page.waitForSelector('[data-promptx-node="imported_text"]', { timeout: 10000 })

    await page.locator('[data-promptx-node="imported_text"]').hover()
    await page.locator('[data-promptx-node="imported_text"]').getByRole('button', { name: '删除' }).click()
    await page.waitForTimeout(300)

    const importedCount = await page.evaluate(() => document.querySelectorAll('[data-promptx-node="imported_text"]').length)
    const textCount = await page.evaluate(() => document.querySelectorAll('[data-promptx-node="text"]').length)

    assert.equal(importedCount, 0)
    assert.ok(textCount >= 1)
  } finally {
    await browser.close()
  }
})

test('Tiptap 导入文本块展开后可看到完整内容', async (t) => {
  const textPath = path.join(os.tmpdir(), 'promptx-tiptap-expand-imported.txt')
  await fs.writeFile(textPath, ['第一行', '第二行', '最后一行完整内容'].join('\n'))

  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap imported expand',
    taskBlocks: [
      { type: 'text', content: '第一段' },
    ],
  })

  t.after(async () => {
    await fs.rm(textPath, { force: true })
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
    await page.locator('input[type="file"]').setInputFiles(textPath)
    const importedBlock = page.locator('[data-promptx-node="imported_text"]').first()
    await importedBlock.waitFor({ timeout: 10000 })

    const previewState = await importedBlock.locator('[data-promptx-imported-preview]').evaluate((element) => {
      const content = element.firstElementChild
      return {
        text: String(content?.textContent || ''),
        whiteSpace: content ? window.getComputedStyle(content).whiteSpace : '',
      }
    })
    assert.match(previewState.text, /第一行/)
    assert.match(previewState.text, /第二行/)
    assert.equal(previewState.whiteSpace, 'pre-wrap')

    await importedBlock.locator('[data-promptx-imported-preview]').click()
    await importedBlock.locator('[data-promptx-node-content="imported_text"]').getByText('最后一行完整内容').waitFor()
    await importedBlock.locator('[data-promptx-imported-meta]').click()
    await importedBlock.locator('[data-promptx-imported-actions] button').filter({ hasText: '展开' }).waitFor({ timeout: 10000 })
  } finally {
    await browser.close()
  }
})

test('Tiptap 长文档混排下输入与导入块展开保持稳定', async (t) => {
  const mixedBlocks = buildLargeMixedBlocks()
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap mixed long document',
    taskBlocks: mixedBlocks,
  })

  t.after(async () => {
    fixture.cleanup()
    await shutdownPromptxE2EStack()
  })

  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })

  try {
    await updateTaskViaApi(fixture.task.slug, {
      blocks: mixedBlocks,
    })

    await openWorkbenchTask(page, fixture.task.slug, { editor: 'tiptap' })
    const importedBlocks = page.locator('[data-promptx-node="imported_text"]')
    const textBlocks = page.locator('[data-promptx-node="text"]')
    await importedBlocks.first().waitFor({ timeout: 10000 })
    await textBlocks.last().scrollIntoViewIfNeeded()

    const expandStart = Date.now()
    await importedBlocks.nth(2).locator('[data-promptx-imported-preview]').click()
    await importedBlocks.nth(2).locator('[data-promptx-node-content="imported_text"]').getByText('导入块 10 第五行').waitFor()
    const expandDuration = Date.now() - expandStart

    const textCount = await textBlocks.count()
    const typeStart = Date.now()
    await focusTiptapBlock(page, { index: textCount - 1, position: 'end' })
    await page.keyboard.insertText(' 长文档压力输入')
    await page.waitForTimeout(250)
    const typeDuration = Date.now() - typeStart

    const selectionState = await readTiptapSelectionState(page)
    assert.ok(expandDuration < 4000, `长文档导入块展开耗时异常：${expandDuration}ms`)
    assert.ok(typeDuration < 4000, `长文档输入耗时异常：${typeDuration}ms`)
    assert.equal(selectionState.blockType, 'text')
    assert.match(selectionState.blockText, /长文档压力输入/)
  } finally {
    await browser.close()
  }
})

test('Tiptap 移动端工具栏紧凑排列且不横向溢出', async (t) => {
  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap mobile toolbar layout',
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      const nextState = {
        ...(window.history.state || {}),
        promptxWorkbenchMobileView: 'detail',
      }
      window.history.pushState(nextState, '')
      window.dispatchEvent(new PopStateEvent('popstate', { state: nextState }))
    })
    await page.getByRole('button', { name: '输入' }).click()

    const toolbarState = await page.locator('[data-promptx-editor-actions]').evaluate((element) => {
      const buttons = Array.from(element.querySelectorAll('button')).map((button) => {
        const rect = button.getBoundingClientRect()
        return {
          top: rect.top,
          width: rect.width,
        }
      })

      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        buttonCount: buttons.length,
        rowCount: new Set(buttons.map((button) => Math.round(button.top))).size,
      }
    })

    assert.equal(toolbarState.buttonCount, 5)
    assert.ok(toolbarState.scrollWidth <= toolbarState.clientWidth + 1, `移动端工具栏不应横向溢出：${JSON.stringify(toolbarState)}`)
    assert.ok(toolbarState.rowCount <= 1, `移动端工具栏应保持单行：${JSON.stringify(toolbarState)}`)
  } finally {
    await browser.close()
  }
})

test('Tiptap 导入块在移动端头部纵向排布且不横向溢出', async (t) => {
  const textPath = path.join(os.tmpdir(), 'promptx-mobile-imported-layout-very-long-file-name-for-check.txt')
  await fs.writeFile(textPath, '移动端导入块布局检查')

  const fixture = await createTranscriptFixture({
    taskTitle: 'E2E tiptap mobile imported layout',
    taskBlocks: [
      { type: 'text', content: '第一段' },
    ],
  })

  t.after(async () => {
    await fs.rm(textPath, { force: true })
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
    await page.setViewportSize({ width: 390, height: 844 })
    await page.evaluate(() => {
      const nextState = {
        ...(window.history.state || {}),
        promptxWorkbenchMobileView: 'detail',
      }
      window.history.pushState(nextState, '')
      window.dispatchEvent(new PopStateEvent('popstate', { state: nextState }))
    })
    await page.getByRole('button', { name: '输入' }).click()
    await page.locator('input[type="file"]').setInputFiles(textPath)

    const importedBlock = page.locator('[data-promptx-node="imported_text"]').first()
    await importedBlock.waitFor({ timeout: 10000 })

    const layout = await importedBlock.evaluate((element) => {
      const meta = element.querySelector('[data-promptx-imported-meta]')?.getBoundingClientRect()
      const actions = element.querySelector('[data-promptx-imported-actions]')?.getBoundingClientRect()
      const actionButtons = Array.from(element.querySelectorAll('[data-promptx-imported-actions] button')).map((button) => {
        const rect = button.getBoundingClientRect()
        return {
          top: rect.top,
          width: rect.width,
        }
      })
      return {
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        metaBottom: meta?.bottom || 0,
        actionsTop: actions?.top || 0,
        actionButtons,
      }
    })

    assert.ok(layout.actionsTop >= layout.metaBottom - 1, `移动端操作区应位于说明区下方：${JSON.stringify(layout)}`)
    assert.ok(layout.scrollWidth <= layout.clientWidth + 1, `移动端导入块不应横向溢出：${JSON.stringify(layout)}`)
    assert.equal(new Set(layout.actionButtons.map((button) => Math.round(button.top))).size, 1, `移动端操作按钮应保持单行：${JSON.stringify(layout)}`)
  } finally {
    await browser.close()
  }
})
