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
      class="theme-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center px-4"
      @click.self="!loading && emit('cancel')"
    >
      <section class="panel w-full max-w-md overflow-hidden">
        <div class="theme-divider flex items-start justify-between gap-3 border-b px-5 py-4">
          <div class="flex items-start gap-3">
            <span
              class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-dashed"
              :class="danger ? 'theme-status-danger' : 'theme-status-neutral'"
            >
              <TriangleAlert class="h-4 w-4" />
            </span>
            <div>
              <h2 class="theme-heading text-base font-semibold">{{ title }}</h2>
              <p v-if="description" class="theme-muted-text mt-1 text-sm leading-6">{{ description }}</p>
            </div>
          </div>
          <button
            type="button"
            class="theme-icon-button h-8 w-8"
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
            :class="danger
              ? 'border-[var(--theme-danger)] bg-[var(--theme-danger)] text-[var(--theme-textInverse)] hover:opacity-90'
              : 'tool-button-primary'"
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
