<script setup>
import { ref } from 'vue'
import {
  ChevronRight,
  File,
  FolderOpen,
  LoaderCircle,
  Search,
  X,
} from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import { useWorkspaceTree } from '../composables/useWorkspaceTree.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  sessionId: {
    type: String,
    default: '',
  },
  query: {
    type: String,
    default: '',
  },
  anchorRect: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['close', 'select'])
const panelRef = ref(null)
const { t } = useI18n()

const {
  activeKey,
  activeTab,
  closePicker,
  collapseActiveDirectory,
  confirmActive,
  currentError,
  currentLoading,
  emitSelect,
  expandActiveDirectory,
  getDisplayName,
  getHighlightedName,
  getHighlightedPath,
  moveActive,
  normalSearchItems,
  normalizedQuery,
  panelReady,
  panelStyle,
  recentSearchItems,
  setActiveTab,
  setItemRef,
  showSearchEmptyState,
  showSearchPromptState,
  showTreeEmptyState,
  switchTab,
  toggleDirectory,
  treeItems,
  visibleItems,
} = useWorkspaceTree({
  props,
  panelRef,
  onClose: () => emit('close'),
  onSelect: (item) => emit('select', item),
})

defineExpose({
  collapseActiveDirectory,
  moveActive,
  confirmActive,
  expandActiveDirectory,
  switchTab,
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && panelReady"
      ref="panelRef"
      class="theme-popover fixed z-40 flex flex-col overflow-hidden rounded-sm border shadow-lg"
      :style="panelStyle"
    >
      <div class="theme-divider flex items-center justify-between gap-2 border-b border-dashed px-2.5 py-2">
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-[11px] transition"
            :class="activeTab === 'search'
              ? 'tool-button-accent-subtle'
              : 'theme-filter-idle border-dashed'"
            @click="setActiveTab('search')"
          >
            <Search class="h-3.5 w-3.5" />
            <span>{{ t('pathPicker.searchTab') }}</span>
          </button>
          <button
            type="button"
            class="inline-flex h-7 items-center gap-1 rounded-sm border px-2 text-[11px] transition"
            :class="activeTab === 'tree'
              ? 'tool-button-accent-subtle'
              : 'theme-filter-idle border-dashed'"
            @click="setActiveTab('tree')"
          >
            <FolderOpen class="h-3.5 w-3.5" />
            <span>{{ t('pathPicker.treeTab') }}</span>
          </button>
        </div>
        <div class="flex shrink-0 items-center gap-2">
          <div
            class="theme-muted-text inline-flex h-7 w-7 items-center justify-center"
            :class="currentLoading ? 'opacity-100' : 'opacity-0'"
          >
            <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
          </div>
          <button
            type="button"
            class="tool-button inline-flex h-7 w-7 items-center justify-center"
            @click="closePicker"
          >
            <X class="h-4 w-4" />
          </button>
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <div
          v-if="!sessionId"
          class="theme-empty-state px-3 py-4 text-xs"
        >
          {{ t('pathPicker.selectProjectFirst') }}
        </div>

        <div
          v-else-if="currentError"
          class="theme-status-danger rounded-sm border border-dashed px-3 py-3 text-xs"
        >
          {{ currentError }}
        </div>

        <div
          v-else-if="showSearchPromptState"
          class="theme-empty-state px-3 py-4 text-xs"
        >
          {{ t('pathPicker.searchPrompt') }}
        </div>

        <div
          v-else-if="showSearchEmptyState"
          class="theme-empty-state px-3 py-4 text-xs"
        >
          {{ t('pathPicker.noResults') }}
        </div>

        <div
          v-else-if="showTreeEmptyState"
          class="theme-empty-state px-3 py-4 text-xs"
        >
          {{ t('pathPicker.emptyDirectory') }}
        </div>

        <div
          v-else-if="currentLoading && !visibleItems.length"
          class="theme-empty-state px-3 py-4 text-xs"
        >
          {{ t('pathPicker.loading') }}
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
            :key="item.path"
            :ref="(element) => setItemRef(item.path, element)"
            type="button"
            class="flex w-full items-start gap-2 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition"
            :class="activeKey === item.path
              ? 'theme-list-item-active'
              : 'theme-list-item-hover'"
            @mouseenter="activeKey = item.path"
            @click="emitSelect(item)"
          >
            <component
              :is="item.type === 'directory' ? FolderOpen : File"
              class="theme-muted-text mt-0.5 h-4 w-4 shrink-0"
            />
            <div class="min-w-0 flex-1">
              <div>
                <span
                  class="truncate text-[13px] text-[var(--theme-textPrimary)]"
                  v-html="getHighlightedName(item)"
                />
              </div>
              <div
                class="theme-muted-text truncate font-mono text-[10px]"
                v-html="getHighlightedPath(item)"
              />
            </div>
          </button>
          <div
            v-if="normalizedQuery && normalSearchItems.length"
            class="theme-muted-text px-1 py-0.5 text-[10px] uppercase tracking-[0.12em]"
          >
            {{ t('pathPicker.results') }}
          </div>
          <button
            v-for="item in normalSearchItems"
            :key="item.path"
            :ref="(element) => setItemRef(item.path, element)"
            type="button"
            class="flex w-full items-start gap-2 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition"
            :class="activeKey === item.path
              ? 'theme-list-item-active'
              : 'theme-list-item-hover'"
            @mouseenter="activeKey = item.path"
            @click="emitSelect(item)"
          >
            <component
              :is="item.type === 'directory' ? FolderOpen : File"
              class="theme-muted-text mt-0.5 h-4 w-4 shrink-0"
            />
            <div class="min-w-0 flex-1">
              <div>
                <span
                  class="truncate text-[13px] text-[var(--theme-textPrimary)]"
                  v-html="getHighlightedName(item)"
                />
              </div>
              <div
                class="theme-muted-text truncate font-mono text-[10px]"
                v-html="getHighlightedPath(item)"
              />
            </div>
          </button>
        </div>

        <div v-else class="space-y-1">
          <div
            v-for="item in treeItems"
            :key="item.path"
            :ref="(element) => setItemRef(item.path, element)"
            class="rounded-sm border border-transparent px-1.5 py-1 transition"
            :class="activeKey === item.path
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
                @click="emitSelect(item)"
              >
                <component
                  :is="item.type === 'directory' ? FolderOpen : File"
                  class="h-4 w-4 shrink-0"
                  :class="item.type === 'directory' && item.expanded ? 'text-[var(--theme-textPrimary)]' : 'text-[var(--theme-textMuted)]'"
                />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span
                      class="truncate text-[13px]"
                      :class="item.type === 'directory' ? 'font-medium text-[var(--theme-textPrimary)]' : 'text-[var(--theme-textPrimary)]'"
                    >
                      {{ getDisplayName(item) }}
                    </span>
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
