<script setup>
import { computed, ref, watch } from 'vue'
import { ArrowUpLeft, CheckSquare, Clock3, FileText, Image as ImageIcon, List, Square, Trash2 } from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close', 'delete', 'use'])
const { t } = useI18n()
const selectedIds = ref([])

const formattedItems = computed(() => (
  (props.items || []).map((item) => {
    const blocks = Array.isArray(item?.blocks) ? item.blocks : []
    const textPreview = blocks
      .find((block) => ['text', 'imported_text'].includes(String(block?.type || '')) && String(block?.content || '').trim())
      ?.content || ''
    const preview = String(textPreview || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
    const imageCount = blocks.filter((block) => String(block?.type || '') === 'image').length
    const importedCount = blocks.filter((block) => String(block?.type || '') === 'imported_text').length
    const textCount = blocks.filter((block) => String(block?.type || '') === 'text' && String(block?.content || '').trim()).length

    return {
      ...item,
      blockCount: blocks.length,
      imageCount,
      importedCount,
      preview: preview || (imageCount ? t('todoDialog.imagePreview', { count: imageCount }) : t('todoDialog.noPreview')),
      textCount,
      timeLabel: formatCreatedAt(item?.createdAt),
    }
  })
))

watch(
  () => props.open,
  (open) => {
    if (!open) {
      selectedIds.value = []
    }
  }
)

watch(
  formattedItems,
  (items) => {
    const availableIds = new Set(items.map((item) => item.id))
    selectedIds.value = selectedIds.value.filter((id) => availableIds.has(id))
  }
)

const allSelected = computed(() => (
  formattedItems.value.length > 0
  && selectedIds.value.length === formattedItems.value.length
))

const hasSelection = computed(() => selectedIds.value.length > 0)

function toggleSelected(todoId = '') {
  const normalizedTodoId = String(todoId || '').trim()
  if (!normalizedTodoId) {
    return
  }

  if (selectedIds.value.includes(normalizedTodoId)) {
    selectedIds.value = selectedIds.value.filter((id) => id !== normalizedTodoId)
    return
  }

  selectedIds.value = [...selectedIds.value, normalizedTodoId]
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = []
    return
  }

  selectedIds.value = formattedItems.value.map((item) => item.id)
}

function handleUseSelected() {
  if (!selectedIds.value.length) {
    return
  }

  emit('use', [...selectedIds.value])
}

function formatCreatedAt(value = '') {
  const timestamp = Date.parse(String(value || ''))
  if (!timestamp) {
    return t('todoDialog.justAdded')
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp))
  } catch {
    return String(value || '')
  }
}

</script>

<template>
  <DialogShell
    :open="open"
    backdrop-class="z-[70] items-end justify-center px-0 py-0 sm:items-center sm:px-4 sm:py-6"
    panel-class="h-full max-w-3xl sm:h-[40rem] sm:max-h-[86vh]"
    header-class="px-5 py-4"
    body-class="min-h-0 flex flex-1 flex-col overflow-hidden"
    @close="emit('close')"
  >
    <template #title>
      <div class="min-w-0">
        <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
          <List class="h-4 w-4" />
          <span>{{ t('todoDialog.title') }}</span>
        </div>
        <p class="theme-muted-text mt-1 text-xs leading-5">
          {{ t('todoDialog.intro') }}
        </p>
      </div>
    </template>

    <div class="theme-divider flex flex-col items-stretch gap-2 border-b border-dashed px-5 py-3 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <span class="theme-muted-text">{{ t('todoDialog.summary', { count: formattedItems.length }) }}</span>
      <div class="flex flex-wrap items-center gap-2">
        <button
          v-if="formattedItems.length"
          type="button"
          class="tool-button inline-flex items-center gap-1.5 px-2.5 py-1 text-xs"
          @click="toggleSelectAll"
        >
          <CheckSquare v-if="allSelected" class="h-3.5 w-3.5" />
          <Square v-else class="h-3.5 w-3.5" />
          <span>{{ allSelected ? t('todoDialog.clearSelection') : t('todoDialog.selectAll') }}</span>
        </button>
        <span class="theme-status-neutral inline-flex items-center rounded-sm border border-dashed px-2 py-1">
          {{ t('todoDialog.summaryHint') }}
        </span>
      </div>
    </div>

    <div v-if="formattedItems.length" class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div class="space-y-3">
            <article
              v-for="item in formattedItems"
              :key="item.id"
              class="rounded-sm border border-dashed p-4 transition"
              :class="selectedIds.includes(item.id) ? 'theme-card-selected' : 'theme-card-idle-muted'"
            >
              <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
                <div class="min-w-0 flex-1">
                  <button
                    type="button"
                    class="mb-3 inline-flex items-center gap-2 rounded-sm border border-dashed px-2 py-1 text-[11px]"
                    @click="toggleSelected(item.id)"
                  >
                    <CheckSquare v-if="selectedIds.includes(item.id)" class="h-3.5 w-3.5" />
                    <Square v-else class="h-3.5 w-3.5" />
                    <span>{{ selectedIds.includes(item.id) ? t('todoDialog.selected') : t('todoDialog.select') }}</span>
                  </button>
                  <div class="theme-heading flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span>{{ t('todoDialog.itemTitle') }}</span>
                    <span class="theme-status-neutral inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-0.5 text-[11px]">
                      <Clock3 class="h-3.5 w-3.5" />
                      {{ item.timeLabel }}
                    </span>
                  </div>
                  <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                    {{ item.preview }}
                  </p>
                  <div class="theme-muted-text mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                    <span class="rounded-sm border border-dashed px-2 py-1">
                      {{ t('todoDialog.blockCount', { count: item.blockCount }) }}
                    </span>
                    <span
                      v-if="item.textCount"
                      class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1"
                    >
                      <FileText class="h-3.5 w-3.5" />
                      {{ t('todoDialog.textCount', { count: item.textCount }) }}
                    </span>
                    <span
                      v-if="item.importedCount"
                      class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1"
                    >
                      <FileText class="h-3.5 w-3.5" />
                      {{ t('todoDialog.importedCount', { count: item.importedCount }) }}
                    </span>
                    <span
                      v-if="item.imageCount"
                      class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1"
                    >
                      <ImageIcon class="h-3.5 w-3.5" />
                      {{ t('todoDialog.imageCount', { count: item.imageCount }) }}
                    </span>
                  </div>
                </div>

                <div class="flex w-full flex-col gap-2 sm:w-auto sm:shrink-0 sm:flex-row sm:items-center">
                  <button
                    type="button"
                    class="tool-button inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-xs sm:w-auto"
                    @click="emit('use', [item.id])"
                  >
                    <ArrowUpLeft class="h-4 w-4" />
                    <span>{{ t('todoDialog.useOne') }}</span>
                  </button>
                  <button
                    type="button"
                    class="tool-button tool-button-danger-subtle inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-xs sm:w-auto"
                    @click="emit('delete', item.id)"
                  >
                    <Trash2 class="h-4 w-4" />
                    <span>{{ t('todoDialog.delete') }}</span>
                  </button>
                </div>
              </div>
            </article>
          </div>
    </div>

    <div v-else class="theme-empty-state flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-sm">
      {{ t('todoDialog.empty') }}
    </div>
    <div
      v-if="formattedItems.length"
      class="theme-divider flex flex-col items-stretch gap-3 border-t border-dashed px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <span class="theme-muted-text text-xs">
        {{ hasSelection ? t('todoDialog.selectedSummary', { count: selectedIds.length }) : t('todoDialog.selectHint') }}
      </span>
      <button
        type="button"
        class="tool-button tool-button-primary inline-flex w-full items-center justify-center gap-2 px-4 py-2 text-sm sm:w-auto"
        :disabled="!hasSelection"
        @click="handleUseSelected"
      >
        <ArrowUpLeft class="h-4 w-4" />
        <span>{{ t('todoDialog.useSelected', { count: selectedIds.length }) }}</span>
      </button>
    </div>
  </DialogShell>
</template>
