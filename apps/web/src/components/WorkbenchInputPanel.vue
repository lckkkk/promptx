<script setup>
import { computed, ref } from 'vue'
import BlockEditor from './BlockEditor.vue'
import WorkbenchEditorActions from './WorkbenchEditorActions.vue'

const props = defineProps({
  modelValue: {
    type: Array,
    default: () => [],
  },
  codexSessionId: {
    type: String,
    default: '',
  },
  uploading: {
    type: Boolean,
    default: false,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  isCurrentTaskSending: {
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
  'copy-request',
  'send-request',
  'stop-request',
])

const blockEditorRef = ref(null)

const blocks = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

function openFilePicker() {
  blockEditorRef.value?.openFilePicker?.()
}

function focusEditor() {
  blockEditorRef.value?.focusEditor?.()
}

function insertBlocks(blocksToInsert) {
  blockEditorRef.value?.insertBlocks?.(blocksToInsert)
}

function insertImportedBlocks(importedBlocks) {
  blockEditorRef.value?.insertImportedBlocks?.(importedBlocks)
}

function insertUploadedBlocks(uploadedBlocks) {
  blockEditorRef.value?.insertUploadedBlocks?.(uploadedBlocks)
}

function isImportedBlockActive() {
  return blockEditorRef.value?.isImportedBlockActive?.() || false
}

defineExpose({
  focusEditor,
  insertBlocks,
  insertImportedBlocks,
  insertUploadedBlocks,
  isImportedBlockActive,
  openFilePicker,
})
</script>

<template>
  <section
    v-if="loading && !modelValue.length"
    class="panel theme-muted-text flex h-full items-center px-5 py-4 text-sm"
  >
    正在加载任务内容...
  </section>
  <BlockEditor
    v-else
    ref="blockEditorRef"
    v-model="blocks"
    :codex-session-id="codexSessionId"
    :uploading="uploading"
    @upload-files="emit('upload-files', $event)"
    @import-text-files="emit('import-text-files', $event)"
    @import-pdf-files="emit('import-pdf-files', $event)"
    @clear-request="emit('clear-request')"
  >
    <template #header-actions>
      <WorkbenchEditorActions
        :is-current-task-sending="isCurrentTaskSending"
        @open-file-picker="openFilePicker"
        @clear-request="emit('clear-request')"
        @copy-request="emit('copy-request')"
        @send-request="emit('send-request')"
        @stop-request="emit('stop-request')"
      />
    </template>
  </BlockEditor>
</template>
