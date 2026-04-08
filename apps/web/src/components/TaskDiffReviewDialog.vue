<script setup>
import { computed, ref, watch } from 'vue'
import { FileDiff, FileText } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import DialogShell from './DialogShell.vue'
import TaskDiffReviewPanel from './TaskDiffReviewPanel.vue'
import TaskFileBrowserPanel from './TaskFileBrowserPanel.vue'

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
  sessionId: {
    type: String,
    default: '',
  },
  preferredView: {
    type: String,
    default: 'diff',
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
const { t } = useI18n()
const activeView = ref('diff')

const titleText = computed(() => {
  const taskTitle = String(props.taskTitle || '').trim()
  return taskTitle ? t('diffReview.dialogTitleWithTask', { title: taskTitle }) : t('diffReview.dialogTitle')
})

watch(
  () => [props.open, props.preferredView, props.focusToken],
  () => {
    if (!props.open) {
      return
    }

    activeView.value = props.preferredView === 'files' ? 'files' : 'diff'
  },
  { immediate: true }
)
</script>

<template>
  <DialogShell
    :open="open"
    panel-class="settings-dialog-panel h-full sm:h-[min(90vh,960px)] sm:max-w-[min(96vw,1560px)]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body min-h-0 flex-1 overflow-y-auto p-3 sm:overflow-hidden sm:p-4"
    @close="emit('close')"
  >
    <template #title>
      <div class="flex min-w-0 items-center justify-between gap-3">
        <div class="theme-heading inline-flex min-w-0 items-center gap-2 text-sm font-medium">
          <FileDiff class="h-4 w-4 shrink-0" />
          <span class="truncate">{{ titleText }}</span>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <button
            type="button"
            class="tool-button inline-flex items-center gap-1.5 px-3 py-2 text-xs"
            :class="activeView === 'diff' ? 'theme-filter-active' : ''"
            @click="activeView = 'diff'"
          >
            <FileDiff class="h-3.5 w-3.5" />
            <span>{{ t('diffReview.dialogTitle') }}</span>
          </button>
          <button
            type="button"
            class="tool-button inline-flex items-center gap-1.5 px-3 py-2 text-xs"
            :class="activeView === 'files' ? 'theme-filter-active' : ''"
            @click="activeView = 'files'"
          >
            <FileText class="h-3.5 w-3.5" />
            <span>{{ t('fileBrowser.treeTab') }}</span>
          </button>
        </div>
      </div>
    </template>

    <TaskDiffReviewPanel
      v-if="activeView === 'diff'"
      :task-slug="taskSlug"
      :active="open"
      :preferred-scope="preferredScope"
      :preferred-run-id="preferredRunId"
      :focus-token="focusToken"
    />
    <TaskFileBrowserPanel
      v-else
      :active="open"
      :focus-token="focusToken"
      :session-id="sessionId"
    />
  </DialogShell>
</template>
