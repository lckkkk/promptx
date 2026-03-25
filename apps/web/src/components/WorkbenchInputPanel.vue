<script setup>
import { computed, ref } from 'vue'
import BlockEditor from './BlockEditor.vue'
import WorkbenchEditorActions from './WorkbenchEditorActions.vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  canAddTodo: {
    type: Boolean,
    default: false,
  },
  codexSessionId: {
    type: String,
    default: '',
  },
  isCurrentTaskSending: {
    type: Boolean,
    default: false,
  },
  sendState: {
    type: String,
    default: 'idle',
  },
  modelValue: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  todoCount: {
    type: Number,
    default: 0,
  },
  uploading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'add-todo',
  'update:modelValue',
  'upload-files',
  'import-text-files',
  'import-pdf-files',
  'clear-request',
  'copy-request',
  'manage-todo',
  'send-request',
])

const blockEditorRef = ref(null)
const { t } = useI18n()

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

function flushPendingInput() {
  return blockEditorRef.value?.flushPendingInput?.() || false
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

function isComposing() {
  return blockEditorRef.value?.isComposing?.() || false
}

defineExpose({
  focusEditor,
  flushPendingInput,
  insertBlocks,
  insertImportedBlocks,
  insertUploadedBlocks,
  isComposing,
  isImportedBlockActive,
  openFilePicker,
})
</script>

<template>
  <section
    v-if="loading && !modelValue.length"
    class="panel theme-muted-text flex h-full items-center px-5 py-4 text-sm"
  >
    {{ t('workbench.loadingTaskContent') }}
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
        :can-add-todo="canAddTodo"
        :is-current-task-sending="isCurrentTaskSending"
        :send-state="sendState"
        :todo-count="todoCount"
        @add-todo="emit('add-todo')"
        @open-file-picker="openFilePicker"
        @clear-request="emit('clear-request')"
        @copy-request="emit('copy-request')"
        @manage-todo="emit('manage-todo')"
        @send-request="emit('send-request')"
      />
    </template>
  </BlockEditor>
</template>
