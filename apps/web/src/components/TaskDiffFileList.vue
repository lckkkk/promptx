<script setup>
import { computed } from 'vue'
import { Search } from 'lucide-vue-next'

const props = defineProps({
  diffPayload: {
    type: Object,
    default: null,
  },
  fileSearch: {
    type: String,
    default: '',
  },
  filteredFiles: {
    type: Array,
    default: () => [],
  },
  getFilterButtonClass: {
    type: Function,
    default: () => '',
  },
  getFilterLabel: {
    type: Function,
    default: (value) => value,
  },
  getStatusClass: {
    type: Function,
    default: () => '',
  },
  getStatusLabel: {
    type: Function,
    default: (value) => value,
  },
  selectedFilePath: {
    type: String,
    default: '',
  },
  showSummarySkeleton: {
    type: Boolean,
    default: false,
  },
  statusCounts: {
    type: Object,
    default: () => ({}),
  },
  statusFilter: {
    type: String,
    default: 'all',
  },
})

const emit = defineEmits([
  'select-file',
  'update:fileSearch',
  'update:statusFilter',
])

const fileSearchModel = computed({
  get: () => props.fileSearch,
  set: (value) => emit('update:fileSearch', value),
})

const statusFilterModel = computed({
  get: () => props.statusFilter,
  set: (value) => emit('update:statusFilter', value),
})

const hasDiffFiles = computed(() => Array.isArray(props.diffPayload?.files) && props.diffPayload.files.length > 0)
</script>

<template>
  <div class="mb-3 flex flex-wrap gap-2">
    <button
      v-for="filter in ['all', 'A', 'M', 'D']"
      :key="filter"
      type="button"
      class="rounded-sm border px-2 py-1 text-[11px] transition"
      :class="getFilterButtonClass(filter)"
      @click="statusFilterModel = filter"
    >
      {{ getFilterLabel(filter) }} {{ statusCounts[filter] || 0 }}
    </button>
  </div>

  <label class="mb-3 flex items-center gap-2 rounded-sm border border-[var(--theme-inputBorder)] bg-[var(--theme-inputBg)] px-3 py-2 text-xs text-[var(--theme-textMuted)]">
    <Search class="h-3.5 w-3.5 shrink-0" />
    <input
      v-model="fileSearchModel"
      type="text"
      placeholder="搜索文件路径"
      class="min-w-0 flex-1 bg-transparent text-xs text-[var(--theme-textPrimary)] outline-none placeholder:text-[var(--theme-textMuted)]"
    >
  </label>

  <div
    v-if="showSummarySkeleton"
    class="theme-empty-state mb-3 bg-[var(--theme-appPanelStrong)] px-3 py-2 text-[11px]"
  >
    已先展示文件列表，整体增删行数正在后台统计...
  </div>

  <div v-if="!hasDiffFiles" class="theme-empty-state px-3 py-4 text-xs">
    当前范围内还没有检测到代码变更。
  </div>
  <div v-else-if="!filteredFiles.length" class="theme-empty-state px-3 py-4 text-xs">
    当前筛选或搜索条件下没有匹配文件。
  </div>

  <div v-else class="space-y-2">
    <button
      v-for="file in filteredFiles"
      :key="file.path"
      type="button"
      class="w-full rounded-sm border px-3 py-2 text-left transition"
      :class="file.path === selectedFilePath ? 'theme-filter-active' : 'theme-filter-idle'"
      @click="emit('select-file', file.path)"
    >
      <div class="flex items-start gap-2">
        <span class="inline-flex shrink-0 rounded-sm border px-1.5 py-0.5 text-[10px]" :class="getStatusClass(file.status)">
          {{ getStatusLabel(file.status) }}
        </span>
        <div class="min-w-0 flex-1">
          <div class="break-all text-xs font-medium">{{ file.path }}</div>
          <div class="mt-1 text-[11px] opacity-75">
            {{ file.statsLoaded ? `+${file.additions} / -${file.deletions}` : '行数按需统计' }}
          </div>
        </div>
      </div>
    </button>
  </div>
</template>
