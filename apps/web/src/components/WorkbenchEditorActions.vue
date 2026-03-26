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
</script>

<template>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    :disabled="uploading"
    @mousedown.prevent
    @click="emit('open-file-picker')"
  >
    <LoaderCircle v-if="uploading" class="h-4 w-4 animate-spin" />
    <Upload v-else class="h-4 w-4" />
    <span>{{ t('editor.chooseFiles') }}</span>
  </button>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    @mousedown.prevent
    @click="emit('clear-request')"
  >
    <WandSparkles class="h-4 w-4" />
    <span>{{ t('editor.clear') }}</span>
  </button>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    :disabled="!canAddTodo"
    @mousedown.prevent
    @click="emit('add-todo')"
  >
    <Plus class="h-4 w-4" />
    <span>{{ t('editor.todo') }}</span>
  </button>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    @mousedown.prevent
    @click="emit('manage-todo')"
  >
    <List class="h-4 w-4" />
    <span>{{ todoCount > 0 ? t('editor.todoWithCount', { count: todoCount }) : t('editor.todo') }}</span>
  </button>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    :disabled="isCurrentTaskSending"
    @mousedown.prevent
    @click="emit('send-request')"
  >
    <LoaderCircle v-if="sendBusy" class="h-4 w-4 animate-spin" />
    <SendHorizontal v-else class="h-4 w-4" />
    <span>{{ t('editor.send') }}</span>
  </button>
</template>
