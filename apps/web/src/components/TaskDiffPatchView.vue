<script setup>
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'

defineProps({
  activeHunkIndex: {
    type: Number,
    default: 0,
  },
  getPatchLineClass: {
    type: Function,
    default: () => '',
  },
  getStatusClass: {
    type: Function,
    default: () => '',
  },
  getStatusLabel: {
    type: Function,
    default: (value) => value,
  },
  jumpToAdjacentHunk: {
    type: Function,
    default: () => {},
  },
  patchLoading: {
    type: Boolean,
    default: false,
  },
  selectedFile: {
    type: Object,
    default: null,
  },
  selectedPatchHunks: {
    type: Array,
    default: () => [],
  },
  selectedPatchLines: {
    type: Array,
    default: () => [],
  },
  setPatchLineRef: {
    type: Function,
    default: () => {},
  },
  setPatchViewportRef: {
    type: Function,
    default: () => {},
  },
})
const { t } = useI18n()
</script>

<template>
  <div v-if="selectedFile" class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="theme-divider theme-secondary-text border-b px-4 py-3 text-xs">
      <div class="space-y-3 sm:hidden">
        <div class="flex items-start gap-2">
          <span class="inline-flex shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px]" :class="getStatusClass(selectedFile.status)">
            {{ getStatusLabel(selectedFile.status) }}
          </span>
          <span class="min-w-0 break-all font-medium text-[var(--theme-textPrimary)]">{{ selectedFile.path }}</span>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="opacity-75">
            {{ selectedFile.statsLoaded ? `+${selectedFile.additions} / -${selectedFile.deletions}` : t('diffReview.statsOnDemand') }}
          </span>
          <div
            class="inline-flex h-8 shrink-0 items-center gap-1 rounded-sm border px-1.5 py-1"
            :class="selectedPatchHunks.length
              ? 'theme-inline-panel'
              : 'pointer-events-none invisible border-transparent'"
          >
            <button
              type="button"
              class="theme-icon-button h-6 w-6 disabled:opacity-50"
              :disabled="activeHunkIndex <= 0"
              @click="jumpToAdjacentHunk(-1)"
            >
              <ChevronUp class="h-4 w-4" />
            </button>
            <span class="min-w-[64px] text-center text-[11px] text-[var(--theme-textSecondary)]">
              {{ t('diffReview.changeIndex', { current: Math.min(activeHunkIndex + 1, selectedPatchHunks.length), total: selectedPatchHunks.length }) }}
            </span>
            <button
              type="button"
              class="theme-icon-button h-6 w-6 disabled:opacity-50"
              :disabled="activeHunkIndex >= selectedPatchHunks.length - 1"
              @click="jumpToAdjacentHunk(1)"
            >
              <ChevronDown class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div class="hidden items-center gap-3 sm:flex">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span class="inline-flex rounded-sm border px-1.5 py-0.5 text-[10px]" :class="getStatusClass(selectedFile.status)">
            {{ getStatusLabel(selectedFile.status) }}
          </span>
          <span class="break-all font-medium text-[var(--theme-textPrimary)]">{{ selectedFile.path }}</span>
          <span class="opacity-75">
            {{ selectedFile.statsLoaded ? `+${selectedFile.additions} / -${selectedFile.deletions}` : t('diffReview.statsOnDemand') }}
          </span>
        </div>
        <div
          class="inline-flex h-8 w-[132px] shrink-0 items-center gap-1 rounded-sm border px-1.5 py-1"
          :class="selectedPatchHunks.length
            ? 'theme-inline-panel'
            : 'pointer-events-none invisible border-transparent'"
        >
          <button
            type="button"
            class="theme-icon-button h-6 w-6 disabled:opacity-50"
            :disabled="activeHunkIndex <= 0"
            @click="jumpToAdjacentHunk(-1)"
          >
            <ChevronUp class="h-4 w-4" />
          </button>
          <span class="min-w-[64px] text-center text-[11px] text-[var(--theme-textSecondary)]">
            {{ t('diffReview.changeIndex', { current: Math.min(activeHunkIndex + 1, selectedPatchHunks.length), total: selectedPatchHunks.length }) }}
          </span>
          <button
            type="button"
            class="theme-icon-button h-6 w-6 disabled:opacity-50"
            :disabled="activeHunkIndex >= selectedPatchHunks.length - 1"
            @click="jumpToAdjacentHunk(1)"
          >
            <ChevronDown class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>

    <div v-if="selectedFile.message" class="theme-secondary-text flex-1 overflow-y-auto px-4 py-4 text-sm">
      <div class="theme-empty-state px-4 py-4">
        {{ selectedFile.message }}
      </div>
    </div>
    <div v-else-if="patchLoading && !selectedFile.patchLoaded" class="theme-muted-text flex-1 overflow-y-auto px-4 py-4 text-sm">{{ t('diffReview.loadingFileDiff') }}</div>
    <div v-else-if="selectedPatchLines.length" :ref="setPatchViewportRef" class="flex-1 overflow-auto">
      <div class="min-w-max px-4 py-4 font-mono text-[11px] leading-5">
        <div
          v-for="line in selectedPatchLines"
          :key="line.id"
          :ref="(element) => setPatchLineRef(line.id, element)"
          class="grid grid-cols-[56px_56px_minmax(0,1fr)]"
          :class="[
            getPatchLineClass(line.kind),
            line.kind === 'hunk' && selectedPatchHunks[activeHunkIndex]?.id === line.id
              ? 'ring-1 ring-inset ring-[var(--theme-warning)]'
              : '',
          ]"
        >
          <span class="select-none border-r border-[var(--theme-borderMuted)] px-2 py-0.5 text-right opacity-60">
            {{ line.oldNumber }}
          </span>
          <span class="select-none border-r border-[var(--theme-borderMuted)] px-2 py-0.5 text-right opacity-60">
            {{ line.newNumber }}
          </span>
          <pre class="overflow-visible whitespace-pre px-3 py-0.5">{{ line.content }}</pre>
        </div>
      </div>
    </div>
    <div v-else class="theme-secondary-text flex-1 overflow-y-auto px-4 py-4 text-sm">
      <div class="theme-empty-state px-4 py-4">
        {{ t('diffReview.noFileDiffContent') }}
      </div>
    </div>
  </div>

  <div v-else class="theme-muted-text flex h-full items-center justify-center px-5 text-sm">
    {{ t('diffReview.selectFile') }}
  </div>
</template>
