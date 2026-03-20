<script setup>
import { Copy, SendHorizontal, Upload, WandSparkles } from 'lucide-vue-next'

defineProps({
  isCurrentTaskSending: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'open-file-picker',
  'clear-request',
  'copy-request',
  'send-request',
])
</script>

<template>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    @click="emit('open-file-picker')"
  >
    <Upload class="h-4 w-4" />
    <span>选文件</span>
  </button>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    @click="emit('clear-request')"
  >
    <WandSparkles class="h-4 w-4" />
    <span>清空</span>
  </button>
  <button
    type="button"
    class="tool-button hidden items-center justify-center gap-1.5 px-2 py-2 text-xs sm:inline-flex sm:w-auto sm:gap-2 sm:px-3"
    @click="emit('copy-request')"
  >
    <Copy class="h-4 w-4" />
    <span>复制</span>
  </button>
  <button
    type="button"
    class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
    :disabled="isCurrentTaskSending"
    @click="emit('send-request')"
  >
    <SendHorizontal class="h-4 w-4" />
    <span>发送</span>
  </button>
</template>
