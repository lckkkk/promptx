import { BLOCK_TYPES } from '@promptx/shared'

export const TIPTAP_NODE_TYPES = {
  DOC: 'doc',
  TEXT_BLOCK: 'paragraph',
  IMPORTED_TEXT_BLOCK: 'promptxImportedTextBlock',
  IMAGE_BLOCK: 'promptxImageBlock',
  TEXT: 'text',
  HARD_BREAK: 'hardBreak',
}

export function createBlockClientId() {
  return globalThis.crypto?.randomUUID?.() || `block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function withBlockIdentity(block = {}) {
  return {
    ...block,
    clientId: String(block?.clientId || block?.id || createBlockClientId()),
    meta: block?.meta ? { ...block.meta } : {},
  }
}

export function createTextBlock(content = '') {
  return withBlockIdentity({ type: BLOCK_TYPES.TEXT, content, meta: {} })
}

function isTextLikeBlock(block) {
  return block?.type === BLOCK_TYPES.TEXT || block?.type === BLOCK_TYPES.IMPORTED_TEXT
}

function isNonTextBlock(block) {
  return block && block.type !== BLOCK_TYPES.TEXT
}

export function normalizeBlocksWithAnchors(inputBlocks = []) {
  const source = Array.isArray(inputBlocks) ? inputBlocks.filter(Boolean) : []
  if (!source.length) {
    return [createTextBlock('')]
  }

  const normalized = []

  source.forEach((block, index) => {
    const normalizedBlock = withBlockIdentity(block)
    const previous = normalized[normalized.length - 1]
    if (!previous && isNonTextBlock(normalizedBlock)) {
      normalized.push(createTextBlock(''))
    }
    if (previous && isNonTextBlock(previous) && isNonTextBlock(normalizedBlock)) {
      normalized.push(createTextBlock(''))
    }
    normalized.push(normalizedBlock)

    if (index === source.length - 1 && isNonTextBlock(normalizedBlock)) {
      normalized.push(createTextBlock(''))
    }
  })

  return normalized
}

export function areBlocksEquivalent(left = [], right = []) {
  if (left === right) {
    return true
  }
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false
  }

  return left.every((block, index) => {
    const other = right[index]
    if (!other || block?.type !== other.type || block?.content !== other.content) {
      return false
    }

    return (block?.meta?.fileName || '') === (other.meta?.fileName || '')
      && Boolean(block?.meta?.collapsed) === Boolean(other?.meta?.collapsed)
  })
}

function textToInlineContent(text = '') {
  const lines = String(text || '').split('\n')
  const content = []

  lines.forEach((line, index) => {
    if (line) {
      content.push({
        type: TIPTAP_NODE_TYPES.TEXT,
        text: line,
      })
    }
    if (index < lines.length - 1) {
      content.push({ type: TIPTAP_NODE_TYPES.HARD_BREAK })
    }
  })

  return content
}

export function textToTiptapInlineContent(text = '') {
  return textToInlineContent(text)
}

function normalizeInlineNodeList(content = []) {
  if (Array.isArray(content)) {
    return content
  }

  if (typeof content?.toArray === 'function') {
    return content.toArray()
  }

  if (typeof content?.forEach === 'function') {
    const nodes = []
    content.forEach((node) => {
      nodes.push(node)
    })
    return nodes
  }

  return []
}

function inlineContentToText(content = []) {
  return normalizeInlineNodeList(content).map((node) => {
    const nodeType = typeof node?.type === 'string' ? node.type : node?.type?.name
    if (nodeType === TIPTAP_NODE_TYPES.TEXT) {
      return String(node.text || '')
    }
    if (nodeType === TIPTAP_NODE_TYPES.HARD_BREAK) {
      return '\n'
    }
    return inlineContentToText(node?.content || [])
  }).join('')
}

export function tiptapInlineContentToText(content = []) {
  return inlineContentToText(content)
}

function blockToTiptapNode(block = {}) {
  const normalized = withBlockIdentity(block)

  if (normalized.type === BLOCK_TYPES.IMAGE) {
    return {
      type: TIPTAP_NODE_TYPES.IMAGE_BLOCK,
      attrs: {
        clientId: normalized.clientId,
        src: String(normalized.content || ''),
      },
    }
  }

  if (normalized.type === BLOCK_TYPES.IMPORTED_TEXT) {
    return {
      type: TIPTAP_NODE_TYPES.IMPORTED_TEXT_BLOCK,
      attrs: {
        clientId: normalized.clientId,
        fileName: String(normalized.meta?.fileName || ''),
        collapsed: Boolean(normalized.meta?.collapsed),
      },
      content: textToInlineContent(normalized.content),
    }
  }

  return {
    type: TIPTAP_NODE_TYPES.TEXT_BLOCK,
    attrs: {
      clientId: normalized.clientId,
    },
    content: textToInlineContent(normalized.content),
  }
}

export function blocksToTiptapNodes(inputBlocks = []) {
  return normalizeBlocksWithAnchors(inputBlocks).map(blockToTiptapNode)
}

export function blocksToTiptapDoc(inputBlocks = []) {
  return {
    type: TIPTAP_NODE_TYPES.DOC,
    content: blocksToTiptapNodes(inputBlocks),
  }
}

function tiptapNodeToBlock(node = {}) {
  if (node?.type === TIPTAP_NODE_TYPES.IMAGE_BLOCK) {
    return withBlockIdentity({
      type: BLOCK_TYPES.IMAGE,
      content: String(node.attrs?.src || ''),
      clientId: String(node.attrs?.clientId || ''),
      meta: {},
    })
  }

  if (node?.type === TIPTAP_NODE_TYPES.IMPORTED_TEXT_BLOCK) {
    return withBlockIdentity({
      type: BLOCK_TYPES.IMPORTED_TEXT,
      content: inlineContentToText(node.content || []),
      clientId: String(node.attrs?.clientId || ''),
      meta: {
        fileName: String(node.attrs?.fileName || ''),
        collapsed: Boolean(node.attrs?.collapsed),
      },
    })
  }

  if (node?.type === TIPTAP_NODE_TYPES.TEXT_BLOCK) {
    return withBlockIdentity({
      type: BLOCK_TYPES.TEXT,
      content: inlineContentToText(node.content || []),
      clientId: String(node.attrs?.clientId || ''),
      meta: {},
    })
  }

  return null
}

export function tiptapDocToBlocks(doc = null) {
  const nodes = Array.isArray(doc?.content) ? doc.content : []
  const blocks = nodes.map(tiptapNodeToBlock).filter(Boolean)
  return normalizeBlocksWithAnchors(blocks)
}

export function blocksToComparableSnapshot(inputBlocks = []) {
  return JSON.stringify(normalizeBlocksWithAnchors(inputBlocks).map((block) => ({
    type: block?.type || '',
    content: String(block?.content || ''),
    meta: {
      fileName: String(block?.meta?.fileName || ''),
      collapsed: Boolean(block?.meta?.collapsed),
    },
  })))
}

export function getImportedStats(content = '') {
  const text = String(content)
  return {
    lines: text ? text.split('\n').length : 0,
    chars: text.length,
  }
}
