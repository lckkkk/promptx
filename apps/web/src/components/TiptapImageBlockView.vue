<script setup>
import { Image as ImageIcon, Trash2 } from 'lucide-vue-next'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import { useI18n } from '../composables/useI18n.js'
import TiptapSpecialBlockFrame from './TiptapSpecialBlockFrame.vue'
import { restoreTiptapNodeViewEditorFocus } from './tiptapNodeViewFocus.js'

const props = defineProps(nodeViewProps)
const { t } = useI18n()
const compactDangerButtonClass = 'tool-button tool-button-danger-subtle inline-flex min-w-0 items-center justify-center gap-1 px-1.5 py-1 text-[11px] sm:justify-start sm:gap-1.5 sm:px-2 sm:text-xs'

function openPreview() {
  if (typeof window === 'undefined') {
    return
  }

  window.dispatchEvent(new CustomEvent('promptx:tiptap-image-preview', {
    detail: {
      src: String(props.node?.attrs?.src || ''),
    },
  }))
}

function removeNode() {
  props.deleteNode?.()
  restoreTiptapNodeViewEditorFocus(props.editor)
}
</script>

<template>
  <NodeViewWrapper class="group" data-promptx-node="image">
    <TiptapSpecialBlockFrame
      :selected="selected"
      frame-class="theme-inline-panel border"
      header-class="theme-muted-text"
      actions-layout-class="flex w-full shrink-0 items-center justify-start sm:w-auto sm:justify-end"
    >
      <template #meta>
        <div class="flex min-w-0 items-center gap-2">
          <ImageIcon class="h-4 w-4" />
          <span>{{ t('blockEditor.insertedImage') }}</span>
        </div>
      </template>

      <template #actions>
        <button
          type="button"
          :class="compactDangerButtonClass"
          contenteditable="false"
          @click="removeNode"
        >
          <Trash2 class="h-3 w-3 shrink-0 sm:h-3.5 sm:w-3.5" />
          <span>{{ t('blockEditor.delete') }}</span>
        </button>
      </template>

      <div class="mx-auto flex w-full max-w-[720px] justify-center px-4 py-4">
        <button
          type="button"
          class="inline-flex cursor-zoom-in justify-center"
          contenteditable="false"
          @click="openPreview"
        >
          <img
            :src="node.attrs?.src"
            :alt="t('blockEditor.insertedImageAlt')"
            class="max-h-[380px] w-auto max-w-full object-contain"
          />
        </button>
      </div>
    </TiptapSpecialBlockFrame>
  </NodeViewWrapper>
</template>
