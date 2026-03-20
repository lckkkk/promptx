<script setup>
import { computed, onBeforeUnmount, watch } from 'vue'
import { FileDiff, X } from 'lucide-vue-next'
import TaskDiffReviewPanel from './TaskDiffReviewPanel.vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  taskSlug: {
    type: String,
    default: '',
  },
  taskTitle: {
    type: String,
    default: '',
  },
  preferredScope: {
    type: String,
    default: 'task',
  },
  preferredRunId: {
    type: String,
    default: '',
  },
  focusToken: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits(['close'])

const titleText = computed(() => {
  const taskTitle = String(props.taskTitle || '').trim()
  return taskTitle ? `代码变更 · ${taskTitle}` : '代码变更'
})

function handleKeydown(event) {
  if (!props.open) {
    return
  }

  if (event.key === 'Escape') {
    emit('close')
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
      class="theme-modal-backdrop fixed inset-0 z-50 flex items-end justify-center px-0 py-0 sm:items-center sm:px-4 sm:py-6"
      @click.self="emit('close')"
    >
      <section class="panel flex h-full w-full min-h-0 flex-col overflow-hidden sm:h-[min(90vh,960px)] sm:max-w-[min(96vw,1560px)]">
        <div class="theme-divider flex items-start justify-between gap-4 border-b px-4 py-4 sm:px-5">
          <div class="min-w-0">
            <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
              <FileDiff class="h-4 w-4" />
              <span>{{ titleText }}</span>
            </div>
          </div>

          <button
            type="button"
            class="theme-icon-button h-8 w-8 shrink-0"
            @click="emit('close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-hidden p-3 sm:p-4">
          <TaskDiffReviewPanel
            :task-slug="taskSlug"
            :active="open"
            :preferred-scope="preferredScope"
            :preferred-run-id="preferredRunId"
            :focus-token="focusToken"
          />
        </div>
      </section>
    </div>
  </Teleport>
</template>
