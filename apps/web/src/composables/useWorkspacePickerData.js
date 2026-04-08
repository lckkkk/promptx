import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import {
  listCodexSessionFiles,
  searchCodexSessionFiles,
} from '../lib/api.js'

const RECENT_PATHS_STORAGE_KEY = 'promptx:codex-recent-paths'
const MAX_RECENT_PATHS = 12

export function useWorkspacePickerData(options) {
  const {
    autoExpandRoots = true,
    restoreExpandedPaths = true,
    props,
    onSelect,
  } = options

  const rootNodes = ref([])
  const treeLoading = ref(false)
  const treeError = ref('')
  const searchResults = ref([])
  const searchLoading = ref(false)
  const searchError = ref('')
  const recentPaths = ref([])
  const persistedExpandedPaths = ref([])
  const activeTab = ref('tree')
  const activeKey = ref('')

  const itemRefs = new Map()

  let searchTimer = null
  let searchRequestId = 0
  let pickerRefreshToken = 0

  const normalizedQuery = computed(() => String(props.query || '').trim())
  const isSearchMode = computed(() => Boolean(normalizedQuery.value))
  const treeItems = computed(() => flattenTreeNodes(rootNodes.value))
  const storageSessionKey = computed(() => String(props.sessionId || '').trim())
  const treeExpandedStorageKey = computed(() => storageSessionKey.value ? `promptx:codex-tree-expanded:${storageSessionKey.value}` : '')
  const recentSearchItems = computed(() => {
    if (!normalizedQuery.value) {
      return recentPaths.value
    }

    const matchedPaths = new Set(searchResults.value.map((item) => item.path))
    return recentPaths.value.filter((item) => matchedPaths.has(item.path))
  })
  const normalSearchItems = computed(() => {
    const pinnedPaths = new Set(recentSearchItems.value.map((item) => item.path))
    return searchResults.value.filter((item) => !pinnedPaths.has(item.path))
  })
  const searchItems = computed(() => (
    normalizedQuery.value
      ? [...recentSearchItems.value, ...normalSearchItems.value]
      : recentPaths.value
  ))
  const visibleItems = computed(() => (activeTab.value === 'search' ? searchItems.value : treeItems.value))
  const currentLoading = computed(() => (activeTab.value === 'search' ? searchLoading.value : treeLoading.value))
  const currentError = computed(() => (activeTab.value === 'search' ? searchError.value : treeError.value))
  const showSearchPromptState = computed(() => (
    activeTab.value === 'search'
    && Boolean(props.sessionId)
    && !normalizedQuery.value
    && !recentPaths.value.length
  ))
  const showSearchEmptyState = computed(() => (
    activeTab.value === 'search'
    && Boolean(props.sessionId)
    && Boolean(normalizedQuery.value)
    && !searchLoading.value
    && !searchError.value
    && !searchItems.value.length
  ))
  const showTreeEmptyState = computed(() => (
    activeTab.value === 'tree'
    && Boolean(props.sessionId)
    && !treeLoading.value
    && !treeError.value
    && !treeItems.value.length
  ))

  function readStoredJson(key, fallback) {
    if (!key || typeof window === 'undefined') {
      return fallback
    }

    try {
      const raw = window.localStorage.getItem(key)
      return raw ? JSON.parse(raw) : fallback
    } catch {
      return fallback
    }
  }

  function writeStoredJson(key, value) {
    if (!key || typeof window === 'undefined') {
      return
    }

    try {
      window.localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // ignore storage failures
    }
  }

  function sortEntries(items = []) {
    return [...items].sort((left, right) => {
      const typeDiff = Number(left.type !== 'directory') - Number(right.type !== 'directory')
      if (typeDiff) {
        return typeDiff
      }
      return String(left.path || left.name || '').localeCompare(String(right.path || right.name || ''), 'zh-CN')
    })
  }

  function createTreeNode(entry) {
    return {
      ...entry,
      children: [],
      expanded: false,
      loaded: false,
      loading: false,
    }
  }

  function flattenTreeNodes(nodes = [], depth = 0, output = []) {
    nodes.forEach((node) => {
      output.push({
        ...node,
        depth,
      })

      if (node.type === 'directory' && node.expanded && node.children.length) {
        flattenTreeNodes(node.children, depth + 1, output)
      }
    })

    return output
  }

  function findTreeNode(targetPath, nodes = rootNodes.value) {
    for (const node of nodes) {
      if (node.path === targetPath) {
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

  function refreshTreeView() {
    rootNodes.value = [...rootNodes.value]
  }

  function getExpandedPathsSnapshot(nodes = rootNodes.value, output = []) {
    nodes.forEach((node) => {
      if (node.type === 'directory' && node.expanded) {
        output.push(node.path)
        if (node.children.length) {
          getExpandedPathsSnapshot(node.children, output)
        }
      }
    })

    return output
  }

  function persistExpandedPaths() {
    if (!treeExpandedStorageKey.value) {
      return
    }

    const nextPaths = [...new Set(getExpandedPathsSnapshot())]
    persistedExpandedPaths.value = nextPaths
    writeStoredJson(treeExpandedStorageKey.value, nextPaths)
  }

  function loadPersistedExpandedPaths() {
    if (!restoreExpandedPaths) {
      persistedExpandedPaths.value = []
      return
    }

    persistedExpandedPaths.value = treeExpandedStorageKey.value
      ? readStoredJson(treeExpandedStorageKey.value, []).filter(Boolean)
      : []
  }

  function loadRecentPaths() {
    const allItems = readStoredJson(RECENT_PATHS_STORAGE_KEY, [])
    if (!Array.isArray(allItems) || !storageSessionKey.value) {
      recentPaths.value = []
      return
    }

    recentPaths.value = allItems
      .filter((item) => item && item.sessionId === storageSessionKey.value && item.path)
      .sort((left, right) => Number(right.usedAt || 0) - Number(left.usedAt || 0))
      .slice(0, MAX_RECENT_PATHS)
  }

  function getDisplayName(item) {
    return item.name || item.path || '.'
  }

  function getDisplayPath(item) {
    return item.path || '.'
  }

  function saveRecentPath(item) {
    if (!storageSessionKey.value || !item?.path) {
      return
    }

    const record = {
      sessionId: storageSessionKey.value,
      path: item.path,
      name: item.name || getDisplayName(item),
      type: item.type || 'file',
      usedAt: Date.now(),
    }
    const existing = readStoredJson(RECENT_PATHS_STORAGE_KEY, [])
    const nextRecords = [record]

    if (Array.isArray(existing)) {
      existing.forEach((entry) => {
        if (!entry?.path || !entry?.sessionId) {
          return
        }
        if (entry.sessionId === record.sessionId && entry.path === record.path) {
          return
        }
        nextRecords.push(entry)
      })
    }

    writeStoredJson(RECENT_PATHS_STORAGE_KEY, nextRecords.slice(0, 40))
    loadRecentPaths()
  }

  function getParentPath(pathValue = '') {
    const value = String(pathValue || '').trim()
    if (!value || !value.includes('/')) {
      return ''
    }
    return value.slice(0, value.lastIndexOf('/'))
  }

  function getCurrentActiveIndex() {
    const items = visibleItems.value
    if (!items.length) {
      return -1
    }

    const index = items.findIndex((item) => item.path === activeKey.value)
    return index >= 0 ? index : 0
  }

  function getActiveItem() {
    const items = visibleItems.value
    const index = getCurrentActiveIndex()
    if (index < 0 || !items.length) {
      return null
    }
    return items[index] || null
  }

  function syncActiveKey() {
    const items = visibleItems.value
    if (!items.length) {
      activeKey.value = ''
      return
    }

    if (items.some((item) => item.path === activeKey.value)) {
      return
    }

    activeKey.value = items[0].path
  }

  function setItemRef(pathValue, element) {
    if (element) {
      itemRefs.set(pathValue, element)
      return
    }
    itemRefs.delete(pathValue)
  }

  function scrollActiveItemIntoView() {
    const target = itemRefs.get(activeKey.value)
    target?.scrollIntoView?.({ block: 'nearest' })
  }

  function escapeHtml(value = '') {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function findHighlightRange(text = '', query = '') {
    const source = String(text || '')
    const keyword = String(query || '').trim().toLowerCase()
    if (!source || !keyword) {
      return null
    }

    const normalizedSource = source.toLowerCase()
    const directIndex = normalizedSource.indexOf(keyword)
    if (directIndex >= 0) {
      return {
        start: directIndex,
        end: directIndex + keyword.length,
      }
    }

    const tokens = keyword
      .split(/[\\/\s_.-]+/)
      .filter(Boolean)
      .sort((left, right) => right.length - left.length)

    for (const token of tokens) {
      if (token.length < 2) {
        continue
      }

      const tokenIndex = normalizedSource.indexOf(token)
      if (tokenIndex >= 0) {
        return {
          start: tokenIndex,
          end: tokenIndex + token.length,
        }
      }
    }

    return null
  }

  function renderHighlightedText(text = '', query = '') {
    const source = String(text || '')
    const range = findHighlightRange(source, query)
    if (!range) {
      return escapeHtml(source)
    }

    return `${escapeHtml(source.slice(0, range.start))}<mark class="theme-search-highlight">${escapeHtml(source.slice(range.start, range.end))}</mark>${escapeHtml(source.slice(range.end))}`
  }

  function getHighlightedName(item) {
    return renderHighlightedText(getDisplayName(item), normalizedQuery.value)
  }

  function getHighlightedPath(item) {
    return renderHighlightedText(getDisplayPath(item), normalizedQuery.value)
  }

  async function loadTree(parentPath = '', options = {}) {
    if (!props.sessionId) {
      rootNodes.value = []
      treeError.value = ''
      treeLoading.value = false
      return
    }

    const isRoot = !parentPath
    const node = isRoot ? null : findTreeNode(parentPath)
    if (!isRoot && !node) {
      return
    }

    if (!options.force) {
      if (isRoot && rootNodes.value.length) {
        return
      }
      if (!isRoot && node.loaded) {
        return
      }
    }

    if (isRoot) {
      treeLoading.value = true
      treeError.value = ''
    } else {
      node.loading = true
      treeError.value = ''
      refreshTreeView()
    }

    try {
      const payload = await listCodexSessionFiles(props.sessionId, {
        path: parentPath,
        refreshToken: options.refreshToken || '',
      })
      const nextChildren = sortEntries(payload.items || []).map(createTreeNode)

      if (isRoot) {
        rootNodes.value = nextChildren
        return
      }

      node.children = nextChildren
      node.loaded = true
    } catch (error) {
      treeError.value = error.message
    } finally {
      if (isRoot) {
        treeLoading.value = false
      } else {
        node.loading = false
        refreshTreeView()
      }
    }
  }

  async function restoreExpandedTree(nodes = rootNodes.value, expandedPathSet = new Set(), options = {}) {
    for (const node of nodes) {
      if (node.type !== 'directory' || !expandedPathSet.has(node.path)) {
        continue
      }

      node.expanded = true
      refreshTreeView()
      await loadTree(node.path, options)

      if (node.children.length) {
        await restoreExpandedTree(node.children, expandedPathSet, options)
      }
    }
  }

  async function loadInitialTree(options = {}) {
    await loadTree('', options)
    const expandedPathSet = new Set(persistedExpandedPaths.value)
    const hasPersistedPaths = expandedPathSet.size > 0

    for (const node of rootNodes.value) {
      if (node.type !== 'directory' || !node.hasChildren) {
        continue
      }

      node.expanded = hasPersistedPaths ? expandedPathSet.has(node.path) : autoExpandRoots
    }
    refreshTreeView()

    if (hasPersistedPaths) {
      await restoreExpandedTree(rootNodes.value, expandedPathSet, options)
      return
    }

    if (!autoExpandRoots) {
      persistExpandedPaths()
      return
    }

    const expandableRoots = rootNodes.value.filter((node) => node.type === 'directory' && node.expanded && node.hasChildren)
    await Promise.all(expandableRoots.map((node) => loadTree(node.path, options)))
    persistExpandedPaths()
  }

  async function toggleDirectory(pathValue) {
    if (activeTab.value !== 'tree') {
      return
    }

    const node = findTreeNode(pathValue)
    if (!node || node.type !== 'directory') {
      return
    }

    if (!node.loaded && !node.loading) {
      node.expanded = true
      refreshTreeView()
      await loadTree(node.path)
      persistExpandedPaths()
      return
    }

    node.expanded = !node.expanded
    refreshTreeView()
    persistExpandedPaths()
  }

  function emitSelect(item) {
    if (!item?.path) {
      return false
    }

    saveRecentPath(item)
    onSelect?.(item)
    return true
  }

  async function refreshSearch(options = {}) {
    const query = normalizedQuery.value
    searchRequestId += 1
    const requestId = searchRequestId
    const refreshToken = options.refreshToken || ''

    if (!props.open || !props.sessionId || !query) {
      searchLoading.value = false
      searchError.value = ''
      if (!query) {
        searchResults.value = []
      }
      return
    }

    try {
      const payload = await searchCodexSessionFiles(props.sessionId, query, {
        limit: 80,
        refreshToken,
      })
      if (requestId !== searchRequestId) {
        return
      }

      searchResults.value = payload.items || []
    } catch (error) {
      if (requestId !== searchRequestId) {
        return
      }
      searchError.value = error.message
      searchResults.value = []
    } finally {
      if (requestId === searchRequestId) {
        searchLoading.value = false
      }
    }
  }

  function scheduleSearch(options = {}) {
    if (searchTimer) {
      window.clearTimeout(searchTimer)
      searchTimer = null
    }

    if (!props.open || !props.sessionId || !normalizedQuery.value) {
      searchLoading.value = false
      searchError.value = ''
      if (!normalizedQuery.value) {
        searchResults.value = []
      }
      return
    }

    searchLoading.value = true
    searchError.value = ''

    searchTimer = window.setTimeout(() => {
      refreshSearch(options)
    }, 120)
  }

  function refreshPickerData() {
    if (!props.sessionId) {
      rootNodes.value = []
      treeError.value = ''
      treeLoading.value = false
      searchResults.value = []
      searchError.value = ''
      searchLoading.value = false
      return
    }

    pickerRefreshToken = Date.now()
    rootNodes.value = []
    treeError.value = ''
    searchResults.value = []
    searchError.value = ''
    loadInitialTree({
      force: true,
      refreshToken: pickerRefreshToken,
    })
    scheduleSearch({
      refreshToken: pickerRefreshToken,
    })
  }

  function initializeData() {
    loadRecentPaths()
    loadPersistedExpandedPaths()
    setActiveTab(isSearchMode.value ? 'search' : 'tree')
    refreshPickerData()
  }

  function resetData() {
    if (searchTimer) {
      window.clearTimeout(searchTimer)
      searchTimer = null
    }
    searchResults.value = []
    searchError.value = ''
    searchLoading.value = false
  }

  function setActiveTab(nextTab) {
    activeTab.value = nextTab
    if (nextTab === 'tree' && props.sessionId && !treeLoading.value && !rootNodes.value.length) {
      loadInitialTree({ force: true })
    }
    nextTick(() => {
      syncActiveKey()
      scrollActiveItemIntoView()
    })
  }

  function moveActive(step) {
    const items = visibleItems.value
    if (!items.length) {
      return false
    }

    const currentIndex = getCurrentActiveIndex()
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + step + items.length) % items.length

    activeKey.value = items[nextIndex].path
    return true
  }

  async function expandActiveDirectory() {
    if (activeTab.value !== 'tree') {
      return false
    }

    const item = getActiveItem()
    if (!item || item.type !== 'directory') {
      return false
    }

    if (!item.expanded) {
      await toggleDirectory(item.path)
      activeKey.value = item.path
      return true
    }

    const items = visibleItems.value
    const currentIndex = getCurrentActiveIndex()
    const nextItem = items[currentIndex + 1]
    if (nextItem && getParentPath(nextItem.path) === item.path) {
      activeKey.value = nextItem.path
      return true
    }

    return false
  }

  function collapseActiveDirectory() {
    if (activeTab.value !== 'tree') {
      return false
    }

    const item = getActiveItem()
    if (!item) {
      return false
    }

    if (item.type === 'directory' && item.expanded) {
      const node = findTreeNode(item.path)
      if (node) {
        node.expanded = false
        refreshTreeView()
        persistExpandedPaths()
      }
      activeKey.value = item.path
      return true
    }

    const parentPath = getParentPath(item.path)
    if (!parentPath) {
      return false
    }

    activeKey.value = parentPath
    return true
  }

  function confirmActive() {
    const items = visibleItems.value
    if (!items.length) {
      return false
    }

    return emitSelect(items[getCurrentActiveIndex()])
  }

  function switchTab(step = 1) {
    const tabs = ['search', 'tree']
    const currentIndex = tabs.indexOf(activeTab.value)
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + step + tabs.length) % tabs.length

    setActiveTab(tabs[nextIndex])
    return true
  }

  function handleSessionChange() {
    rootNodes.value = []
    treeError.value = ''
    treeLoading.value = false
    searchResults.value = []
    searchError.value = ''
    searchLoading.value = false
    loadRecentPaths()
    loadPersistedExpandedPaths()
    if (!props.sessionId) {
      return
    }

    if (!props.open) {
      return
    }

    loadInitialTree({ force: true })
    scheduleSearch()
  }

  function handleQueryChange() {
    setActiveTab(isSearchMode.value ? 'search' : 'tree')
    scheduleSearch()
  }

  function handleVisibleItemsChange() {
    syncActiveKey()
    nextTick(scrollActiveItemIntoView)
  }

  onBeforeUnmount(() => {
    if (searchTimer) {
      window.clearTimeout(searchTimer)
    }
  })

  return {
    activeKey,
    activeTab,
    collapseActiveDirectory,
    confirmActive,
    currentError,
    currentLoading,
    emitSelect,
    expandActiveDirectory,
    getDisplayName,
    getHighlightedName,
    getHighlightedPath,
    handleQueryChange,
    handleSessionChange,
    handleVisibleItemsChange,
    initializeData,
    moveActive,
    normalSearchItems,
    normalizedQuery,
    recentSearchItems,
    resetData,
    setActiveTab,
    setItemRef,
    showSearchEmptyState,
    showSearchPromptState,
    showTreeEmptyState,
    switchTab,
    toggleDirectory,
    treeItems,
    visibleItems,
  }
}
