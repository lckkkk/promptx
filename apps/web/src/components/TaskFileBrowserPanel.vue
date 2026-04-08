<script setup>
import { computed, reactive, ref, watch } from 'vue'
import {
  ChevronRight,
  File,
  FolderOpen,
  LoaderCircle,
  Search,
} from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import { useMediaQuery } from '../composables/useMediaQuery.js'
import { useWorkspacePickerData } from '../composables/useWorkspacePickerData.js'
import { getCodexSessionFileContent } from '../lib/codexApi.js'
import { renderCodexMarkdown } from '../lib/codexMarkdown.js'

const props = defineProps({
  active: {
    type: Boolean,
    default: false,
  },
  focusToken: {
    type: Number,
    default: 0,
  },
  sessionId: {
    type: String,
    default: '',
  },
})

const { t } = useI18n()
const { matches: isMobileLayout } = useMediaQuery('(max-width: 767px)')
const query = ref('')
const selectedItemPath = ref('')
const selectedItemType = ref('')
const previewLoading = ref(false)
const previewError = ref('')
const previewPayload = ref(null)
const mobilePanelTab = ref('tree')

const pickerProps = reactive({
  open: props.active,
  sessionId: props.sessionId,
  query: query.value,
})

const pickerState = useWorkspacePickerData({
  autoExpandRoots: false,
  props: pickerProps,
  restoreExpandedPaths: false,
  onSelect: (item) => {
    handleSelectItem(item)
  },
})

const {
  activeKey,
  activeTab,
  currentError,
  currentLoading,
  getDisplayName,
  getHighlightedName,
  getHighlightedPath,
  handleQueryChange,
  handleSessionChange,
  handleVisibleItemsChange,
  initializeData,
  normalSearchItems,
  recentSearchItems,
  resetData,
  setActiveTab,
  setItemRef,
  showSearchEmptyState,
  showSearchPromptState,
  showTreeEmptyState,
  toggleDirectory,
  treeItems,
  visibleItems,
} = pickerState

const selectedFilePath = computed(() => (
  selectedItemType.value === 'file' ? selectedItemPath.value : ''
))

const previewTitle = computed(() => selectedFilePath.value || t('fileBrowser.selectFile'))
const previewContent = computed(() => String(previewPayload.value?.content || ''))
const previewIsBinary = computed(() => previewPayload.value?.type === 'binary')
const previewTruncated = computed(() => Boolean(previewPayload.value?.truncated))
const previewIsMarkdown = computed(() => {
  const targetPath = String(selectedFilePath.value || '').toLowerCase()
  return targetPath.endsWith('.md') || targetPath.endsWith('.markdown') || targetPath.endsWith('.mdx')
})
const markdownPreviewHtml = computed(() => {
  if (!previewIsMarkdown.value || previewIsBinary.value) {
    return ''
  }

  return renderCodexMarkdown(previewContent.value)
})

async function loadPreview(filePath) {
  if (!props.sessionId || !filePath) {
    previewPayload.value = null
    previewError.value = ''
    previewLoading.value = false
    return
  }

  previewLoading.value = true
  previewError.value = ''

  try {
    previewPayload.value = await getCodexSessionFileContent(props.sessionId, filePath, {
      maxBytes: 160 * 1024,
    })
  } catch (error) {
    previewPayload.value = null
    previewError.value = error?.message || t('fileBrowser.loadFailed')
  } finally {
    previewLoading.value = false
  }
}

async function handleSelectItem(item) {
  if (!item?.path) {
    return
  }

  selectedItemPath.value = item.path
  selectedItemType.value = item.type || ''

  if (item.type === 'directory') {
    previewPayload.value = null
    previewError.value = ''
    if (activeTab.value === 'tree') {
      await toggleDirectory(item.path)
    }
    return
  }

  await loadPreview(item.path)
  if (isMobileLayout.value) {
    mobilePanelTab.value = 'preview'
  }
}

watch(
  () => props.active,
  (active) => {
    pickerProps.open = active
    if (!active) {
      resetData()
      return
    }
    initializeData()
  },
  { immediate: true }
)

watch(
  () => props.sessionId,
  (sessionId) => {
    pickerProps.sessionId = sessionId
    selectedItemPath.value = ''
    selectedItemType.value = ''
    previewPayload.value = null
    previewError.value = ''
    handleSessionChange()
  }
)

watch(query, (value) => {
  pickerProps.query = value
  handleQueryChange()
})

watch(
  () => props.focusToken,
  () => {
    if (!props.active) {
      return
    }
    if (isMobileLayout.value) {
      mobilePanelTab.value = 'tree'
    }
  }
)

watch(visibleItems, () => {
  handleVisibleItemsChange()
}, { immediate: true })

watch(activeKey, () => {
  handleVisibleItemsChange()
})

watch(isMobileLayout, (mobile) => {
  if (!mobile) {
    mobilePanelTab.value = 'tree'
  }
}, { immediate: true })
</script>

<template>
  <section class="panel flex h-full min-h-0 flex-col overflow-hidden">
    <div class="theme-divider border-b px-4 py-3">
      <div class="flex flex-col gap-2">
        <div class="theme-input-shell flex h-10 items-center gap-2 rounded-sm border px-3 transition focus-within:ring-2">
          <Search class="h-4 w-4 shrink-0 text-[var(--theme-textMuted)]" />
          <input
            v-model="query"
            type="text"
            :placeholder="t('fileBrowser.searchPlaceholder')"
            class="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-[var(--theme-textPrimary)] outline-none placeholder:text-[var(--theme-textMuted)]"
          >
        </div>

        <div v-if="isMobileLayout" class="grid grid-cols-2 gap-2">
          <button
            type="button"
            class="tool-button inline-flex items-center justify-center gap-2 px-3 py-2 text-xs"
            :class="mobilePanelTab === 'tree' ? 'theme-filter-active' : ''"
            @click="mobilePanelTab = 'tree'"
          >
            {{ t('fileBrowser.treeTab') }}
          </button>
          <button
            type="button"
            class="tool-button inline-flex items-center justify-center gap-2 px-3 py-2 text-xs"
            :class="mobilePanelTab === 'preview' ? 'theme-filter-active' : ''"
            @click="mobilePanelTab = 'preview'"
          >
            {{ t('fileBrowser.previewTab') }}
          </button>
        </div>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-hidden">
      <div
        class="grid h-full min-h-0"
        :class="isMobileLayout ? 'grid-cols-1' : 'md:grid-cols-[minmax(280px,360px)_minmax(0,1fr)]'"
      >
        <div
          v-if="!isMobileLayout || mobilePanelTab === 'tree'"
          class="theme-divider min-h-0 overflow-hidden border-b md:border-b-0 md:border-r"
        >
          <div class="h-full overflow-y-auto p-2">
            <div
              v-if="!sessionId"
              class="theme-empty-state px-3 py-6 text-sm"
            >
              {{ t('fileBrowser.selectProjectFirst') }}
            </div>

            <div
              v-else-if="currentError"
              class="theme-status-danger rounded-sm border border-dashed px-3 py-3 text-xs"
            >
              {{ currentError }}
            </div>

            <div
              v-else-if="showSearchPromptState"
              class="theme-empty-state px-3 py-6 text-sm"
            >
              {{ t('pathPicker.searchPrompt') }}
            </div>

            <div
              v-else-if="showSearchEmptyState"
              class="theme-empty-state px-3 py-6 text-sm"
            >
              {{ t('pathPicker.noResults') }}
            </div>

            <div
              v-else-if="showTreeEmptyState"
              class="theme-empty-state px-3 py-6 text-sm"
            >
              {{ t('fileBrowser.emptyTree') }}
            </div>

            <div
              v-else-if="currentLoading && !visibleItems.length"
              class="theme-empty-state flex items-center justify-center gap-2 px-3 py-6 text-sm"
            >
              <LoaderCircle class="h-4 w-4 animate-spin" />
              <span>{{ t('fileBrowser.loadingTree') }}</span>
            </div>

            <div v-else-if="activeTab === 'search'" class="space-y-1">
              <div
                v-if="recentSearchItems.length"
                class="theme-muted-text px-1 py-0.5 text-[10px] uppercase tracking-[0.12em]"
              >
                {{ t('pathPicker.recent') }}
              </div>
              <button
                v-for="item in recentSearchItems"
                :key="`recent-${item.path}`"
                :ref="(element) => setItemRef(item.path, element)"
                type="button"
                class="flex w-full items-start gap-2 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition"
                :class="selectedItemPath === item.path ? 'theme-list-item-active' : 'theme-list-item-hover'"
                @mouseenter="activeKey = item.path"
                @click="handleSelectItem(item)"
              >
                <component :is="item.type === 'directory' ? FolderOpen : File" class="theme-muted-text mt-0.5 h-4 w-4 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div>
                    <span class="truncate text-[13px] text-[var(--theme-textPrimary)]" v-html="getHighlightedName(item)" />
                  </div>
                  <div class="theme-muted-text truncate font-mono text-[10px]" v-html="getHighlightedPath(item)" />
                </div>
              </button>

              <div
                v-if="normalSearchItems.length"
                class="theme-muted-text px-1 py-0.5 text-[10px] uppercase tracking-[0.12em]"
              >
                {{ t('pathPicker.results') }}
              </div>
              <button
                v-for="item in normalSearchItems"
                :key="`search-${item.path}`"
                :ref="(element) => setItemRef(item.path, element)"
                type="button"
                class="flex w-full items-start gap-2 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition"
                :class="selectedItemPath === item.path ? 'theme-list-item-active' : 'theme-list-item-hover'"
                @mouseenter="activeKey = item.path"
                @click="handleSelectItem(item)"
              >
                <component :is="item.type === 'directory' ? FolderOpen : File" class="theme-muted-text mt-0.5 h-4 w-4 shrink-0" />
                <div class="min-w-0 flex-1">
                  <div>
                    <span class="truncate text-[13px] text-[var(--theme-textPrimary)]" v-html="getHighlightedName(item)" />
                  </div>
                  <div class="theme-muted-text truncate font-mono text-[10px]" v-html="getHighlightedPath(item)" />
                </div>
              </button>
            </div>

            <div v-else class="space-y-1">
              <div
                v-for="item in treeItems"
                :key="item.path"
                :ref="(element) => setItemRef(item.path, element)"
                class="rounded-sm border border-transparent px-1.5 py-1 transition"
                :class="selectedItemPath === item.path
                  ? 'theme-list-item-active'
                  : item.type === 'directory' && item.expanded
                    ? 'theme-list-item-expanded'
                    : 'theme-list-item-hover'"
                :style="{ paddingLeft: `${item.depth * 16 + 6}px` }"
                @mouseenter="activeKey = item.path"
              >
                <div class="flex items-start gap-1.5">
                  <button
                    v-if="item.type === 'directory'"
                    type="button"
                    class="theme-icon-button h-5 w-5 shrink-0"
                    @click.stop="toggleDirectory(item.path)"
                  >
                    <LoaderCircle v-if="item.loading" class="h-3.5 w-3.5 animate-spin" />
                    <ChevronRight v-else class="h-3.5 w-3.5 transition" :class="item.expanded ? 'rotate-90 text-[var(--theme-textPrimary)]' : ''" />
                  </button>
                  <span v-else class="block h-5 w-5 shrink-0" />

                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm px-0.5 py-0.5 text-left"
                    @click="handleSelectItem(item)"
                  >
                    <component
                      :is="item.type === 'directory' ? FolderOpen : File"
                      class="h-4 w-4 shrink-0"
                      :class="item.type === 'directory' && item.expanded ? 'text-[var(--theme-textPrimary)]' : 'text-[var(--theme-textMuted)]'"
                    />
                    <div class="min-w-0 flex-1">
                      <div class="truncate text-[13px]" :class="item.type === 'directory' ? 'font-medium text-[var(--theme-textPrimary)]' : 'text-[var(--theme-textPrimary)]'">
                        {{ getDisplayName(item) }}
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div
          v-if="!isMobileLayout || mobilePanelTab === 'preview'"
          class="min-h-0 overflow-hidden"
        >
          <div class="theme-divider border-b px-4 py-3">
            <div class="theme-muted-text truncate font-mono text-xs">
              {{ previewTitle }}
            </div>
          </div>

          <div class="h-full overflow-y-auto">
            <div v-if="!sessionId" class="theme-empty-state px-4 py-6 text-sm">
              {{ t('fileBrowser.selectProjectFirst') }}
            </div>
            <div v-else-if="previewLoading" class="theme-empty-state flex items-center justify-center gap-2 px-4 py-8 text-sm">
              <LoaderCircle class="h-4 w-4 animate-spin" />
              <span>{{ t('fileBrowser.loadingPreview') }}</span>
            </div>
            <div v-else-if="previewError" class="theme-status-danger m-4 rounded-sm border border-dashed px-3 py-3 text-sm">
              {{ previewError }}
            </div>
            <div v-else-if="selectedItemType === 'directory'" class="theme-empty-state px-4 py-8 text-sm">
              {{ t('fileBrowser.directoryHint') }}
            </div>
            <div v-else-if="!selectedFilePath" class="theme-empty-state px-4 py-8 text-sm">
              {{ t('fileBrowser.selectFile') }}
            </div>
            <div v-else-if="previewIsBinary" class="theme-empty-state px-4 py-8 text-sm">
              {{ t('fileBrowser.binaryPreviewUnavailable') }}
            </div>
            <div v-else class="min-h-full px-4 py-4">
              <div v-if="previewTruncated" class="theme-status-warning mb-3 rounded-sm border border-dashed px-3 py-2 text-xs">
                {{ t('fileBrowser.fileTooLarge') }}
              </div>
              <div
                v-if="previewIsMarkdown"
                class="codex-markdown overflow-y-auto text-sm"
                v-html="markdownPreviewHtml"
              />
              <pre v-else class="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[13px] leading-6 text-[var(--theme-textPrimary)]">{{ previewContent }}</pre>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
