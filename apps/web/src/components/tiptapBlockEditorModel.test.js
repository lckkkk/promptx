import assert from 'node:assert/strict'
import test from 'node:test'
import { BLOCK_TYPES } from '@promptx/shared'
import {
  blocksToComparableSnapshot,
  blocksToTiptapDoc,
  normalizeBlocksWithAnchors,
  tiptapDocToBlocks,
} from './tiptapBlockEditorModel.js'

test('normalizeBlocksWithAnchors 会在非文本块两侧补充文本锚点', () => {
  const normalized = normalizeBlocksWithAnchors([
    { type: BLOCK_TYPES.IMAGE, content: 'https://example.com/a.jpg', meta: {} },
    { type: BLOCK_TYPES.IMPORTED_TEXT, content: '导入内容', meta: { fileName: 'a.txt', collapsed: true } },
  ])

  assert.deepEqual(
    normalized.map((block) => block.type),
    [BLOCK_TYPES.TEXT, BLOCK_TYPES.IMAGE, BLOCK_TYPES.TEXT, BLOCK_TYPES.IMPORTED_TEXT, BLOCK_TYPES.TEXT]
  )
})

test('blocks 与 tiptap 文档可以稳定双向转换', () => {
  const sourceBlocks = [
    { type: BLOCK_TYPES.TEXT, content: '第一段', meta: {} },
    { type: BLOCK_TYPES.IMAGE, content: 'https://example.com/demo.jpg', meta: {} },
    { type: BLOCK_TYPES.IMPORTED_TEXT, content: '导入内容\n第二行', meta: { fileName: 'demo.txt', collapsed: true } },
    { type: BLOCK_TYPES.TEXT, content: '最后一段', meta: {} },
  ]

  const restored = tiptapDocToBlocks(blocksToTiptapDoc(sourceBlocks))

  assert.deepEqual(
    restored.map((block) => ({
      type: block.type,
      content: block.content,
      fileName: block.meta?.fileName || '',
      collapsed: Boolean(block.meta?.collapsed),
    })),
    [
      { type: BLOCK_TYPES.TEXT, content: '第一段', fileName: '', collapsed: false },
      { type: BLOCK_TYPES.IMAGE, content: 'https://example.com/demo.jpg', fileName: '', collapsed: false },
      { type: BLOCK_TYPES.TEXT, content: '', fileName: '', collapsed: false },
      { type: BLOCK_TYPES.IMPORTED_TEXT, content: '导入内容\n第二行', fileName: 'demo.txt', collapsed: true },
      { type: BLOCK_TYPES.TEXT, content: '最后一段', fileName: '', collapsed: false },
    ]
  )
})

test('comparable snapshot 不受 clientId 变化影响', () => {
  const left = [
    { type: BLOCK_TYPES.TEXT, content: '同一段内容', clientId: 'block-a', meta: {} },
    { type: BLOCK_TYPES.IMPORTED_TEXT, content: '导入内容', clientId: 'block-b', meta: { fileName: 'a.txt', collapsed: true } },
  ]
  const right = [
    { type: BLOCK_TYPES.TEXT, content: '同一段内容', clientId: 'block-x', meta: {} },
    { type: BLOCK_TYPES.IMPORTED_TEXT, content: '导入内容', clientId: 'block-y', meta: { fileName: 'a.txt', collapsed: true } },
  ]

  assert.equal(
    blocksToComparableSnapshot(left),
    blocksToComparableSnapshot(right)
  )
})
