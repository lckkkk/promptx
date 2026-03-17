<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  Check,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Search,
  X,
} from 'lucide-vue-next'
import {
  listCodexDirectoryTree,
  searchCodexDirectories,
} from '../lib/api.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  initialPath: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['close', 'select'])

const homePath = ref('')
const rootNode = ref(null)
const treeLoading = ref(false)
const treeError = ref('')
const searchLoading = ref(false)
const searchError = ref('')
const searchResults = ref([])
const searchTruncated = ref(false)
const query = ref('')
const activeTab = ref('tree')
const selectedPath = ref('')
const selectedName = ref('')

let searchTimer = null
let searchRequestId = 0

const treeItems = computed(() => flattenTreeNodes(rootNode.value ? [rootNode.value] : []))
const showSearchPromptState = computed(() => activeTab.value === 'search' && !query.value.trim())
const showSearchEmptyState = computed(() => activeTab.value === 'search' && !!query.value.trim() && !searchLoading.value && !searchError.value && !searchResults.value.length)
const showTreeEmptyState = computed(() => activeTab.value === 'tree' && !treeLoading.value && !treeError.value && !treeItems.value.length)

function isWindowsPath(value = '') {
  const text = String(value || '').trim()
  return /^[a-z]:[\\/]/i.test(text) || text.includes('\\')
}

function normalizePathForCompare(value = '') {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  const windows = isWindowsPath(raw)
  let normalized = raw.replace(/\\/g, '/')

  if (normalized.length > 1 && !/^[a-z]:\/?$/i.test(normalized) && normalized !== '/') {
    normalized = normalized.replace(/\/+$/, '')
  }

  return windows ? normalized.toLowerCase() : normalized
}

function pathStartsWith(targetPath = '', basePath = '') {
  const target = normalizePathForCompare(targetPath)
  const base = normalizePathForCompare(basePath)
  if (!target || !base) {
    return false
  }

  return target === base || target.startsWith(`${base}/`)
}

function joinPath(basePath = '', segment = '') {
  const base = String(basePath || '').trim()
  const child = String(segment || '').trim()
  if (!base) {
    return child
  }
  if (!child) {
    return base
  }

  if (isWindowsPath(base)) {
    if (/^[a-z]:\\?$/i.test(base)) {
      return `${base.replace(/[\\/]+$/, '')}\\${child}`
    }
    return `${base.replace(/[\\/]+$/, '')}\\${child}`
  }

  if (base === '/') {
    return `/${child}`
  }

  return `${base.replace(/\/+$/, '')}/${child}`
}

function getRelativeSegments(basePath = '', targetPath = '') {
  const base = normalizePathForCompare(basePath)
  const target = normalizePathForCompare(targetPath)
  if (!base || !target || !pathStartsWith(target, base)) {
    return []
  }

  const remainder = target === base ? '' : target.slice(base.length).replace(/^\//, '')
  return remainder ? remainder.split('/').filter(Boolean) : []
}

function getParentPath(pathValue = '') {
  const raw = String(pathValue || '').trim()
  if (!raw || normalizePathForCompare(raw) === normalizePathForCompare(homePath.value)) {
    return ''
  }

  const windows = isWindowsPath(raw)
  const normalized = raw.replace(/\\/g, '/')

  if (windows) {
    const trimmed = normalized.replace(/\/+$/, '')
    const index = trimmed.lastIndexOf('/')
    if (index <= 2) {
      return ''
    }
    const parent = trimmed.slice(0, index).replace(/\//g, '\\')
    return pathStartsWith(parent, homePath.value) ? parent : ''
  }

  const trimmed = normalized.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) {
    return ''
  }
  const parent = trimmed.slice(0, index) || '/'
  return pathStartsWith(parent, homePath.value) ? parent : ''
}

function getDisplayName(item) {
  return item?.name || item?.path || '未命名目录'
}

function getRootDisplayName(pathValue = '') {
  const normalized = String(pathValue || '').trim()
  if (!normalized) {
    return 'Home'
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || normalized
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function findHighlightRange(text = '', keyword = '') {
  const source = String(text || '')
  const queryText = String(keyword || '').trim().toLowerCase()
  if (!source || !queryText) {
    return null
  }

  const normalizedSource = source.toLowerCase()
  const directIndex = normalizedSource.indexOf(queryText)
  if (directIndex >= 0) {
    return { start: directIndex, end: directIndex + queryText.length }
  }

  const tokens = queryText
    .split(/[\\/\s_.-]+/)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)

  for (const token of tokens) {
    if (token.length < 2) {
      continue
    }

    const tokenIndex = normalizedSource.indexOf(token)
    if (tokenIndex >= 0) {
      return { start: tokenIndex, end: tokenIndex + token.length }
    }
  }

  return null
}

function renderHighlightedText(text = '', keyword = '') {
  const source = String(text || '')
  const range = findHighlightRange(source, keyword)
  if (!range) {
    return escapeHtml(source)
  }

  return `${escapeHtml(source.slice(0, range.start))}<mark class="rounded bg-[var(--theme-warningSoft)] px-0.5 text-inherit">${escapeHtml(source.slice(range.start, range.end))}</mark>${escapeHtml(source.slice(range.end))}`
}

function getHighlightedName(item) {
  return renderHighlightedText(getDisplayName(item), query.value)
}

function getHighlightedPath(item) {
  return renderHighlightedText(item?.path || '', query.value)
}

function createTreeNode(entry, depth = 0) {
  return {
    ...entry,
    depth,
    expanded: false,
    loaded: false,
    loading: false,
    children: [],
  }
}

function flattenTreeNodes(nodes = [], output = []) {
  nodes.forEach((node) => {
    output.push(node)
    if (node.expanded && node.children.length) {
      flattenTreeNodes(node.children, output)
    }
  })
  return output
}

function refreshTree() {
  if (rootNode.value) {
    rootNode.value = { ...rootNode.value }
  }
}

function findTreeNode(targetPath, nodes = rootNode.value ? [rootNode.value] : []) {
  const compareKey = normalizePathForCompare(targetPath)
  if (!compareKey) {
    return null
  }

  for (const node of nodes) {
    if (normalizePathForCompare(node.path) === compareKey) {
      return node
    }
    if (node.children.length) {
      const nested = findTreeNode(targetPath, node.children)
      if (nested) {
        return nested
      }
    }
  }

  return null
}

function updateSelectedDirectory(item) {
  selectedPath.value = String(item?.path || '').trim()
  selectedName.value = getDisplayName(item)
}

async function loadDirectoryNode(node, options = {}) {
  if (!node || node.loading) {
    return
  }

  if (node.loaded && !options.force) {
    return
  }

  node.loading = true
  treeError.value = ''
  refreshTree()

  try {
    const payload = await listCodexDirectoryTree({
      path: node.path,
      limit: 240,
    })
    node.children = (payload.items || []).map((item) => createTreeNode(item, node.depth + 1))
    node.loaded = true
  } catch (err) {
    treeError.value = err.message || '目录加载失败。'
  } finally {
    node.loading = false
    refreshTree()
  }
}

async function loadHomeRoot() {
  treeLoading.value = true
  treeError.value = ''

  try {
    const payload = await listCodexDirectoryTree({
      limit: 240,
    })
    homePath.value = String(payload.path || '')
    rootNode.value = createTreeNode({
      name: getRootDisplayName(payload.path || ''),
      path: String(payload.path || ''),
      type: 'directory',
      hasChildren: true,
      isHomeRoot: true,
    }, 0)
    rootNode.value.children = (payload.items || []).map((item) => createTreeNode(item, 1))
    rootNode.value.loaded = true
    rootNode.value.expanded = true
    updateSelectedDirectory(rootNode.value)
  } catch (err) {
    treeError.value = err.message || '目录树加载失败。'
    rootNode.value = null
    homePath.value = ''
  } finally {
    treeLoading.value = false
  }
}

async function expandToPath(targetPath = '') {
  const normalizedTarget = String(targetPath || '').trim()
  if (!normalizedTarget || !homePath.value || !pathStartsWith(normalizedTarget, homePath.value)) {
    return
  }

  let node = rootNode.value
  if (!node) {
    return
  }

  updateSelectedDirectory(node)

  const segments = getRelativeSegments(homePath.value, normalizedTarget)
  for (const segment of segments) {
    await loadDirectoryNode(node)
    node.expanded = true
    refreshTree()
    const nextNode = findTreeNode(joinPath(node.path, segment), node.children)
    if (!nextNode) {
      break
    }
    node = nextNode
    updateSelectedDirectory(node)
  }
}

async function initializePicker() {
  query.value = ''
  activeTab.value = 'tree'
  searchResults.value = []
  searchError.value = ''
  searchTruncated.value = false
  selectedPath.value = ''
  selectedName.value = ''

  await loadHomeRoot()

  const targetPath = String(props.initialPath || '').trim()
  if (targetPath && pathStartsWith(targetPath, homePath.value)) {
    await expandToPath(targetPath)
  }
}

async function toggleDirectory(item) {
  if (!item?.path) {
    return
  }

  updateSelectedDirectory(item)

  if (!item.hasChildren) {
    return
  }

  if (!item.loaded) {
    item.expanded = true
    refreshTree()
    await loadDirectoryNode(item)
    return
  }

  item.expanded = !item.expanded
  refreshTree()
}

function handleTreeSelect(item) {
  if (!item?.path) {
    return
  }

  updateSelectedDirectory(item)
  activeTab.value = 'tree'
}

async function refreshSearch() {
  const keyword = String(query.value || '').trim()
  searchRequestId += 1
  const requestId = searchRequestId

  if (!props.open || !keyword || !homePath.value) {
    searchLoading.value = false
    searchError.value = ''
    searchResults.value = []
    searchTruncated.value = false
    return
  }

  searchLoading.value = true
  searchError.value = ''

  try {
    const payload = await searchCodexDirectories(keyword, {
      path: homePath.value,
      limit: 80,
    })

    if (requestId !== searchRequestId) {
      return
    }

    searchResults.value = Array.isArray(payload.items) ? payload.items : []
    searchTruncated.value = Boolean(payload.truncated)
  } catch (err) {
    if (requestId !== searchRequestId) {
      return
    }

    searchError.value = err.message || '搜索失败。'
    searchResults.value = []
    searchTruncated.value = false
  } finally {
    if (requestId === searchRequestId) {
      searchLoading.value = false
    }
  }
}

function scheduleSearch() {
  if (searchTimer) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }

  if (!String(query.value || '').trim()) {
    searchLoading.value = false
    searchError.value = ''
    searchResults.value = []
    searchTruncated.value = false
    return
  }

  searchLoading.value = true
  searchError.value = ''
  searchTimer = window.setTimeout(() => {
    refreshSearch()
  }, 120)
}

async function handleSearchSelect(item) {
  if (!item?.path) {
    return
  }

  activeTab.value = 'tree'
  await expandToPath(item.path)
}

function handlePick() {
  if (!selectedPath.value) {
    return
  }

  emit('select', selectedPath.value)
  emit('close')
}

function handleKeydown(event) {
  if (!props.open) {
    return
  }

  if (event.key === 'Escape') {
    emit('close')
  }
}

watch(query, () => {
  activeTab.value = query.value.trim() ? 'search' : 'tree'
  scheduleSearch()
})

watch(
  () => props.open,
  (open) => {
    document.body.classList.toggle('overflow-hidden', open)

    if (open) {
      window.addEventListener('keydown', handleKeydown)
      initializePicker().catch(() => {})
      return
    }

    window.removeEventListener('keydown', handleKeydown)
    if (searchTimer) {
      window.clearTimeout(searchTimer)
      searchTimer = null
    }
  }
)

onBeforeUnmount(() => {
  document.body.classList.remove('overflow-hidden')
  window.removeEventListener('keydown', handleKeydown)
  if (searchTimer) {
    window.clearTimeout(searchTimer)
  }
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[60] flex items-end justify-center bg-black/45 px-0 py-0 backdrop-blur-sm sm:items-center sm:px-4 sm:py-6"
      @click.self="!(treeLoading || searchLoading) && emit('close')"
    >
      <section class="panel flex h-full w-full max-w-4xl flex-col overflow-hidden sm:h-auto sm:max-h-[86vh]">
        <div class="theme-divider flex items-start justify-between gap-3 border-b px-4 py-3 sm:px-5 sm:py-4">
          <div>
            <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
              <FolderOpen class="h-4 w-4" />
              <span>选择工作目录</span>
            </div>
            <p class="theme-muted-text mt-1 text-xs leading-5">
              默认只在当前用户目录下浏览和搜索；特殊路径继续用手动输入。
            </p>
          </div>

          <button
            type="button"
            class="theme-icon-button h-9 w-9"
            :disabled="treeLoading || searchLoading"
            @click="emit('close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <div class="flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 sm:px-5">
          <div class="theme-divider mt-4 rounded-sm border border-dashed px-3 py-2">
            <div class="flex items-start gap-2 text-xs leading-5">
              <span class="theme-muted-text shrink-0">当前选中</span>
              <span class="min-w-0 break-all font-mono text-[var(--theme-textPrimary)]">
                {{ selectedPath || '请在目录树或搜索结果里选择目录' }}
              </span>
            </div>
          </div>

          <label class="theme-muted-text mt-4 block text-xs">
            <span>搜索目录</span>
            <div
              class="mt-1 flex h-10 items-center gap-2 rounded-sm border px-3 transition focus-within:ring-2"
              :style="{
                borderColor: 'var(--theme-inputBorder)',
                background: 'var(--theme-inputBg)',
                color: 'var(--theme-textPrimary)',
                '--tw-ring-color': 'var(--theme-focusRing)',
              }"
            >
              <Search class="h-4 w-4 shrink-0 text-[var(--theme-textMuted)]" />
              <input
                v-model="query"
                type="text"
                placeholder="输入目录名或路径片段，例如 promptx / code"
                class="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-[var(--theme-textPrimary)] outline-none placeholder:text-[var(--theme-textMuted)]"
              >
            </div>
          </label>

          <div class="mt-4 flex items-center gap-1.5">
            <button
              type="button"
              class="inline-flex h-8 items-center gap-1 rounded-sm border px-2 text-[11px] transition"
              :class="activeTab === 'search' ? 'tool-button-primary' : 'theme-filter-idle border-dashed'"
              @click="activeTab = 'search'"
            >
              <Search class="h-3.5 w-3.5" />
              <span>搜索</span>
            </button>
            <button
              type="button"
              class="inline-flex h-8 items-center gap-1 rounded-sm border px-2 text-[11px] transition"
              :class="activeTab === 'tree' ? 'tool-button-primary' : 'theme-filter-idle border-dashed'"
              @click="activeTab = 'tree'"
            >
              <FolderOpen class="h-3.5 w-3.5" />
              <span>目录树</span>
            </button>
          </div>

          <div class="mt-3 min-h-0 flex-1 overflow-y-auto rounded-sm border border-dashed border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelStrong)] p-2">
            <div
              v-if="activeTab === 'search' && searchError"
              class="theme-status-danger rounded-sm border border-dashed px-3 py-3 text-xs"
            >
              {{ searchError }}
            </div>

            <div
              v-else-if="activeTab === 'tree' && treeError"
              class="theme-status-danger rounded-sm border border-dashed px-3 py-3 text-xs"
            >
              {{ treeError }}
            </div>

            <div
              v-else-if="activeTab === 'search' && searchLoading"
              class="theme-empty-state flex items-center justify-center gap-2 px-3 py-8 text-sm"
            >
              <LoaderCircle class="h-4 w-4 animate-spin" />
              <span>搜索中...</span>
            </div>

            <div
              v-else-if="activeTab === 'tree' && treeLoading"
              class="theme-empty-state flex items-center justify-center gap-2 px-3 py-8 text-sm"
            >
              <LoaderCircle class="h-4 w-4 animate-spin" />
              <span>目录树加载中...</span>
            </div>

            <div
              v-else-if="showSearchPromptState"
              class="theme-empty-state px-3 py-8 text-sm"
            >
              输入关键词后，只会在当前用户目录下搜索。
            </div>

            <div
              v-else-if="showSearchEmptyState"
              class="theme-empty-state px-3 py-8 text-sm"
            >
              没搜到匹配目录，试试更短的关键词，或者直接用目录树浏览。
            </div>

            <div
              v-else-if="showTreeEmptyState"
              class="theme-empty-state px-3 py-8 text-sm"
            >
              当前没有可显示的目录。
            </div>

            <div v-else-if="activeTab === 'search'" class="space-y-1">
              <button
                v-for="item in searchResults"
                :key="item.path"
                type="button"
                class="flex w-full items-start gap-2 rounded-sm border border-transparent px-2.5 py-1.5 text-left transition"
                :class="normalizePathForCompare(selectedPath) === normalizePathForCompare(item.path)
                  ? 'bg-[var(--theme-appPanelInset)]'
                  : 'hover:bg-[var(--theme-appPanelMuted)]'"
                @click="handleSearchSelect(item)"
              >
                <FolderOpen class="theme-muted-text mt-0.5 h-4 w-4 shrink-0" />
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
              <p v-if="searchTruncated" class="theme-muted-text px-1 pt-2 text-xs">
                搜索结果已截断，只展示最相关的一部分目录。
              </p>
            </div>

            <div v-else class="space-y-1">
              <div
                v-for="item in treeItems"
                :key="item.path"
                class="rounded-sm border border-transparent px-1.5 py-1 transition"
                :class="normalizePathForCompare(selectedPath) === normalizePathForCompare(item.path)
                  ? 'bg-[var(--theme-appPanelInset)]'
                  : item.expanded
                    ? 'bg-[var(--theme-appPanelMuted)]'
                    : 'hover:bg-[var(--theme-appPanelMuted)]'"
                :style="{ paddingLeft: `${item.depth * 16 + 6}px` }"
              >
                <div class="flex items-start gap-1.5">
                  <button
                    type="button"
                    class="theme-icon-button h-5 w-5 shrink-0"
                    :class="!item.hasChildren ? 'invisible pointer-events-none' : ''"
                    @click.stop="toggleDirectory(item)"
                  >
                    <LoaderCircle v-if="item.loading" class="h-3.5 w-3.5 animate-spin" />
                    <ChevronRight
                      v-else
                      class="h-3.5 w-3.5 transition"
                      :class="item.expanded ? 'rotate-90 text-[var(--theme-textPrimary)]' : ''"
                    />
                  </button>

                  <button
                    type="button"
                    class="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm px-0.5 py-0.5 text-left"
                    @click="handleTreeSelect(item)"
                  >
                    <FolderOpen
                      class="h-4 w-4 shrink-0"
                      :class="normalizePathForCompare(selectedPath) === normalizePathForCompare(item.path)
                        ? 'text-[var(--theme-textPrimary)]'
                        : 'text-[var(--theme-textMuted)]'"
                    />
                    <div class="min-w-0 flex-1">
                      <div
                        class="truncate text-[13px]"
                        :class="item.isHomeRoot
                          ? 'font-medium text-[var(--theme-textSecondary)]'
                          : 'font-medium text-[var(--theme-textPrimary)]'"
                      >
                        {{ getDisplayName(item) }}
                      </div>
                      <div
                        v-if="item.isHomeRoot"
                        class="theme-muted-text truncate font-mono text-[10px]"
                      >
                        {{ item.path }}
                      </div>
                    </div>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="theme-divider flex flex-col-reverse gap-2 border-t border-dashed px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-5">
          <div class="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
            <button
              type="button"
              class="tool-button w-full px-3 py-2 text-xs sm:w-auto"
              :disabled="treeLoading || searchLoading"
              @click="emit('close')"
            >
              取消
            </button>
            <button
              type="button"
              class="tool-button tool-button-primary inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-xs sm:w-auto"
              :disabled="treeLoading || searchLoading || !selectedPath"
              @click="handlePick"
            >
              <Check class="h-4 w-4" />
              <span>使用当前目录</span>
            </button>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
