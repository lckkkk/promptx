const ANSI_OSC_PATTERN = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g
const ANSI_CSI_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g
const ANSI_ESCAPE_PATTERN = /\u001B[@-_]/g
const OTHER_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001A\u001C-\u001F\u007F]/g

function stripBackspaces(value = '') {
  let result = ''
  for (const char of String(value || '')) {
    if (char === '\b' || char === '\u007F') {
      result = result.slice(0, -1)
      continue
    }
    result += char
  }
  return result
}

export function sanitizeProcessDetailText(value = '') {
  return stripBackspaces(String(value || ''))
    .replace(ANSI_OSC_PATTERN, '')
    .replace(ANSI_CSI_PATTERN, '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(OTHER_CONTROL_PATTERN, '')
}

function normalizeText(value = '') {
  return sanitizeProcessDetailText(value)
}

function trimBoundaryBlankLines(value = '') {
  return String(value || '')
    .replace(/^(?:[ \t]*\n)+/, '')
    .replace(/(?:\n[ \t]*)+$/, '')
}

function limitItems(items = [], max = 12) {
  const list = Array.isArray(items) ? items : []
  if (list.length <= max) {
    return { items: list, hiddenCount: 0 }
  }

  return {
    items: list.slice(0, max),
    hiddenCount: list.length - max,
  }
}

function parseHeaderMeta(text = '') {
  const normalized = trimBoundaryBlankLines(normalizeText(text))
  if (!normalized.trim()) {
    return null
  }

  const lines = normalized.split('\n')
  const firstLine = String(lines[0] || '').trim()
  if (!firstLine) {
    return null
  }

  const matched = firstLine.match(/^([A-Za-z][A-Za-z0-9 _/-]{1,24}):\s*(.+)$/)
  if (!matched) {
    return null
  }

  const normalizedLabel = matched[1].trim().toLowerCase()
  const supportedLabels = new Set([
    'read',
    'grep',
    'glob',
    'find',
    'ls',
    'dir',
    'tree',
    'list',
    'path',
    'file',
    'command',
  ])
  if (!supportedLabels.has(normalizedLabel)) {
    return null
  }

  const rest = trimBoundaryBlankLines(lines.slice(1).join('\n'))
  return {
    meta: {
      type: 'meta',
      items: [
        {
          label: matched[1].trim(),
          value: matched[2].trim(),
        },
      ],
    },
    rest,
  }
}

function parseXmlDirectoryBlock(text = '', options = {}) {
  const normalized = trimBoundaryBlankLines(normalizeText(text))
  if (!normalized.trim() || !normalized.includes('<path>') || !normalized.includes('<entries>')) {
    return null
  }

  const pathMatch = normalized.match(/<path>([\s\S]*?)<\/path>/i)
  const typeMatch = normalized.match(/<type>([\s\S]*?)<\/type>/i)
  const entriesMatch = normalized.match(/<entries>([\s\S]*?)<\/entries>/i)

  if (!pathMatch && !entriesMatch) {
    return null
  }

  const rawEntries = String(entriesMatch?.[1] || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^\(\d+\s+entries?\)$/i.test(line))

  const { items, hiddenCount } = limitItems(rawEntries, options.maxItems ?? 12)
  return {
    type: 'directory_list',
    path: String(pathMatch?.[1] || '').trim(),
    entryType: String(typeMatch?.[1] || '').trim(),
    entries: items,
    totalCount: rawEntries.length,
    hiddenCount,
  }
}

function parseChecklistBlock(text = '', options = {}) {
  const normalized = trimBoundaryBlankLines(normalizeText(text))
  if (!normalized.trim()) {
    return null
  }

  const lines = normalized.split('\n').map((line) => line.trimEnd())
  const parsed = lines
    .map((line) => {
      const matched = line.match(/^\s*\[([ xX])\]\s+(.+)$/)
      if (!matched) {
        return null
      }

      return {
        completed: matched[1].toLowerCase() === 'x',
        text: matched[2].trim(),
      }
    })
    .filter(Boolean)

  if (!parsed.length || parsed.length < Math.ceil(lines.filter(Boolean).length * 0.6)) {
    return null
  }

  const { items, hiddenCount } = limitItems(parsed, options.maxItems ?? 12)
  return {
    type: 'checklist',
    items,
    totalCount: parsed.length,
    hiddenCount,
  }
}

function parseBulletListBlock(text = '', options = {}) {
  const normalized = trimBoundaryBlankLines(normalizeText(text))
  if (!normalized.trim()) {
    return null
  }

  const lines = normalized.split('\n')
  const parsed = lines
    .map((line) => {
      const matched = line.match(/^[-*]\s+(.+)$/)
      return matched ? matched[1].trim() : null
    })
    .filter(Boolean)

  if (parsed.length < 2 || parsed.length < Math.ceil(lines.filter(Boolean).length * 0.6)) {
    return null
  }

  const { items, hiddenCount } = limitItems(parsed, options.maxItems ?? 12)
  return {
    type: 'bullet_list',
    items,
    totalCount: parsed.length,
    hiddenCount,
  }
}

function createFallbackTextBlock(text = '', options = {}) {
  return {
    type: options.preferMarkdown ? 'markdown' : 'text',
    text,
  }
}

function mergeAdjacentTextBlocks(blocks = []) {
  return blocks.reduce((result, block) => {
    const previous = result[result.length - 1]
    if (
      previous
      && block
      && previous.type === block.type
      && ['text', 'markdown'].includes(block.type)
    ) {
      previous.text = `${previous.text}\n\n${block.text}`
      return result
    }

    result.push(block)
    return result
  }, [])
}

function parseMixedContentBlocks(text = '', options = {}) {
  const segments = String(text || '')
    .split(/\n{2,}/)
    .map((segment) => trimBoundaryBlankLines(segment))
    .filter((segment) => segment.trim())

  if (segments.length < 2) {
    return null
  }

  const parsed = mergeAdjacentTextBlocks(segments.flatMap((segment) => (
    parseProcessDetailTextBlocks(segment, { ...options, _disableMixedSegmentation: true })
  )))
  const hasStructuredBlock = parsed.some((block) => !['text', 'markdown'].includes(block?.type))
  const hasPlainBlock = parsed.some((block) => ['text', 'markdown'].includes(block?.type))
  return hasStructuredBlock && hasPlainBlock ? parsed : null
}

export function parseProcessDetailTextBlocks(value = '', options = {}) {
  const normalized = trimBoundaryBlankLines(normalizeText(value))
  if (!normalized.trim()) {
    return []
  }

  const header = parseHeaderMeta(normalized)
  if (header?.rest) {
    const innerBlocks = parseProcessDetailTextBlocks(header.rest, options)
    return [header.meta, ...(innerBlocks.length ? innerBlocks : [{ type: 'text', text: header.rest }])]
  }

  const directoryBlock = parseXmlDirectoryBlock(normalized, options)
  if (directoryBlock) {
    return [directoryBlock]
  }

  const checklistBlock = parseChecklistBlock(normalized, options)
  if (checklistBlock) {
    return [checklistBlock]
  }

  const bulletListBlock = parseBulletListBlock(normalized, options)
  if (bulletListBlock) {
    return [bulletListBlock]
  }

  if (!options._disableMixedSegmentation) {
    const mixedBlocks = parseMixedContentBlocks(normalized, options)
    if (mixedBlocks?.length) {
      return mixedBlocks
    }
  }

  return [createFallbackTextBlock(normalized, options)]
}
