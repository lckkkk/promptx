<script setup>
import { computed, ref } from 'vue'
import { ChevronDown, ChevronUp, Download, Eye, Code } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import { renderCodexMarkdown } from '../lib/codexMarkdown.js'

const props = defineProps({
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
  taskSlug: {
    type: String,
    default: '',
  },
})
const { t } = useI18n()

const viewMode = ref('diff') // 'diff' | 'preview'

const isMarkdownFile = computed(() => {
  const p = String(props.selectedFile?.path || '')
  return p.endsWith('.md') || p.endsWith('.mdx') || p.endsWith('.markdown')
})

const markdownPreviewHtml = computed(() => {
  if (!isMarkdownFile.value || !props.selectedPatchLines.length) return ''
  // 从 patch 行中提取最新内容（新增行 + 上下文行，去掉删除行）
  const lines = props.selectedPatchLines
    .filter((line) => line.kind === 'add' || line.kind === 'context')
    .map((line) => {
      const content = String(line.content || '')
      // 去掉 diff 前缀符号（+ 或空格）
      return content.startsWith('+') || content.startsWith(' ')
        ? content.slice(1)
        : content
    })
  return renderCodexMarkdown(lines.join('\n'))
})

function handleDownload() {
  const patch = String(props.selectedFile?.patch || '')
  if (!patch) return
  const fileName = (props.selectedFile?.path || 'changes').replace(/[/\\]/g, '_') + '.diff'
  const blob = new Blob([patch], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  URL.revokeObjectURL(url)
}

async function handleDownloadFile() {
  const filePath = props.selectedFile?.path
  const slug = props.taskSlug
  if (!filePath || !slug) return
  const url = `/api/tasks/${encodeURIComponent(slug)}/file-content?filePath=${encodeURIComponent(filePath)}`
  const a = document.createElement('a')
  a.href = url
  a.download = filePath.split('/').pop() || 'file'
  a.click()
}
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
          <div class="flex items-center gap-1.5">
            <button
              v-if="isMarkdownFile"
              type="button"
              class="theme-icon-button h-6 w-6"
              :title="viewMode === 'preview' ? '查看 Diff' : '预览 Markdown'"
              @click="viewMode = viewMode === 'preview' ? 'diff' : 'preview'"
            >
              <Eye v-if="viewMode === 'diff'" class="h-3.5 w-3.5" />
              <Code v-else class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              class="theme-icon-button h-6 w-6"
              title="下载 .diff 文件"
              :disabled="!selectedFile.patch"
              @click="handleDownload"
            >
              <Download class="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              class="theme-icon-button h-6 w-6"
              title="下载完整文件"
              :disabled="selectedFile.status === 'D'"
              @click="handleDownloadFile"
            >
              <Download class="h-3.5 w-3.5 opacity-60" />
            </button>
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
        <div class="flex items-center gap-1.5">
          <button
            v-if="isMarkdownFile"
            type="button"
            class="tool-button inline-flex items-center gap-1.5 px-2 py-1.5 text-xs"
            :class="viewMode === 'preview' ? 'theme-filter-active' : ''"
            @click="viewMode = viewMode === 'preview' ? 'diff' : 'preview'"
          >
            <Eye v-if="viewMode === 'diff'" class="h-3.5 w-3.5" />
            <Code v-else class="h-3.5 w-3.5" />
            <span>{{ viewMode === 'preview' ? 'Diff' : '预览' }}</span>
          </button>
          <button
            type="button"
            class="tool-button inline-flex items-center gap-1.5 px-2 py-1.5 text-xs"
            title="下载 .diff 文件"
            :disabled="!selectedFile.patch"
            @click="handleDownload"
          >
            <Download class="h-3.5 w-3.5" />
            <span>下载 Diff</span>
          </button>
          <button
            type="button"
            class="tool-button inline-flex items-center gap-1.5 px-2 py-1.5 text-xs"
            title="下载完整文件"
            :disabled="selectedFile.status === 'D'"
            @click="handleDownloadFile"
          >
            <Download class="h-3.5 w-3.5" />
            <span>下载文件</span>
          </button>
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
    </div>

    <!-- Markdown 预览模式 -->
    <div
      v-if="viewMode === 'preview' && isMarkdownFile"
      class="codex-markdown flex-1 overflow-y-auto px-6 py-5 text-sm"
      v-html="markdownPreviewHtml"
    />

    <!-- Diff 模式 -->
    <template v-else>
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
    </template>
  </div>

  <div v-else class="theme-muted-text flex h-full items-center justify-center px-5 text-sm">
    {{ t('diffReview.selectFile') }}
  </div>
</template>
