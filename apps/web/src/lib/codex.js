import { BLOCK_TYPES, buildRawText } from '@promptx/shared'

export function hasImageBlocks(blocks = []) {
  return (blocks || []).some((block) => block.type === BLOCK_TYPES.IMAGE)
}

export function buildCodexPrompt(document, rawUrl) {
  const blocks = document?.blocks || []

  if (hasImageBlocks(blocks)) {
    return `请根据文档的内容处理，${rawUrl}`
  }

  return buildRawText(document).trim()
}
