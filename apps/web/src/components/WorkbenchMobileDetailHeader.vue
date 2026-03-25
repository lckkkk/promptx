<script setup>
import { ArrowLeft, PencilLine } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  currentTaskSlug: {
    type: String,
    default: '',
  },
  editingTaskTitleSlug: {
    type: String,
    default: '',
  },
  title: {
    type: String,
    default: '',
  },
  titleInputValue: {
    type: String,
    default: '',
  },
  currentTaskAutoTitle: {
    type: String,
    default: '',
  },
})

const emit = defineEmits([
  'back',
  'begin-edit',
  'title-blur',
  'cancel-title-edit',
  'update:titleInputValue',
])

const { t } = useI18n()
</script>

<template>
  <section class="panel workbench-mobile-header-panel shrink-0 overflow-hidden">
    <div class="workbench-panel-header workbench-mobile-header theme-divider border-b px-4 py-3">
      <div class="flex items-center gap-3">
        <button
          type="button"
          class="tool-button inline-flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs"
          @click="emit('back')"
        >
          <ArrowLeft class="h-4 w-4" />
          <span>{{ t('workbench.tasks') }}</span>
        </button>

        <div class="min-w-0 flex-1">
          <input
            v-if="currentTaskSlug && editingTaskTitleSlug === currentTaskSlug"
            :value="titleInputValue"
            type="text"
            maxlength="140"
            data-task-title-input="current"
            class="block w-full appearance-none border-0 bg-transparent p-0 text-left text-sm font-semibold leading-6 outline-none placeholder:text-[var(--theme-textMuted)]"
            :placeholder="currentTaskAutoTitle || t('workbench.untitledTask')"
            @input="emit('update:titleInputValue', $event.target.value)"
            @keydown.enter.prevent="$event.target.blur()"
            @keydown.esc.prevent="emit('cancel-title-edit')"
            @blur="emit('title-blur')"
          >
          <button
            v-else
            type="button"
            class="inline-flex w-full items-center gap-2 truncate bg-transparent p-0 text-left text-sm font-semibold leading-6"
            :disabled="!currentTaskSlug"
            @click="emit('begin-edit')"
          >
            <span class="truncate">{{ title || t('workbench.untitledTask') }}</span>
            <PencilLine class="h-3.5 w-3.5 shrink-0 opacity-50" />
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
