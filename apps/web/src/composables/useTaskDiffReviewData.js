import { computed, nextTick, ref, watch } from 'vue'
import { getTaskGitDiff, listTaskCodexRuns } from '../lib/api.js'
import { useWorkbenchRealtime } from './useWorkbenchRealtime.js'

function buildLoadSignature(taskSlug, scope, runId = '') {
  const normalizedScope = scope === 'run' ? 'run' : scope === 'task' ? 'task' : 'workspace'
  return [String(taskSlug || '').trim(), normalizedScope, String(runId || '').trim()].join('::')
}

function buildPatchCacheKey(signature = '', filePath = '') {
  return `${String(signature || '').trim()}::${String(filePath || '').trim()}`
}

function cloneSerializable(value) {
  if (!value || typeof value !== 'object') {
    return value
  }

  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value
  }
}

function getCachedValue(cache, key) {
  const cached = cache.get(key)
  if (!cached) {
    return null
  }

  cache.delete(key)
  cache.set(key, cached)
  return cloneSerializable(cached)
}

function setCachedValue(cache, key, value, maxSize = 0) {
  cache.delete(key)
  cache.set(key, cloneSerializable(value))

  while (maxSize > 0 && cache.size > maxSize) {
    const oldestKey = cache.keys().next().value
    if (typeof oldestKey === 'undefined') {
      break
    }
    cache.delete(oldestKey)
  }
}

function normalizeFileStatus(status = '') {
  const value = String(status || '').trim().toUpperCase()
  if (value === 'A' || value === 'D') {
    return value
  }
  return 'M'
}

function parsePatchLines(patch = '') {
  const text = String(patch || '')
  if (!text) {
    return []
  }

  const lines = text.split('\n')
  const parsed = []
  let oldLine = 0
  let newLine = 0

  lines.forEach((line, index) => {
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1])
      newLine = Number(hunkMatch[2])
      parsed.push({
        id: `hunk-${index}`,
        kind: 'hunk',
        oldNumber: '',
        newNumber: '',
        content: line,
      })
      return
    }

    if (line.startsWith('+') && !line.startsWith('+++')) {
      parsed.push({
        id: `line-${index}`,
        kind: 'add',
        oldNumber: '',
        newNumber: newLine,
        content: line,
      })
      newLine += 1
      return
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      parsed.push({
        id: `line-${index}`,
        kind: 'delete',
        oldNumber: oldLine,
        newNumber: '',
        content: line,
      })
      oldLine += 1
      return
    }

    if (line.startsWith(' ')) {
      parsed.push({
        id: `line-${index}`,
        kind: 'context',
        oldNumber: oldLine,
        newNumber: newLine,
        content: line,
      })
      oldLine += 1
      newLine += 1
      return
    }

    parsed.push({
      id: `line-${index}`,
      kind: 'meta',
      oldNumber: '',
      newNumber: '',
      content: line,
    })
  })

  return parsed
}

export function useTaskDiffReviewData(props) {
  const diffScope = ref('workspace')
  const selectedRunId = ref('')
  const selectedFilePath = ref('')
  const statusFilter = ref('all')
  const fileSearch = ref('')
  const runs = ref([])
  const diffPayload = ref(null)
  const loading = ref(false)
  const statsLoading = ref(false)
  const error = ref('')
  const patchLoading = ref(false)
  const patchViewportRef = ref(null)
  const activeHunkIndex = ref(0)
  const patchLineRefMap = new Map()
  const realtime = useWorkbenchRealtime()

  let loadRequestId = 0
  let patchRequestId = 0
  let lastLoadedSignature = ''
  let lastStatsLoadedSignature = ''
  let runsLoadedTaskSlug = ''
  let runsLoadedVersion = -1

  const diffListCache = new Map()
  const diffStatsCache = new Map()
  const filePatchCache = new Map()

  const terminalRuns = computed(() => runs.value.filter((run) => run.completed))
  const statusCounts = computed(() => {
    const counts = {
      all: 0,
      A: 0,
      M: 0,
      D: 0,
    }

    ;(diffPayload.value?.files || []).forEach((file) => {
      const status = normalizeFileStatus(file?.status)
      counts.all += 1
      counts[status] += 1
    })

    return counts
  })

  const filteredFiles = computed(() => {
    const files = diffPayload.value?.files || []
    const normalizedQuery = String(fileSearch.value || '').trim().toLowerCase()

    return files.filter((file) => {
      if (statusFilter.value !== 'all' && normalizeFileStatus(file?.status) !== statusFilter.value) {
        return false
      }

      if (!normalizedQuery) {
        return true
      }

      return String(file?.path || '').toLowerCase().includes(normalizedQuery)
    })
  })

  const selectedFile = computed(() => {
    const files = filteredFiles.value
    return files.find((file) => file.path === selectedFilePath.value) || files[0] || null
  })

  const selectedPatchLines = computed(() => parsePatchLines(selectedFile.value?.patch || ''))
  const selectedPatchHunks = computed(() =>
    selectedPatchLines.value
      .map((line, index) => ({ ...line, index }))
      .filter((line) => line.kind === 'hunk')
  )

  const showSummarySkeleton = computed(() => statsLoading.value && !diffPayload.value?.summary?.statsComplete)
  const baselineMetaText = computed(() => {
    const baseline = diffPayload.value?.baseline || null
    if (!baseline?.createdAt && !baseline?.headShort) {
      return ''
    }

    const parts = []
    if (baseline.createdAt) {
      parts.push(`基线时间：${new Date(baseline.createdAt).toLocaleString('zh-CN')}`)
    }
    if (baseline.branch) {
      parts.push(`基线分支：${baseline.branch}`)
    }
    if (baseline.headShort) {
      parts.push(`基线 commit：${baseline.headShort}`)
    }
    if (baseline.currentHeadShort) {
      parts.push(`当前 HEAD：${baseline.currentHeadShort}`)
    }

    return parts.join(' · ')
  })

  function getRunStatusLabel(run) {
    if (run?.status === 'completed') {
      return '已完成'
    }
    if (run?.status === 'error') {
      return '失败'
    }
    if (run?.status === 'interrupted') {
      return '已中断'
    }
    return '已停止'
  }

  function setPatchLineRef(lineId, element) {
    if (!lineId) {
      return
    }

    if (element) {
      patchLineRefMap.set(lineId, element)
      return
    }

    patchLineRefMap.delete(lineId)
  }

  function scrollToHunk(index, options = {}) {
    const hunks = selectedPatchHunks.value
    if (!hunks.length) {
      return
    }

    const normalizedIndex = Math.min(Math.max(0, Number(index) || 0), hunks.length - 1)
    const target = hunks[normalizedIndex]
    const element = patchLineRefMap.get(target.id)
    if (!element) {
      return
    }

    activeHunkIndex.value = normalizedIndex
    element.scrollIntoView({
      block: options.block || 'center',
      behavior: options.behavior || 'smooth',
    })
  }

  function jumpToAdjacentHunk(step = 1) {
    if (!selectedPatchHunks.value.length) {
      return
    }

    scrollToHunk(activeHunkIndex.value + step)
  }

  function formatRunOptionLabel(run) {
    return `${new Date(run?.startedAt || run?.createdAt).toLocaleString('zh-CN')} · ${getRunStatusLabel(run)}`
  }

  function syncSelectedRun() {
    const nextRuns = terminalRuns.value
    if (!nextRuns.length) {
      selectedRunId.value = ''
      return
    }

    if (nextRuns.some((run) => run.id === selectedRunId.value)) {
      return
    }

    selectedRunId.value = nextRuns[0].id
  }

  function syncSelectedFile() {
    const files = filteredFiles.value
    if (!files.length) {
      selectedFilePath.value = ''
      return
    }

    if (files.some((file) => file.path === selectedFilePath.value)) {
      return
    }

    selectedFilePath.value = files[0].path
  }

  function getStatusLabel(status = '') {
    if (normalizeFileStatus(status) === 'A') {
      return '新增'
    }
    if (normalizeFileStatus(status) === 'D') {
      return '删除'
    }
    return '修改'
  }

  function getStatusClass(status = '') {
    if (normalizeFileStatus(status) === 'A') {
      return 'border-emerald-300 bg-emerald-100 text-emerald-900 dark:border-[#5b7562] dark:bg-[#243228] dark:text-[#deecdf]'
    }
    if (normalizeFileStatus(status) === 'D') {
      return 'border-red-300 bg-red-100 text-red-900 dark:border-[#7b4f4a] dark:bg-[#372321] dark:text-[#f0dfdc]'
    }
    return 'border-amber-300 bg-amber-100 text-amber-900 dark:border-[#7f6949] dark:bg-[#392f20] dark:text-[#f4ddb0]'
  }

  function getFilterLabel(filter = 'all') {
    if (filter === 'A') {
      return '新增'
    }
    if (filter === 'D') {
      return '删除'
    }
    if (filter === 'M') {
      return '修改'
    }
    return '全部'
  }

  function getFilterButtonClass(filter = 'all') {
    const activeClass = 'border-stone-500 bg-stone-100 text-stone-900 dark:border-[#73665c] dark:bg-[#332c27] dark:text-stone-100'
    const inactiveClass = 'border-stone-300 bg-white text-stone-600 hover:bg-stone-100 dark:border-[#453c36] dark:bg-[#26211d] dark:text-stone-300 dark:hover:bg-[#2f2924]'
    return statusFilter.value === filter ? activeClass : inactiveClass
  }

  function getPatchLineClass(kind = 'context') {
    if (kind === 'add') {
      return 'bg-emerald-50 text-emerald-950 dark:bg-[#213127] dark:text-[#deecdf]'
    }
    if (kind === 'delete') {
      return 'bg-red-50 text-red-950 dark:bg-[#352321] dark:text-[#f0dfdc]'
    }
    if (kind === 'hunk') {
      return 'bg-amber-50 text-amber-900 dark:bg-[#33291f] dark:text-[#f4ddb0]'
    }
    if (kind === 'meta') {
      return 'bg-stone-50 text-stone-500 dark:bg-[#241f1b] dark:text-stone-400'
    }
    return 'text-stone-800 dark:text-stone-200'
  }

  async function loadRuns() {
    if (!props.taskSlug) {
      runs.value = []
      selectedRunId.value = ''
      runsLoadedTaskSlug = ''
      runsLoadedVersion = -1
      return
    }

    const currentRunVersion = realtime.getTaskRunSyncVersion(props.taskSlug)
    if (runsLoadedTaskSlug === props.taskSlug && runsLoadedVersion === currentRunVersion) {
      return
    }

    const payload = await listTaskCodexRuns(props.taskSlug, {
      limit: 20,
      includeEvents: false,
    })
    runs.value = payload.items || []
    runsLoadedTaskSlug = props.taskSlug
    runsLoadedVersion = currentRunVersion
    syncSelectedRun()
  }

  async function loadDiff() {
    if (!props.taskSlug || !props.active) {
      return
    }

    const currentRequestId = ++loadRequestId
    loading.value = true
    statsLoading.value = false
    error.value = ''

    try {
      const scope = diffScope.value === 'run' ? 'run' : diffScope.value === 'task' ? 'task' : 'workspace'
      if (scope === 'run') {
        await loadRuns()
      }
      const signature = buildLoadSignature(props.taskSlug, scope, scope === 'run' ? selectedRunId.value : '')

      if (scope === 'run' && !selectedRunId.value) {
        diffPayload.value = {
          supported: false,
          reason: '当前还没有可用于审查的历史执行记录。',
          repoRoot: '',
          summary: { fileCount: 0, additions: 0, deletions: 0, statsComplete: true },
          files: [],
        }
        syncSelectedFile()
        return
      }

      const cachedListPayload = getCachedValue(diffListCache, signature)
      if (cachedListPayload) {
        diffPayload.value = cachedListPayload
        lastLoadedSignature = signature

        const cachedStatsPayload = getCachedValue(diffStatsCache, signature)
        if (cachedStatsPayload) {
          diffPayload.value = {
            ...cachedListPayload,
            baseline: cachedStatsPayload.baseline || cachedListPayload.baseline || null,
            warnings: cachedStatsPayload.warnings || cachedListPayload.warnings || [],
            summary: cachedStatsPayload.summary || cachedListPayload.summary,
          }
          lastStatsLoadedSignature = signature
        } else {
          lastStatsLoadedSignature = ''
        }

        syncSelectedFile()
        loadSelectedFilePatch().catch(() => {})
        if (!cachedStatsPayload) {
          loadDiffStats().catch(() => {})
        }
        return
      }

      const payload = await getTaskGitDiff(props.taskSlug, {
        scope,
        runId: scope === 'run' ? selectedRunId.value : '',
        includeStats: false,
      })

      if (currentRequestId !== loadRequestId) {
        return
      }

      diffPayload.value = payload
      setCachedValue(diffListCache, signature, payload, 36)
      lastLoadedSignature = signature
      lastStatsLoadedSignature = ''
      syncSelectedFile()
      loadSelectedFilePatch().catch(() => {})
      loadDiffStats().catch(() => {})
    } catch (err) {
      if (currentRequestId !== loadRequestId) {
        return
      }

      error.value = err.message
      diffPayload.value = null
    } finally {
      if (currentRequestId === loadRequestId) {
        loading.value = false
      }
    }
  }

  async function loadDiffStats() {
    if (!props.taskSlug || !props.active || !diffPayload.value?.supported) {
      return
    }

    const scope = diffScope.value === 'run' ? 'run' : diffScope.value === 'task' ? 'task' : 'workspace'
    const runId = scope === 'run' ? selectedRunId.value : ''
    const signature = buildLoadSignature(props.taskSlug, scope, runId)
    if (lastStatsLoadedSignature === signature && diffPayload.value?.summary?.statsComplete) {
      return
    }

    const cachedStatsPayload = getCachedValue(diffStatsCache, signature)
    if (cachedStatsPayload) {
      diffPayload.value = {
        ...diffPayload.value,
        baseline: cachedStatsPayload.baseline || diffPayload.value.baseline || null,
        warnings: cachedStatsPayload.warnings || diffPayload.value.warnings || [],
        summary: cachedStatsPayload.summary || diffPayload.value.summary,
      }
      lastStatsLoadedSignature = signature
      statsLoading.value = false
      return
    }

    statsLoading.value = true

    try {
      const payload = await getTaskGitDiff(props.taskSlug, {
        scope,
        runId,
        includeFiles: false,
        includeStats: true,
      })

      const latestSignature = buildLoadSignature(props.taskSlug, diffScope.value, diffScope.value === 'run' ? selectedRunId.value : '')
      if (signature !== latestSignature || !diffPayload.value) {
        return
      }

      diffPayload.value = {
        ...diffPayload.value,
        baseline: payload.baseline || diffPayload.value.baseline || null,
        warnings: payload.warnings || diffPayload.value.warnings || [],
        summary: payload.summary || diffPayload.value.summary,
      }
      setCachedValue(diffStatsCache, signature, {
        baseline: payload.baseline || null,
        warnings: payload.warnings || [],
        summary: payload.summary || null,
      }, 36)
      lastStatsLoadedSignature = signature
    } catch {
      // Keep the lighter file list usable even if stats loading fails.
    } finally {
      const latestSignature = buildLoadSignature(props.taskSlug, diffScope.value, diffScope.value === 'run' ? selectedRunId.value : '')
      if (signature === latestSignature) {
        statsLoading.value = false
      }
    }
  }

  async function loadSelectedFilePatch() {
    const filePath = String(selectedFilePath.value || '').trim()
    if (!props.taskSlug || !props.active || !filePath || patchLoading.value) {
      return
    }

    const scope = diffScope.value === 'run' ? 'run' : diffScope.value === 'task' ? 'task' : 'workspace'
    const runId = scope === 'run' ? selectedRunId.value : ''
    const signature = buildLoadSignature(props.taskSlug, scope, runId)

    const currentFile = (diffPayload.value?.files || []).find((file) => file.path === filePath)
    if (!currentFile || currentFile.patchLoaded || currentFile.binary || currentFile.tooLarge || currentFile.message) {
      return
    }

    const patchCacheKey = buildPatchCacheKey(signature, filePath)
    const cachedFile = getCachedValue(filePatchCache, patchCacheKey)
    if (cachedFile && diffPayload.value?.files) {
      diffPayload.value = {
        ...diffPayload.value,
        files: diffPayload.value.files.map((file) => (file.path === filePath ? cachedFile : file)),
      }
      return
    }

    const currentPatchRequestId = ++patchRequestId
    patchLoading.value = true

    try {
      const payload = await getTaskGitDiff(props.taskSlug, {
        scope,
        runId,
        filePath,
      })
      if (currentPatchRequestId !== patchRequestId) {
        return
      }

      const latestSignature = buildLoadSignature(props.taskSlug, diffScope.value, diffScope.value === 'run' ? selectedRunId.value : '')
      if (signature !== latestSignature) {
        return
      }

      const detailedFile = (payload.files || []).find((file) => file.path === filePath)
      if (!detailedFile || !diffPayload.value?.files) {
        return
      }

      setCachedValue(filePatchCache, patchCacheKey, detailedFile, 120)
      diffPayload.value = {
        ...diffPayload.value,
        baseline: payload.baseline || diffPayload.value.baseline || null,
        warnings: payload.warnings || diffPayload.value.warnings || [],
        files: diffPayload.value.files.map((file) => (file.path === filePath ? detailedFile : file)),
      }
    } catch (err) {
      error.value = err.message
    } finally {
      if (currentPatchRequestId === patchRequestId) {
        patchLoading.value = false
        if (String(selectedFilePath.value || '').trim() !== filePath) {
          loadSelectedFilePatch().catch(() => {})
        }
      }
    }
  }

  function requestLoadDiff({ force = false } = {}) {
    if (!props.taskSlug || !props.active) {
      return
    }

    const signature = buildLoadSignature(props.taskSlug, diffScope.value, diffScope.value === 'run' ? selectedRunId.value : '')
    if (!force && signature === lastLoadedSignature) {
      return
    }

    loadDiff().catch(() => {})
  }

  watch(
    () => [props.taskSlug, props.active, diffScope.value, selectedRunId.value],
    ([taskSlug, active], previousValue = []) => {
      const previousTaskSlug = previousValue[0] || ''
      if (taskSlug !== previousTaskSlug) {
        selectedFilePath.value = ''
        lastLoadedSignature = ''
        runs.value = []
        selectedRunId.value = ''
        runsLoadedTaskSlug = ''
        runsLoadedVersion = -1
        lastStatsLoadedSignature = ''
      }

      if (!taskSlug || !active) {
        return
      }

      requestLoadDiff()
    },
    { immediate: true }
  )

  watch(
    () => [statusFilter.value, diffPayload.value?.files?.length || 0],
    () => {
      syncSelectedFile()
    }
  )

  watch(
    () => [selectedFilePath.value, selectedPatchHunks.value.length],
    () => {
      activeHunkIndex.value = 0
      patchLineRefMap.clear()
      nextTick(() => {
        if (selectedPatchHunks.value.length) {
          scrollToHunk(0, { behavior: 'auto', block: 'start' })
        } else {
          patchViewportRef.value?.scrollTo?.({ top: 0, behavior: 'auto' })
        }
      })
    }
  )

  watch(
    () => selectedFilePath.value,
    () => {
      loadSelectedFilePatch().catch(() => {})
    },
    { immediate: true }
  )

  watch(
    () => [props.preferredScope, props.preferredRunId, props.focusToken],
    ([scope, runId, focusToken], previousValue = []) => {
      const previousFocusToken = Number(previousValue[2] || 0)
      const nextScope = scope === 'run' ? 'run' : scope === 'task' ? 'task' : 'workspace'
      const nextRunId = nextScope === 'run' && runId ? String(runId || '') : ''
      const scopeChanged = diffScope.value !== nextScope
      const runChanged = nextScope === 'run' && nextRunId && selectedRunId.value !== nextRunId

      diffScope.value = nextScope
      if (nextRunId) {
        selectedRunId.value = nextRunId
      }
      if (nextScope !== 'run') {
        selectedRunId.value = ''
      }
      if (!scopeChanged && !runChanged && props.active && props.taskSlug && focusToken !== previousFocusToken) {
        lastLoadedSignature = ''
        requestLoadDiff()
      }
    },
    { immediate: true }
  )

  watch(
    () => realtime.readyVersion.value,
    () => {
      if (!props.active || !props.taskSlug) {
        return
      }

      runsLoadedTaskSlug = ''
      runsLoadedVersion = -1
      lastLoadedSignature = ''
      lastStatsLoadedSignature = ''
      requestLoadDiff({ force: true })
    }
  )

  watch(
    () => realtime.getTaskDiffSyncVersion(props.taskSlug),
    () => {
      if (!props.active || !props.taskSlug) {
        return
      }

      runsLoadedTaskSlug = ''
      runsLoadedVersion = -1
      lastStatsLoadedSignature = ''
      lastLoadedSignature = ''
      requestLoadDiff({ force: true })
    }
  )

  return {
    activeHunkIndex,
    baselineMetaText,
    diffPayload,
    diffScope,
    error,
    fileSearch,
    filteredFiles,
    getFilterButtonClass,
    getFilterLabel,
    getPatchLineClass,
    getRunStatusLabel,
    getStatusClass,
    getStatusLabel,
    jumpToAdjacentHunk,
    loadDiff,
    loading,
    normalizeFileStatus,
    patchLoading,
    patchViewportRef,
    runs,
    selectedFile,
    selectedFilePath,
    selectedPatchHunks,
    selectedPatchLines,
    selectedRunId,
    setPatchLineRef,
    showSummarySkeleton,
    statsLoading,
    statusCounts,
    statusFilter,
    terminalRuns,
    formatRunOptionLabel,
  }
}
