<script setup>
import { computed } from 'vue'
import { ChevronDown, FileText, Trash2 } from 'lucide-vue-next'
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useI18n } from '../composables/useI18n.js'
import TiptapSpecialBlockFrame from './TiptapSpecialBlockFrame.vue'
import {
  TIPTAP_NODE_TYPES,
  getImportedStats,
  textToTiptapInlineContent,
  tiptapInlineContentToText,
} from './tiptapBlockEditorModel.js'
import { restoreTiptapNodeViewEditorFocus } from './tiptapNodeViewFocus.js'

const props = defineProps(nodeViewProps)
const { t } = useI18n()

const importedText = computed(() => tiptapInlineContentToText(props.node?.content || []))

const statsText = computed(() => {
  const stats = getImportedStats(importedText.value)
  return t('blockEditor.stats', stats)
})

const previewState = computed(() => {
  const sourceText = String(importedText.value || '').replace(/\r\n/g, '\n')
  const lines = sourceText.split('\n')
  const previewLines = []
  let consumedChars = 0

  for (const rawLine of lines) {
    const normalizedLine = rawLine.trimEnd()
    const nextLine = normalizedLine.length ? normalizedLine : ''
    if (!nextLine && previewLines[previewLines.length - 1] === '') {
      continue
    }

    previewLines.push(nextLine)
    consumedChars += nextLine.length

    if (previewLines.length >= 4 || consumedChars >= 220) {
      break
    }
  }

  const text = previewLines.join('\n').trim()
  const normalizedSource = sourceText.trim()
  return {
    text,
    truncated: previewLines.length < lines.length || text.length < normalizedSource.length,
  }
})

const compactButtonClass = 'tool-button inline-flex min-w-0 items-center justify-center gap-1 px-1.5 py-1 text-[11px] sm:justify-start sm:gap-1.5 sm:px-2 sm:text-xs'
const compactDangerButtonClass = `${compactButtonClass} tool-button-danger-subtle`

function handleToggleKeydown(event) {
  if (event.key !== 'Enter' && event.key !== ' ') {
    return
  }

  event.preventDefault()
  toggleCollapsed()
}

function toggleCollapsed() {
  props.updateAttributes?.({
    collapsed: !props.node?.attrs?.collapsed,
  })
  restoreTiptapNodeViewEditorFocus(props.editor)
}

function convertToTextBlock() {
  const { editor, getPos, node } = props
  if (!editor || typeof getPos !== 'function' || !node) {
    return
  }

  const position = getPos()
  editor.chain().focus().insertContentAt(
    { from: position, to: position + node.nodeSize },
    {
      type: TIPTAP_NODE_TYPES.TEXT_BLOCK,
      attrs: {
        clientId: String(node.attrs?.clientId || ''),
      },
      content: textToTiptapInlineContent(importedText.value),
    }
  ).run()
  restoreTiptapNodeViewEditorFocus(props.editor)
}

function removeNode() {
  props.deleteNode?.()
  restoreTiptapNodeViewEditorFocus(props.editor)
}

</script>

<template>
  <NodeViewWrapper class="group relative" data-promptx-node="imported_text">
    <TiptapSpecialBlockFrame
      :selected="selected"
      :actions-attributes="{ 'data-promptx-imported-actions': '' }"
      frame-class="dashed-panel"
      header-class="theme-secondary-text border-dashed"
      actions-layout-class="grid w-full shrink-0 grid-cols-3 gap-1.5 sm:flex sm:w-auto sm:grid-cols-none sm:flex-row sm:flex-wrap sm:justify-end sm:gap-2"
    >
      <template #meta>
        <div
          class="cursor-pointer"
          data-promptx-imported-meta
          role="button"
          tabindex="0"
          :aria-expanded="String(!node.attrs?.collapsed)"
          @click="toggleCollapsed"
          @keydown="handleToggleKeydown"
        >
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p class="theme-heading font-medium">{{ t('blockEditor.importedFile') }}</p>
            <p class="theme-muted-text text-[11px] leading-4">{{ statsText }}</p>
          </div>
          <p class="mt-1 break-all font-mono leading-5 sm:truncate">{{ node.attrs?.fileName || t('blockEditor.unnamedFile') }}</p>
        </div>
      </template>

      <template #actions>
        <button type="button" :class="compactButtonClass" contenteditable="false" @click="toggleCollapsed">
          <ChevronDown class="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" :class="node.attrs?.collapsed ? 'rotate-180' : ''" />
          <span>{{ node.attrs?.collapsed ? t('blockEditor.expand') : t('blockEditor.collapse') }}</span>
        </button>
        <button type="button" :class="compactButtonClass" contenteditable="false" @click="convertToTextBlock">
          <FileText class="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
          <span>{{ t('blockEditor.convertToText') }}</span>
        </button>
        <button type="button" :class="compactDangerButtonClass" contenteditable="false" @click="removeNode">
          <Trash2 class="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
          <span>{{ t('blockEditor.delete') }}</span>
        </button>
      </template>

      <div
        v-show="node.attrs?.collapsed"
        class="theme-secondary-text relative cursor-pointer px-4 py-3 text-sm"
        data-promptx-imported-preview
        role="button"
        tabindex="0"
        :aria-label="t('blockEditor.expand')"
        @click="toggleCollapsed"
        @keydown="handleToggleKeydown"
        >
        <div class="max-h-[8.5rem] overflow-hidden whitespace-pre-wrap break-words leading-6">
          {{ previewState.text || t('blockEditor.emptyContent') }}
        </div>
        <div
          v-if="previewState.truncated"
          class="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[var(--theme-appPanelMuted)] to-transparent"
        />
        <span v-if="previewState.truncated" class="theme-muted-text absolute bottom-2 right-4 bg-[var(--theme-appPanelMuted)] pl-2 text-xs">...</span>
      </div>

      <NodeViewContent
        v-show="!node.attrs?.collapsed"
        as="div"
        data-promptx-node-content="imported_text"
        class="min-h-[56px] whitespace-pre-wrap break-words px-4 py-4 text-[15px] leading-8 text-[var(--theme-textPrimary)] outline-none"
      />
    </TiptapSpecialBlockFrame>
  </NodeViewWrapper>
</template>
