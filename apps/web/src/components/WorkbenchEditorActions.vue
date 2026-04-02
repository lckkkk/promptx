<script setup>
import { computed } from 'vue'
import { LoaderCircle, List, Plus, SendHorizontal, Upload, WandSparkles } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  canAddTodo: {
    type: Boolean,
    default: false,
  },
  uploading: {
    type: Boolean,
    default: false,
  },
  isCurrentTaskSending: {
    type: Boolean,
    default: false,
  },
  sendState: {
    type: String,
    default: 'idle',
  },
  todoCount: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits([
  'add-todo',
  'open-file-picker',
  'clear-request',
  'copy-request',
  'manage-todo',
  'send-request',
])

const { t } = useI18n()

const sendBusy = computed(() => props.sendState === 'sending' || props.sendState === 'running')

function getTodoManageLabel() {
  return props.todoCount > 0 ? t('editor.todoWithCount', { count: props.todoCount }) : t('editor.todo')
}
</script>

<template>
  <div
    class="grid w-full grid-cols-5 gap-1.5 sm:flex sm:w-auto sm:flex-wrap sm:justify-end sm:gap-2"
    data-promptx-editor-actions
  >
    <button
      type="button"
      class="tool-button inline-flex min-w-0 items-center justify-center gap-1.5 px-0 py-2 text-[11px] sm:w-auto sm:px-3 sm:text-xs"
      :disabled="uploading"
      :title="t('editor.chooseFiles')"
      :aria-label="t('editor.chooseFiles')"
      data-promptx-editor-action="files"
      @mousedown.prevent
      @click="emit('open-file-picker')"
    >
      <LoaderCircle v-if="uploading" class="h-4 w-4 animate-spin" />
      <Upload v-else class="h-4 w-4" />
      <span class="sr-only sm:not-sr-only sm:inline">{{ t('editor.chooseFiles') }}</span>
    </button>
    <button
      type="button"
      class="tool-button inline-flex min-w-0 items-center justify-center gap-1.5 px-0 py-2 text-[11px] sm:w-auto sm:px-3 sm:text-xs"
      :title="t('editor.clear')"
      :aria-label="t('editor.clear')"
      data-promptx-editor-action="clear"
      @mousedown.prevent
      @click="emit('clear-request')"
    >
      <WandSparkles class="h-4 w-4" />
      <span class="sr-only sm:not-sr-only sm:inline">{{ t('editor.clear') }}</span>
    </button>
    <button
      type="button"
      class="tool-button inline-flex min-w-0 items-center justify-center gap-1.5 px-0 py-2 text-[11px] sm:w-auto sm:px-3 sm:text-xs"
      :disabled="!canAddTodo"
      :title="t('editor.todo')"
      :aria-label="t('editor.todo')"
      data-promptx-editor-action="todo-add"
      @mousedown.prevent
      @click="emit('add-todo')"
    >
      <Plus class="h-4 w-4" />
      <span class="sr-only sm:not-sr-only sm:inline">{{ t('editor.todo') }}</span>
    </button>
    <button
      type="button"
      class="tool-button relative inline-flex min-w-0 items-center justify-center gap-1.5 px-0 py-2 text-[11px] sm:w-auto sm:px-3 sm:text-xs"
      :title="getTodoManageLabel()"
      :aria-label="getTodoManageLabel()"
      data-promptx-editor-action="todo-manage"
      @mousedown.prevent
      @click="emit('manage-todo')"
    >
      <List class="h-4 w-4" />
      <span class="sr-only sm:not-sr-only sm:inline">{{ getTodoManageLabel() }}</span>
      <span
        v-if="todoCount > 0"
        class="absolute right-1 top-1 min-w-[1rem] rounded-full bg-[var(--theme-primaryBg)] px-1 text-[10px] font-semibold leading-4 text-[var(--theme-primaryText)] sm:hidden"
      >
        {{ todoCount > 9 ? '9+' : todoCount }}
      </span>
    </button>
    <button
      type="button"
      class="tool-button tool-button-primary inline-flex min-w-0 items-center justify-center gap-1.5 px-0 py-2 text-[11px] sm:w-auto sm:px-3 sm:text-xs"
      :disabled="isCurrentTaskSending"
      :title="t('editor.send')"
      :aria-label="t('editor.send')"
      data-promptx-editor-action="send"
      @mousedown.prevent
      @click="emit('send-request')"
    >
      <LoaderCircle v-if="sendBusy" class="h-4 w-4 animate-spin" />
      <SendHorizontal v-else class="h-4 w-4" />
      <span class="sr-only sm:not-sr-only sm:inline">{{ t('editor.send') }}</span>
    </button>
  </div>
</template>
