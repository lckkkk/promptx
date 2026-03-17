<script setup>
import { onBeforeUnmount, watch } from 'vue'
import { TriangleAlert, X } from 'lucide-vue-next'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: '确认操作',
  },
  description: {
    type: String,
    default: '',
  },
  confirmText: {
    type: String,
    default: '确认',
  },
  cancelText: {
    type: String,
    default: '取消',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  danger: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['cancel', 'confirm'])

function handleKeydown(event) {
  if (!props.open || props.loading) {
    return
  }
  if (event.key === 'Escape') {
    emit('cancel')
  }
}

watch(
  () => props.open,
  (open) => {
    document.body.classList.toggle('overflow-hidden', open)
    if (open) {
      window.addEventListener('keydown', handleKeydown)
      return
    }
    window.removeEventListener('keydown', handleKeydown)
  }
)

onBeforeUnmount(() => {
  document.body.classList.remove('overflow-hidden')
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[70] flex items-center justify-center bg-stone-950/45 px-4 backdrop-blur-sm"
      @click.self="!loading && emit('cancel')"
    >
      <section class="panel w-full max-w-md overflow-hidden">
        <div class="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4 dark:border-stone-800">
          <div class="flex items-start gap-3">
            <span
              class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-dashed"
              :class="danger
                ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300'
                : 'border-stone-300 bg-stone-50 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200'"
            >
              <TriangleAlert class="h-4 w-4" />
            </span>
            <div>
              <h2 class="text-base font-semibold text-stone-900 dark:text-stone-100">{{ title }}</h2>
              <p v-if="description" class="mt-1 text-sm leading-6 text-stone-600 dark:text-stone-400">{{ description }}</p>
            </div>
          </div>
          <button
            type="button"
            class="inline-flex h-8 w-8 items-center justify-center rounded-sm text-stone-400 transition hover:bg-stone-200 hover:text-stone-700 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            :disabled="loading"
            @click="emit('cancel')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <div class="flex justify-end gap-2 px-5 py-4">
          <button type="button" class="tool-button px-4 py-2 text-sm" :disabled="loading" @click="emit('cancel')">
            {{ cancelText }}
          </button>
          <button
            type="button"
            class="tool-button px-4 py-2 text-sm"
            :class="danger ? 'border-red-700 bg-red-700 text-red-50 hover:bg-red-600 dark:border-red-400 dark:bg-red-400 dark:text-stone-950 dark:hover:bg-red-300' : 'tool-button-primary'"
            :disabled="loading"
            @click="emit('confirm')"
          >
            {{ loading ? '处理中...' : confirmText }}
          </button>
        </div>
      </section>
    </div>
  </Teleport>
</template>
