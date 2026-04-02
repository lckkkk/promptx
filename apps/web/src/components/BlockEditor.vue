<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  ChevronDown,
  FileText,
  Image as ImageIcon,
  Trash2,
} from 'lucide-vue-next'
import { BLOCK_TYPES } from '@promptx/shared'
import { useI18n } from '../composables/useI18n.js'
import { useMentionPicker } from '../composables/useMentionPicker.js'
import {
  computeScrollTopForTarget,
  getRelativeOffsetTop,
  isTargetVisibleInContainer,
} from './blockEditorScroll.js'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'
import PathMentionPicker from './PathMentionPicker.vue'

const props = defineProps({
  modelValue: {
    type: Array,
    required: true,
  },
  codexSessionId: {
    type: String,
    default: '',
  },
  uploading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'update:modelValue',
  'upload-files',
  'import-text-files',
  'import-pdf-files',
  'clear-request',
  'file-feedback',
])
const { t } = useI18n()

const TEXT_IMPORT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.vue',
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.conf',
  '.env',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.kt',
  '.swift',
  '.log',
  '.csv',
])
const TEXT_IMPORT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
])
const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024
const MAX_PDF_FILE_SIZE = 8 * 1024 * 1024
const FILE_INPUT_ACCEPT = [
  'image/*',
  '.md,.markdown,.txt,.js,.mjs,.cjs,.ts,.mts,.cts,.jsx,.tsx,.vue,.json,.css,.scss,.sass,.less,.html,.htm,.xml,.svg,.yml,.yaml,.toml,.ini,.conf,.env,.py,.java,.go,.rs,.rb,.php,.sh,.bash,.zsh,.sql,.c,.cc,.cpp,.h,.hpp,.cs,.kt,.swift,.log,.csv',
  '.pdf',
  'text/plain',
  'text/markdown',
  'text/*',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
  'application/pdf',
].join(',')

const blocks = computed(() => props.modelValue)
const mentionSessionId = computed(() => props.codexSessionId)
const activeIndex = ref(0)
const textareas = ref([])
const textDraftValueMap = ref({})
const composingBlockIndex = ref(-1)
const focusedBlockIndex = ref(-1)
const surfaceRef = ref(null)
const contentRef = ref(null)
const contentBodyRef = ref(null)
const fileInputRef = ref(null)
const mentionPickerRef = ref(null)
const selectionMap = ref({})
const previewImageUrl = ref('')
const lastInputAt = ref(0)
const EDITING_GRACE_PERIOD_MS = 1500
const focusFollowTargetIndex = ref(-1)
const focusFollowAlign = ref('nearest')
const focusFollowMode = ref('visible')
const focusFollowAnchorOffset = ref(null)

let focusFollowResetTimer = null
let contentResizeObserver = null
let queuedFocusFollowFrame = 0
let suppressScrollHandlingUntil = 0

const {
  mentionState,
  mentionAnchorRect,
  applyMentionSelection,
  closeMentionPicker,
  dismissMentionPicker,
  handleTextFocus,
  openPathPickerFromShortcut,
  recordSelection,
  syncMentionState,
  updateMentionAnchor,
} = useMentionPicker({
  activeIndex,
  blocks,
  isTextLikeBlock,
  placeCursor,
  resizeAllTextareas,
  selectionMap,
  sessionId: mentionSessionId,
  setBlocks,
  textareas,
})

const previewImages = computed(() => (
  blocks.value
    .filter((block) => block?.type === BLOCK_TYPES.IMAGE && String(block.content || '').trim())
    .map((block) => String(block.content || '').trim())
))

function isCursorTextBlock(block) {
  return block?.type === BLOCK_TYPES.TEXT
}

function isTextLikeBlock(block) {
  return block?.type === BLOCK_TYPES.TEXT || block?.type === BLOCK_TYPES.IMPORTED_TEXT
}

function isNonTextBlock(block) {
  return block && block.type !== BLOCK_TYPES.TEXT
}

function createBlockClientId() {
  return globalThis.crypto?.randomUUID?.() || `block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function withBlockIdentity(block = {}) {
  return {
    ...block,
    clientId: String(block?.clientId || block?.id || createBlockClientId()),
    meta: block?.meta ? { ...block.meta } : {},
  }
}

function createTextBlock(content = '') {
  return withBlockIdentity({ type: BLOCK_TYPES.TEXT, content, meta: {} })
}

function normalizeBlocksWithAnchors(inputBlocks = []) {
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

function areBlocksEquivalent(left = [], right = []) {
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
      && Boolean(block?.meta?.collapsed) === Boolean(other.meta?.collapsed)
  })
}

function setBlocks(nextBlocks) {
  emit('update:modelValue', normalizeBlocksWithAnchors(nextBlocks))
}

function getTextDraftKey(block = {}, index = -1) {
  return String(block?.clientId || block?.id || `text-${index}`)
}

function setTextDraftValue(index, value = '', block = blocks.value[index]) {
  const key = getTextDraftKey(block, index)
  textDraftValueMap.value = {
    ...textDraftValueMap.value,
    [key]: String(value ?? ''),
  }
}

function getTextDraftValue(block = {}, index = -1) {
  const key = getTextDraftKey(block, index)
  if (Object.prototype.hasOwnProperty.call(textDraftValueMap.value, key)) {
    return textDraftValueMap.value[key]
  }

  return String(block?.content || '')
}

function syncTextDraftValues(nextBlocks = []) {
  const normalizedBlocks = Array.isArray(nextBlocks) ? nextBlocks : []
  const nextDraftMap = {}

  normalizedBlocks.forEach((block, index) => {
    if (!isTextLikeBlock(block)) {
      return
    }

    const key = getTextDraftKey(block, index)
    const element = textareas.value[index]
    if (isComposing(index) && element) {
      nextDraftMap[key] = String(element.value || '')
      return
    }

    nextDraftMap[key] = String(block?.content || '')
  })

  textDraftValueMap.value = nextDraftMap
}

function setTextRef(element, index) {
  if (element) {
    if (textareas.value[index] === element) {
      return
    }
    textareas.value[index] = element
    element.value = getTextDraftValue(blocks.value[index], index)
    resizeTextarea(element)
    return
  }
  textareas.value[index] = null
}

function resizeTextarea(element, options = {}) {
  if (!element) {
    return
  }

  const {
    allowShrink = true,
    preserveContainerScroll = true,
    preserveViewport = true,
    preserveSelection = true,
  } = options
  const container = contentRef.value
  const containerScrollTop = preserveContainerScroll && container
    ? container.scrollTop
    : null
  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const selectionStart = element.selectionStart
  const selectionEnd = element.selectionEnd
  const isActive = document.activeElement === element
  const currentHeight = Number.parseFloat(element.style.height) || element.offsetHeight || 40

  if (allowShrink) {
    element.style.height = 'auto'
    element.style.height = `${Math.max(element.scrollHeight, 40)}px`
  } else {
    element.style.height = `${Math.max(currentHeight, element.scrollHeight, 40)}px`
  }

  if (preserveSelection && isActive && selectionStart !== null && selectionEnd !== null) {
    element.setSelectionRange(selectionStart, selectionEnd)
  }
  if (container && containerScrollTop !== null && Math.abs(container.scrollTop - containerScrollTop) >= 1) {
    container.scrollTop = containerScrollTop
  }
  if (preserveViewport && (window.scrollX !== scrollX || window.scrollY !== scrollY)) {
    window.scrollTo(scrollX, scrollY)
  }
}

function resizeAllTextareas() {
  textareas.value.forEach((element) => resizeTextarea(element))
}

function handleContentScroll() {
  if (Date.now() <= suppressScrollHandlingUntil) {
    return
  }

  const targetIndex = focusFollowTargetIndex.value
  if (targetIndex < 0 || isTextBlockVisible(targetIndex)) {
    return
  }

  stopFocusFollow()
}

function clearFocusFollowResetTimer() {
  if (focusFollowResetTimer) {
    window.clearTimeout(focusFollowResetTimer)
    focusFollowResetTimer = null
  }
}

function stopFocusFollow() {
  focusFollowTargetIndex.value = -1
  focusFollowAlign.value = 'nearest'
  focusFollowMode.value = 'visible'
  focusFollowAnchorOffset.value = null
  clearFocusFollowResetTimer()
  if (queuedFocusFollowFrame) {
    window.cancelAnimationFrame?.(queuedFocusFollowFrame)
    queuedFocusFollowFrame = 0
  }
}

function scheduleFocusFollowReset(duration = 8000) {
  clearFocusFollowResetTimer()
  const timeoutMs = Math.max(0, Number(duration) || 0)
  if (!timeoutMs) {
    return
  }

  focusFollowResetTimer = window.setTimeout(() => {
    stopFocusFollow()
  }, timeoutMs)
}

function disconnectContentResizeObserver() {
  if (!contentResizeObserver) {
    return
  }

  contentResizeObserver.disconnect()
  contentResizeObserver = null
}

function setContentScrollTop(nextScrollTop) {
  const container = contentRef.value
  if (!container) {
    return
  }

  const normalizedScrollTop = Math.max(0, Number(nextScrollTop) || 0)
  if (Math.abs(container.scrollTop - normalizedScrollTop) < 1) {
    return
  }

  suppressScrollHandlingUntil = Date.now() + 120
  container.scrollTop = normalizedScrollTop
}

function isTextBlockVisible(index, options = {}) {
  const container = contentRef.value
  const target = textareas.value[index]
  if (!container || !target) {
    return false
  }

  return isTargetVisibleInContainer({
    containerScrollTop: container.scrollTop,
    containerClientHeight: container.clientHeight,
    targetTop: getRelativeOffsetTop(target, container),
    targetHeight: target.offsetHeight,
    padding: options.padding,
  })
}

function getFocusFollowPreserveThreshold() {
  const container = contentRef.value
  if (!container) {
    return 120
  }

  return Math.max(120, Math.round(container.clientHeight * 0.2))
}

function captureTextareaViewportOffset(index) {
  const container = contentRef.value
  const target = textareas.value[index]
  if (!container || !target) {
    return null
  }

  return getRelativeOffsetTop(target, container) - container.scrollTop
}

function captureFocusFollowAnchor(index) {
  const offset = captureTextareaViewportOffset(index)
  if (offset === null) {
    return null
  }

  return {
    mode: 'preserve',
    anchorOffset: offset,
  }
}

function ensureFocusFollowVisible() {
  const targetTextIndex = focusFollowTargetIndex.value
  if (targetTextIndex < 0) {
    return
  }

  const container = contentRef.value
  const target = textareas.value[targetTextIndex]
  if (!container || !target) {
    return
  }

  if (focusFollowMode.value === 'preserve' && focusFollowAnchorOffset.value !== null) {
    const targetTop = getRelativeOffsetTop(target, container)
    const currentOffset = targetTop - container.scrollTop
    const expectedOffset = Number(focusFollowAnchorOffset.value) || 0
    const shiftDistance = Math.abs(currentOffset - expectedOffset)

    if (shiftDistance <= getFocusFollowPreserveThreshold()) {
      setContentScrollTop(targetTop - expectedOffset)
      return
    }
  }

  scrollTextBlockIntoView(targetTextIndex, { align: focusFollowAlign.value || 'nearest' })
}

function queueEnsureFocusFollowVisible() {
  if (focusFollowTargetIndex.value < 0) {
    return
  }

  nextTick(() => {
    ensureFocusFollowVisible()
    if (queuedFocusFollowFrame) {
      window.cancelAnimationFrame?.(queuedFocusFollowFrame)
    }
    queuedFocusFollowFrame = window.requestAnimationFrame?.(() => {
      queuedFocusFollowFrame = 0
      ensureFocusFollowVisible()
    }) || 0
  })
}

function startFocusFollow(index, options = {}) {
  const nextIndex = Math.max(-1, Number(index) || -1)
  if (nextIndex < 0) {
    stopFocusFollow()
    return
  }

  focusFollowTargetIndex.value = nextIndex
  focusFollowAlign.value = options.align === 'end' ? 'end' : 'nearest'
  focusFollowMode.value = options.mode === 'preserve' ? 'preserve' : 'visible'
  focusFollowAnchorOffset.value = typeof options.anchorOffset === 'number'
    ? options.anchorOffset
    : null
  scheduleFocusFollowReset(options.duration)
  queueEnsureFocusFollowVisible()
}

function connectContentResizeObserver(element) {
  disconnectContentResizeObserver()
  if (!element || typeof window === 'undefined' || typeof window.ResizeObserver === 'undefined') {
    return
  }

  contentResizeObserver = new window.ResizeObserver(() => {
    if (focusFollowTargetIndex.value >= 0) {
      queueEnsureFocusFollowVisible()
    }
  })

  contentResizeObserver.observe(element)
}

function scrollTextBlockIntoView(index, options = {}) {
  const target = textareas.value[index]
  if (!target) {
    return
  }

  const { align = 'nearest' } = options
  const container = contentRef.value

  if (!container) {
    target.scrollIntoView({
      block: align === 'end' ? 'end' : 'nearest',
      inline: 'nearest',
    })
    return
  }

  const nextScrollTop = computeScrollTopForTarget({
    containerScrollTop: container.scrollTop,
    containerClientHeight: container.clientHeight,
    targetTop: getRelativeOffsetTop(target, container),
    targetHeight: target.offsetHeight,
    align,
  })

  if (nextScrollTop !== container.scrollTop) {
    setContentScrollTop(nextScrollTop)
  }
}

function placeCursor(index, position = null, options = {}) {
  const target = textareas.value[index]
  if (!target) {
    return
  }
  const nextPosition = position ?? target.value.length
  try {
    target.focus({ preventScroll: true })
  } catch {
    target.focus()
  }
  target.setSelectionRange(nextPosition, nextPosition)
  scrollTextBlockIntoView(index, options)
  if (options.follow !== false) {
    startFocusFollow(index, {
      align: options.align,
      mode: options.followMode,
      anchorOffset: options.followAnchorOffset,
      duration: options.followDuration,
    })
  }
  selectionMap.value[index] = {
    start: nextPosition,
    end: nextPosition,
  }
}

function updateText(index, content) {
  lastInputAt.value = Date.now()
  setTextDraftValue(index, content)
  const nextBlocks = blocks.value.map((block, itemIndex) =>
    itemIndex === index ? { ...block, content } : block
  )
  setBlocks(nextBlocks)
}

function syncTextareaValueToBlock(index, value = '') {
  const current = blocks.value[index]
  if (!isTextLikeBlock(current)) {
    return false
  }

  const nextContent = String(value ?? '')
  setTextDraftValue(index, nextContent, current)
  if (nextContent === current.content) {
    return false
  }

  const nextBlocks = [...blocks.value]
  nextBlocks.splice(index, 1, {
    ...current,
    content: nextContent,
  })
  setBlocks(nextBlocks)
  return true
}

function flushPendingInput() {
  let changed = false

  textareas.value.forEach((element, index) => {
    if (!element) {
      return
    }

    changed = syncTextareaValueToBlock(index, element.value) || changed
  })

  return changed
}

function isComposing(index = null) {
  if (typeof index === 'number') {
    return composingBlockIndex.value === index
  }

  return composingBlockIndex.value >= 0
}

function toggleImportedCollapse(index) {
  const nextBlocks = blocks.value.map((block, itemIndex) =>
    itemIndex === index
      ? {
          ...block,
          meta: {
            ...block.meta,
            collapsed: !block.meta?.collapsed,
          },
        }
      : block
  )
  setBlocks(nextBlocks)
}

function convertImportedToText(index) {
  const current = blocks.value[index]
  if (!current || current.type !== BLOCK_TYPES.IMPORTED_TEXT) {
    return
  }

  const nextBlocks = blocks.value.map((block, itemIndex) =>
    itemIndex === index
      ? {
          type: BLOCK_TYPES.TEXT,
          content: block.content,
          meta: {},
        }
      : block
  )
  setBlocks(nextBlocks)
  activeIndex.value = index
  nextTick(() => placeCursor(index, 0))
}

function removeBlock(index) {
  const current = blocks.value[index]
  if (current?.type === BLOCK_TYPES.TEXT && blocks.value.length === 1) {
    setBlocks([{ ...current, content: '' }])
    nextTick(() => placeCursor(0, 0))
    return
  }

  const nextBlocks = blocks.value.filter((_, itemIndex) => itemIndex !== index)
  setBlocks(nextBlocks)
  nextTick(() => {
    const nextIndex = Math.max(0, Math.min(index, nextBlocks.length - 1))
    if (blocks.value[nextIndex]?.type === BLOCK_TYPES.TEXT) {
      placeCursor(nextIndex, 0)
    }
  })
}

function clearContent() {
  setBlocks([createTextBlock('')])
  activeIndex.value = 0
  selectionMap.value = {
    0: { start: 0, end: 0 },
  }
  nextTick(() => placeCursor(0, 0))
}

function getImportedPreview(content = '', max = 180) {
  const compact = String(content).replace(/\s+/g, ' ').trim()
  return compact.slice(0, max)
}

function getImportedStats(content = '') {
  const text = String(content)
  const lines = text ? text.split('\n').length : 0
  const chars = text.length
  return t('blockEditor.stats', { lines, chars })
}

function splitTextBlockForInsertion(currentIndex, incomingBlocks, options = {}) {
  const { focusAfterInserted = false } = options
  const followAnchor = focusAfterInserted ? captureFocusFollowAnchor(currentIndex) : null
  const nextBlocks = [...blocks.value]
  const currentBlock = nextBlocks[currentIndex]
  const selection = selectionMap.value[currentIndex] || {
    start: currentBlock.content.length,
    end: currentBlock.content.length,
  }
  const start = Math.max(0, selection.start ?? 0)
  const end = Math.max(start, selection.end ?? start)
  const before = currentBlock.content.slice(0, start)
  const after = currentBlock.content.slice(end)

  const replacement = []
  if (before) {
    replacement.push({ ...currentBlock, content: before })
  }
  replacement.push(...incomingBlocks)
  if (after) {
    replacement.push(createTextBlock(after))
  }

  nextBlocks.splice(currentIndex, 1, ...replacement)
  setBlocks(nextBlocks)

  nextTick(() => {
    const textSearchStart = focusAfterInserted
      ? currentIndex + replacement.length - (after ? 1 : 0)
      : currentIndex
    const nextTextIndex = blocks.value.findIndex(
      (block, index) => index >= textSearchStart && block.type === BLOCK_TYPES.TEXT
    )
    if (nextTextIndex >= 0) {
      activeIndex.value = nextTextIndex
      placeCursor(nextTextIndex, 0, {
        align: 'nearest',
        followMode: followAnchor?.mode,
        followAnchorOffset: followAnchor?.anchorOffset,
      })
    }
  })
}

function insertBlocksAtSelection(incomingBlocks, options = {}) {
  const { focusAfterInserted = false } = options
  if (!incomingBlocks.length) {
    return
  }

  const currentIndex = Math.min(activeIndex.value ?? 0, Math.max(blocks.value.length - 1, 0))
  const currentBlock = blocks.value[currentIndex]
  const followAnchor = focusAfterInserted ? captureFocusFollowAnchor(currentIndex) : null

  if (!currentBlock || currentBlock.type === BLOCK_TYPES.IMPORTED_TEXT) {
    const nextBlocks = [...blocks.value]
    const insertionIndex = currentIndex + 1
    nextBlocks.splice(insertionIndex, 0, ...incomingBlocks)
    setBlocks(nextBlocks)
    if (focusAfterInserted) {
      nextTick(() => {
        const nextTextIndex = blocks.value.findIndex(
          (block, index) => index >= insertionIndex + incomingBlocks.length && block.type === BLOCK_TYPES.TEXT
        )
        if (nextTextIndex >= 0) {
          activeIndex.value = nextTextIndex
          placeCursor(nextTextIndex, 0, {
            align: 'nearest',
            followMode: followAnchor?.mode,
            followAnchorOffset: followAnchor?.anchorOffset,
          })
        }
      })
    }
    return
  }

  if (!isCursorTextBlock(currentBlock)) {
    const nextBlocks = [...blocks.value]
    const insertionIndex = nextBlocks.length ? currentIndex + 1 : 0
    nextBlocks.splice(insertionIndex, 0, ...incomingBlocks)
    setBlocks(nextBlocks)
    if (focusAfterInserted) {
      nextTick(() => {
        const nextTextIndex = blocks.value.findIndex(
          (block, index) => index >= insertionIndex + incomingBlocks.length && block.type === BLOCK_TYPES.TEXT
        )
        if (nextTextIndex >= 0) {
          activeIndex.value = nextTextIndex
          placeCursor(nextTextIndex, 0, {
            align: 'nearest',
            followMode: followAnchor?.mode,
            followAnchorOffset: followAnchor?.anchorOffset,
          })
        }
      })
    }
    return
  }

  splitTextBlockForInsertion(currentIndex, incomingBlocks, { focusAfterInserted })
}

function insertTextAtSelection(text) {
  const content = String(text || '')
  if (!content) {
    return
  }

  const currentIndex = Math.min(activeIndex.value ?? 0, Math.max(blocks.value.length - 1, 0))
  const currentBlock = blocks.value[currentIndex]
  if (!currentBlock || !isTextLikeBlock(currentBlock)) {
    insertBlocksAtSelection([createTextBlock(content)])
    return
  }

  const selection = selectionMap.value[currentIndex] || {
    start: currentBlock.content.length,
    end: currentBlock.content.length,
  }
  const start = Math.max(0, selection.start ?? 0)
  const end = Math.max(start, selection.end ?? start)
  const nextContent = `${currentBlock.content.slice(0, start)}${content}${currentBlock.content.slice(end)}`
  const nextBlocks = [...blocks.value]
  nextBlocks.splice(currentIndex, 1, { ...currentBlock, content: nextContent })
  setBlocks(nextBlocks)
  nextTick(() => placeCursor(currentIndex, start + content.length))
}

function insertUploadedBlocks(imageBlocks) {
  insertBlocksAtSelection(imageBlocks, { focusAfterInserted: true })
}

function insertBlocks(blocksToInsert) {
  insertBlocksAtSelection(blocksToInsert, { focusAfterInserted: true })
}

function insertImportedBlocks(importedBlocks) {
  insertBlocksAtSelection(importedBlocks, { focusAfterInserted: true })
}

function mergeTextBlocks(currentIndex, targetIndex) {
  const currentBlock = blocks.value[currentIndex]
  const targetBlock = blocks.value[targetIndex]
  if (!isTextLikeBlock(currentBlock) || !isTextLikeBlock(targetBlock)) {
    return
  }

  const mergedContent =
    targetIndex < currentIndex
      ? `${targetBlock.content}${currentBlock.content}`
      : `${currentBlock.content}${targetBlock.content}`

  const nextBlocks = [...blocks.value]
  const keepIndex = Math.min(currentIndex, targetIndex)
  const removeIndex = Math.max(currentIndex, targetIndex)
  nextBlocks.splice(keepIndex, 1, {
    ...nextBlocks[keepIndex],
    content: mergedContent,
  })
  nextBlocks.splice(removeIndex, 1)
  setBlocks(nextBlocks)

  const cursorPosition = targetIndex < currentIndex ? targetBlock.content.length : currentBlock.content.length
  activeIndex.value = keepIndex
  nextTick(() => placeCursor(keepIndex, cursorPosition))
}

function removeNonTextNeighbor(textIndex, blockIndex, cursorPosition = 0) {
  const nextBlocks = blocks.value.filter((_, itemIndex) => itemIndex !== blockIndex)
  setBlocks(nextBlocks)
  const nextIndex = blockIndex < textIndex ? textIndex - 1 : textIndex
  activeIndex.value = nextIndex
  nextTick(() => placeCursor(nextIndex, cursorPosition))
}

function focusAfterImage(index) {
  const nextTextIndex = blocks.value.findIndex(
    (block, itemIndex) => itemIndex > index && block.type === BLOCK_TYPES.TEXT
  )
  if (nextTextIndex >= 0) {
    activeIndex.value = nextTextIndex
    nextTick(() => placeCursor(nextTextIndex, 0))
  }
}

function openImagePreview(url) {
  const value = String(url || '').trim()
  if (!value) {
    return
  }
  previewImageUrl.value = value
}

function insertImages(files) {
  const imageFiles = [...files].filter((file) => file && file.type.startsWith('image/'))
  if (imageFiles.length) {
    emit('upload-files', imageFiles)
  }
}

function getFileExtension(file) {
  const name = String(file?.name || '').trim().toLowerCase()
  if (!name.includes('.')) {
    return ''
  }

  return `.${name.split('.').pop()}`
}

function getDisplayFileName(file, fallbackLabel) {
  return String(file?.name || '').trim() || t(fallbackLabel)
}

function formatFileSize(bytes) {
  const normalized = Math.max(0, Number(bytes) || 0)
  if (normalized >= 1024 * 1024) {
    return `${(normalized / (1024 * 1024)).toFixed(normalized >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  }
  if (normalized >= 1024) {
    return `${Math.round(normalized / 1024)} KB`
  }
  return `${normalized} B`
}

function isTextImportFile(file) {
  if (!file) {
    return false
  }
  const type = String(file.type || '').toLowerCase()
  const extension = getFileExtension(file)
  return type.startsWith('text/') || TEXT_IMPORT_EXTENSIONS.has(extension) || TEXT_IMPORT_MIME_TYPES.has(type)
}

function isPdfImportFile(file) {
  if (!file) {
    return false
  }
  const name = String(file.name || '').toLowerCase()
  const type = String(file.type || '').toLowerCase()
  return name.endsWith('.pdf') || type === 'application/pdf'
}

function splitIncomingFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean)
  const accepted = {
    imageFiles: [],
    textFiles: [],
    pdfFiles: [],
  }
  const unsupportedFiles = []
  const oversizedFiles = []

  files.forEach((file) => {
    if (file.type.startsWith('image/')) {
      if (file.size > MAX_IMAGE_FILE_SIZE) {
        oversizedFiles.push({
          name: getDisplayFileName(file, 'blockEditor.unnamedImage'),
          limit: formatFileSize(MAX_IMAGE_FILE_SIZE),
        })
        return
      }
      accepted.imageFiles.push(file)
      return
    }

    if (isPdfImportFile(file)) {
      if (file.size > MAX_PDF_FILE_SIZE) {
        oversizedFiles.push({
          name: getDisplayFileName(file, 'blockEditor.unnamedPdf'),
          limit: formatFileSize(MAX_PDF_FILE_SIZE),
        })
        return
      }
      accepted.pdfFiles.push(file)
      return
    }

    if (isTextImportFile(file)) {
      if (file.size > MAX_TEXT_FILE_SIZE) {
        oversizedFiles.push({
          name: getDisplayFileName(file, 'blockEditor.unnamedFile'),
          limit: formatFileSize(MAX_TEXT_FILE_SIZE),
        })
        return
      }
      accepted.textFiles.push(file)
      return
    }

    unsupportedFiles.push(getDisplayFileName(file, 'blockEditor.unnamedFile'))
  })

  return {
    ...accepted,
    unsupportedFiles,
    oversizedFiles,
  }
}

function emitFileFeedback(message) {
  const text = String(message || '').trim()
  if (!text) {
    return
  }

  emit('file-feedback', text)
}

function notifyRejectedFiles({ unsupportedFiles = [], oversizedFiles = [] } = {}) {
  if (unsupportedFiles.length) {
    emitFileFeedback(t('blockEditor.unsupportedFiles', {
      names: unsupportedFiles.slice(0, 3).join('、'),
      extra: Math.max(0, unsupportedFiles.length - 3),
    }))
  }

  if (oversizedFiles.length) {
    emitFileFeedback(t('blockEditor.oversizedFiles', {
      names: oversizedFiles.slice(0, 2).map((item) => item.name).join('、'),
      extra: Math.max(0, oversizedFiles.length - 2),
      limit: oversizedFiles[0]?.limit || '',
    }))
  }
}

function dispatchIncomingFiles(fileList) {
  const {
    imageFiles,
    textFiles,
    pdfFiles,
    unsupportedFiles,
    oversizedFiles,
  } = splitIncomingFiles(fileList)

  notifyRejectedFiles({ unsupportedFiles, oversizedFiles })

  if (textFiles.length) {
    emit('import-text-files', textFiles)
  }
  if (pdfFiles.length) {
    emit('import-pdf-files', pdfFiles)
  }
  if (imageFiles.length) {
    insertImages(imageFiles)
  }

  return imageFiles.length + textFiles.length + pdfFiles.length > 0
}

function handleSurfacePaste(event) {
  const files = [...event.clipboardData.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean)

  if (!files.length) {
    return
  }

  event.preventDefault()
  dispatchIncomingFiles(files)
}

function handleSurfaceDrop(event) {
  event.preventDefault()
  dispatchIncomingFiles(event.dataTransfer.files)
}

function handleFileInput(event) {
  dispatchIncomingFiles(event.target.files)
  event.target.value = ''
}

function openFilePicker() {
  fileInputRef.value?.click()
}

function isEditorInteractiveTarget(target) {
  return Boolean(target?.closest?.('textarea,button,input,select,option,label,a,[contenteditable="true"]'))
}

function findNearestTextareaIndex(clientY = 0) {
  const candidates = textareas.value
    .map((element, index) => ({ element, index }))
    .filter((item) => item.element)

  if (!candidates.length) {
    return -1
  }

  const nearest = candidates.reduce((best, item) => {
    const rect = item.element.getBoundingClientRect()
    const centerY = rect.top + (rect.height / 2)
    const distance = Math.abs(clientY - centerY)
    if (!best || distance < best.distance) {
      return { index: item.index, distance }
    }
    return best
  }, null)

  return nearest?.index ?? -1
}

function findNearestTextIndexFromActive() {
  if (!Array.isArray(blocks.value) || !blocks.value.length) {
    return -1
  }

  const currentIndex = Math.max(0, Math.min(activeIndex.value ?? 0, blocks.value.length - 1))
  if (textareas.value[currentIndex]) {
    return currentIndex
  }

  let bestIndex = -1
  let bestDistance = Number.POSITIVE_INFINITY

  textareas.value.forEach((element, index) => {
    if (!element) {
      return
    }
    const distance = Math.abs(index - currentIndex)
    if (distance < bestDistance || (distance === bestDistance && index > currentIndex)) {
      bestIndex = index
      bestDistance = distance
    }
  })

  return bestIndex
}

function focusNearestTextInput(clientY = 0, options = {}) {
  const { preferActive = false } = options
  const nearestIndex = preferActive
    ? findNearestTextIndexFromActive()
    : findNearestTextareaIndex(clientY)
  if (nearestIndex < 0) {
    return
  }

  closeMentionPicker()
  activeIndex.value = nearestIndex
  nextTick(() => {
    const target = textareas.value[nearestIndex]
    const nextPosition = clientY <= (target?.getBoundingClientRect?.().top ?? 0)
      ? 0
      : (target?.value?.length || 0)
    placeCursor(nearestIndex, nextPosition)
  })
}

function handleSurfaceClick(event) {
  if (isEditorInteractiveTarget(event.target)) {
    return
  }

  if (!surfaceRef.value?.contains?.(event.target)) {
    return
  }

  focusNearestTextInput(event.clientY || 0, { preferActive: true })
}

function handleTextInput(index, event) {
  if (event?.isComposing || isComposing(index)) {
    resizeTextarea(event.target, {
      allowShrink: false,
      preserveSelection: false,
      preserveViewport: false,
    })
    syncMentionState(index, event.target)
    return
  }

  lastInputAt.value = Date.now()
  const mentionActive = mentionState.value.open && mentionState.value.blockIndex === index
  resizeTextarea(event.target, mentionActive
    ? {
        allowShrink: false,
        preserveViewport: false,
        preserveSelection: false,
      }
    : undefined)
  syncMentionState(index, event.target)
  startFocusFollow(index, {
    align: index === blocks.value.length - 1 ? 'end' : 'nearest',
  })
}

function handleTextCompositionStart(index) {
  composingBlockIndex.value = index
  focusedBlockIndex.value = index
  lastInputAt.value = Date.now()
}

function handleTextCompositionUpdate(index, event) {
  lastInputAt.value = Date.now()
  resizeTextarea(event.target, {
    allowShrink: false,
    preserveSelection: false,
    preserveViewport: false,
  })
  syncMentionState(index, event.target)
}

function handleTextCompositionEnd(index, event) {
  lastInputAt.value = Date.now()
  setTextDraftValue(index, event.target.value)
  composingBlockIndex.value = -1
  syncTextareaValueToBlock(index, event.target.value)
  handleTextInput(index, event)
}

function handleTextModelInput(index, event) {
  if (event?.isComposing || isComposing(index)) {
    handleTextInput(index, event)
    return
  }

  setTextDraftValue(index, event.target.value)
  updateText(index, event.target.value)
  handleTextInput(index, event)
}

function handleTextFocusState(index) {
  focusedBlockIndex.value = index
  if (!isTextBlockVisible(index, { padding: 0 })) {
    scrollTextBlockIntoView(index, { align: 'nearest' })
  }
}

function handleTextBlurState(index) {
  if (focusedBlockIndex.value === index) {
    focusedBlockIndex.value = -1
  }
  if (!isComposing(index) && focusFollowTargetIndex.value === index) {
    stopFocusFollow()
  }
}

async function handleTextKeydown(index, event) {
  const current = blocks.value[index]
  const target = event.target

  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Backspace') {
    event.preventDefault()
    emit('clear-request')
    return
  }

  if (!isTextLikeBlock(current)) {
    return
  }

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'k') {
    if (openPathPickerFromShortcut()) {
      event.preventDefault()
      return
    }
  }

  if (mentionState.value.open && mentionState.value.blockIndex === index) {
    if (event.key === 'Escape') {
      event.preventDefault()
      dismissMentionPicker()
      return
    }

    if (event.key === 'ArrowDown') {
      if (mentionPickerRef.value?.moveActive?.(1)) {
        event.preventDefault()
        return
      }
    }

    if (event.key === 'ArrowUp') {
      if (mentionPickerRef.value?.moveActive?.(-1)) {
        event.preventDefault()
        return
      }
    }

    if (event.key === 'ArrowRight') {
      if (await mentionPickerRef.value?.expandActiveDirectory?.()) {
        event.preventDefault()
        return
      }
    }

    if (event.key === 'ArrowLeft') {
      if (mentionPickerRef.value?.collapseActiveDirectory?.()) {
        event.preventDefault()
        return
      }
    }

    if (!event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'Tab') {
      if (mentionPickerRef.value?.switchTab?.(event.shiftKey ? -1 : 1)) {
        event.preventDefault()
        return
      }
    }

    if (!event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'Enter') {
      if (mentionPickerRef.value?.confirmActive?.()) {
        event.preventDefault()
        return
      }
    }
  }

  const selectionStart = target.selectionStart ?? 0
  const selectionEnd = target.selectionEnd ?? 0

  if (event.key === 'Backspace' && selectionStart === 0 && selectionEnd === 0) {
    const previousBlock = blocks.value[index - 1]
    if (!previousBlock) {
      return
    }

    event.preventDefault()
    if (isTextLikeBlock(previousBlock)) {
      mergeTextBlocks(index, index - 1)
      return
    }

    removeNonTextNeighbor(index, index - 1, 0)
    return
  }

  if (event.key === 'Delete' && selectionStart === current.content.length && selectionEnd === current.content.length) {
    const nextBlock = blocks.value[index + 1]
    if (!nextBlock) {
      return
    }

    event.preventDefault()
    if (isTextLikeBlock(nextBlock)) {
      mergeTextBlocks(index, index + 1)
      return
    }

    removeNonTextNeighbor(index, index + 1, current.content.length)
  }
}

function focusEditor() {
  const nextIndex = blocks.value.findIndex((block) => block.type === BLOCK_TYPES.TEXT)
  if (nextIndex < 0) {
    return
  }

  activeIndex.value = nextIndex
  nextTick(() => {
    const target = textareas.value[nextIndex]
    const position = target?.selectionStart ?? target?.value?.length ?? 0
    placeCursor(nextIndex, position)
  })
}

function isEditing() {
  if (composingBlockIndex.value >= 0 || focusedBlockIndex.value >= 0) {
    return true
  }

  return Date.now() - lastInputAt.value < EDITING_GRACE_PERIOD_MS
}

const blockLayoutSignature = computed(() =>
  blocks.value
    .map((block, index) => `${index}:${block.type}:${block.meta?.collapsed ? '1' : '0'}`)
    .join('|')
)

const textBlockContentSignature = computed(() =>
  blocks.value
    .map((block, index) => (
      isTextLikeBlock(block)
        ? `${index}:${block.type}:${block.content || ''}`
        : `${index}:${block.type}`
    ))
    .join('|')
)

watch(
  blockLayoutSignature,
  () => {
    nextTick(() => {
      resizeAllTextareas()
    })
  },
  { immediate: true }
)

watch(
  () => props.modelValue,
  (value) => {
    const normalized = normalizeBlocksWithAnchors(value)
    syncTextDraftValues(normalized)
    if (!areBlocksEquivalent(normalized, value)) {
      emit('update:modelValue', normalized)
    }

    if (composingBlockIndex.value >= normalized.length) {
      composingBlockIndex.value = -1
    }
  },
  { immediate: true, deep: true }
)

watch(
  textBlockContentSignature,
  () => {
    nextTick(() => {
      resizeAllTextareas()
    })
  },
  { immediate: true }
)

watch(
  blockLayoutSignature,
  () => {
    if (mentionState.value.open) {
      nextTick(updateMentionAnchor)
    }
  }
)

watch(
  contentBodyRef,
  (element) => {
    connectContentResizeObserver(element)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  stopFocusFollow()
  disconnectContentResizeObserver()
})

defineExpose({
  clearContent,
  flushPendingInput,
  focusEditor,
  insertBlocks,
  insertImportedBlocks,
  insertTextAtSelection,
  insertUploadedBlocks,
  isComposing,
  isEditing,
  isImportedBlockActive: () => blocks.value[activeIndex.value]?.type === BLOCK_TYPES.IMPORTED_TEXT,
  openFilePicker,
})
</script>

<template>
  <section
    ref="surfaceRef"
    class="panel relative flex h-full min-h-0 flex-col overflow-hidden"
    @click="handleSurfaceClick"
    @drop="handleSurfaceDrop"
    @dragover.prevent
    @paste="handleSurfacePaste"
  >
    <div class="theme-divider theme-secondary-text border-b px-5 py-3 text-sm">
      <div class="flex justify-end">
        <div class="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <slot name="header-actions" />
        </div>
      </div>
      <input
        ref="fileInputRef"
        class="hidden"
        type="file"
        :accept="FILE_INPUT_ACCEPT"
        multiple
        @change="handleFileInput"
      />
    </div>

    <div ref="contentRef" class="flex-1 overflow-y-auto px-5 py-5" @scroll="handleContentScroll">
      <div ref="contentBodyRef" class="flex flex-col gap-5">
      <template v-for="(block, index) in blocks" :key="String(block.id || block.clientId || `${block.type}-${index}`)">
        <div v-if="block.type === BLOCK_TYPES.TEXT" class="group relative">
          <textarea
            :ref="(element) => setTextRef(element, index)"
            rows="1"
            :value="getTextDraftValue(block, index)"
            class="w-full resize-none overflow-hidden border-0 bg-transparent p-0 pr-12 text-[15px] leading-8 text-[var(--theme-textPrimary)] outline-none placeholder:text-[var(--theme-textMuted)]"
            :placeholder="index === 0 ? t('blockEditor.placeholderFirst') : t('blockEditor.placeholderNext')"
            @focus="handleTextFocus(index); handleTextFocusState(index)"
            @blur="handleTextBlurState(index)"
            @input="handleTextModelInput(index, $event)"
            @compositionstart="handleTextCompositionStart(index)"
            @compositionupdate="handleTextCompositionUpdate(index, $event)"
            @compositionend="handleTextCompositionEnd(index, $event)"
            @keydown="handleTextKeydown(index, $event)"
            @click="recordSelection(index, $event)"
            @keyup="recordSelection(index, $event)"
            @select="recordSelection(index, $event)"
          />
          <button
            type="button"
            class="tool-button tool-button-danger-subtle absolute right-0 top-1 inline-flex items-center gap-1.5 px-2 py-1 text-xs opacity-0 transition group-hover:opacity-100 focus:opacity-100"
            @click="removeBlock(index)"
          >
            <Trash2 class="h-3.5 w-3.5" />
            <span>{{ t('blockEditor.delete') }}</span>
          </button>
        </div>

        <div v-else-if="block.type === BLOCK_TYPES.IMPORTED_TEXT" class="group relative dashed-panel overflow-hidden">
          <div class="theme-divider theme-secondary-text flex items-start justify-between gap-3 border-b border-dashed px-4 py-3 text-xs">
            <div class="min-w-0 pr-24">
              <p class="theme-heading font-medium">{{ t('blockEditor.importedFile') }}</p>
              <p class="mt-1 truncate font-mono">{{ block.meta?.fileName || t('blockEditor.unnamedFile') }}</p>
              <p class="mt-1">{{ getImportedStats(block.content) }}</p>
            </div>
            <div class="absolute right-3 top-3 flex flex-wrap gap-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              <button type="button" class="tool-button inline-flex items-center gap-1.5 px-2 py-1 text-xs" @click="toggleImportedCollapse(index)">
                <ChevronDown class="h-3.5 w-3.5" :class="block.meta?.collapsed ? 'rotate-180' : ''" />
                <span>{{ block.meta?.collapsed ? t('blockEditor.expand') : t('blockEditor.collapse') }}</span>
              </button>
              <button type="button" class="tool-button inline-flex items-center gap-1.5 px-2 py-1 text-xs" @click="convertImportedToText(index)">
                <FileText class="h-3.5 w-3.5" />
                <span>{{ t('blockEditor.convertToText') }}</span>
              </button>
              <button type="button" class="tool-button tool-button-danger-subtle inline-flex items-center gap-1.5 px-2 py-1 text-xs" @click="removeBlock(index)">
                <Trash2 class="h-3.5 w-3.5" />
                <span>{{ t('blockEditor.delete') }}</span>
              </button>
            </div>
          </div>

          <div v-if="block.meta?.collapsed" class="theme-secondary-text px-4 py-3 text-sm leading-7">
            {{ getImportedPreview(block.content) || t('blockEditor.emptyContent') }}<span v-if="block.content.length > 180">...</span>
          </div>

          <textarea
            v-else
            :ref="(element) => setTextRef(element, index)"
            rows="1"
            :value="getTextDraftValue(block, index)"
            class="w-full resize-none overflow-hidden border-0 bg-transparent px-4 py-4 text-[15px] leading-8 text-[var(--theme-textPrimary)] outline-none placeholder:text-[var(--theme-textMuted)]"
            :placeholder="t('blockEditor.emptyImportPlaceholder')"
            @focus="handleTextFocus(index); handleTextFocusState(index)"
            @blur="handleTextBlurState(index)"
            @input="handleTextModelInput(index, $event)"
            @compositionstart="handleTextCompositionStart(index)"
            @compositionupdate="handleTextCompositionUpdate(index, $event)"
            @compositionend="handleTextCompositionEnd(index, $event)"
            @keydown="handleTextKeydown(index, $event)"
            @click="recordSelection(index, $event)"
            @keyup="recordSelection(index, $event)"
            @select="recordSelection(index, $event)"
          />
        </div>

        <figure v-else class="group relative">
          <button
            type="button"
            class="tool-button tool-button-danger-subtle absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 px-2 py-1 text-xs opacity-0 transition group-hover:opacity-100 focus:opacity-100"
            @click="removeBlock(index)"
          >
            <Trash2 class="h-3.5 w-3.5" />
            <span>{{ t('blockEditor.delete') }}</span>
          </button>
          <div class="theme-inline-panel overflow-hidden rounded-sm border" @click="focusAfterImage(index)">
            <div class="theme-divider theme-muted-text flex items-center gap-2 border-b px-4 py-3 text-xs">
              <ImageIcon class="h-4 w-4" />
              <span>{{ t('blockEditor.insertedImage') }}</span>
            </div>
            <div class="mx-auto flex w-full max-w-[720px] justify-center px-4 py-4">
              <button
                type="button"
                class="inline-flex cursor-zoom-in justify-center"
                @click.stop="openImagePreview(block.content)"
              >
                <img
                  :src="block.content"
                  :alt="t('blockEditor.insertedImageAlt')"
                  class="max-h-[380px] w-auto max-w-full object-contain"
                />
              </button>
            </div>
          </div>
        </figure>
      </template>
      </div>
    </div>

    <ImagePreviewOverlay
      v-model="previewImageUrl"
      :images="previewImages"
    />

    <PathMentionPicker
      ref="mentionPickerRef"
      :open="mentionState.open && !!mentionAnchorRect"
      :session-id="codexSessionId"
      :query="mentionState.query"
      :anchor-rect="mentionAnchorRect"
      @close="dismissMentionPicker"
      @select="applyMentionSelection"
    />
  </section>
</template>
