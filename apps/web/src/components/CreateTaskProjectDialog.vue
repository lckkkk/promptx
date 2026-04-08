<script setup>
import { computed } from 'vue'
import { Folders } from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import CodexSessionSelect from './CodexSessionSelect.vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  loading: {
    type: Boolean,
    default: false,
  },
  sessions: {
    type: Array,
    default: () => [],
  },
  sessionsLoading: {
    type: Boolean,
    default: false,
  },
  selectedProjectId: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['cancel', 'confirm', 'refresh-projects', 'update:selectedProjectId'])
const { t } = useI18n()

const canConfirm = computed(() => Boolean(String(props.selectedProjectId || '').trim()) && !props.loading)
</script>

<template>
  <DialogShell
    :open="open"
    backdrop-class="z-[90] items-end justify-center px-0 py-0 sm:items-center sm:px-4 sm:py-6"
    panel-class="max-w-lg"
    header-class="px-5 py-4"
    body-class="flex flex-col"
    :close-disabled="loading"
    :close-on-backdrop="!loading"
    :close-on-escape="!loading"
    @close="emit('cancel')"
  >
    <template #title>
      <div class="flex items-start gap-3">
        <span class="theme-status-neutral inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-dashed">
          <Folders class="h-4 w-4" />
        </span>
        <div>
          <h2 class="theme-heading text-base font-semibold">{{ t('workbench.createTaskPickProjectTitle') }}</h2>
          <p class="theme-muted-text mt-1 text-sm leading-6">{{ t('workbench.createTaskPickProjectDescription') }}</p>
        </div>
      </div>
    </template>

    <div class="px-5 py-4">
      <CodexSessionSelect
        :model-value="selectedProjectId"
        :sessions="sessions"
        :loading="sessionsLoading"
        :disabled="loading"
        @update:model-value="emit('update:selectedProjectId', $event)"
        @refresh-intent="emit('refresh-projects')"
      />
    </div>

    <div class="flex justify-end gap-2 px-5 py-4">
      <button type="button" class="tool-button px-4 py-2 text-sm" :disabled="loading" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </button>
      <button
        type="button"
        class="tool-button tool-button-primary px-4 py-2 text-sm"
        :disabled="!canConfirm"
        @click="emit('confirm')"
      >
        {{ loading ? t('common.processing') : t('workbench.createTaskConfirm') }}
      </button>
    </div>
  </DialogShell>
</template>
