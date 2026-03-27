import { computed, nextTick, ref, watch } from 'vue'
import { getTaskGitDiff, listTaskCodexRuns } from '../lib/api.js'
import { formatDateTime, getCurrentLocale, translate } from './useI18n.js'
import { useWorkbenchRealtime } from './useWorkbenchRealtime.js'

function buildLoadSignature(taskSlug, scope, runId = '') {
  const normalizedScope = scope === 'run' ? 'run' : scope === 'task' ? 'task' : 'workspace'
  return [String(taskSlug || '').trim(), normalizedScope, String(runId || '').trim()].join('::')
}

function buildPatchCacheKey(signature = '', filePath = '') {
  return `${String(signature || '').trim()}::${String(filePath || '').trim()}`
}

function buildTaskSignaturePrefix(taskSlug = '') {
  return `${String(taskSlug || '').trim()}::`
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

function localizeLegacyDiffWarning(message = '') {
  const text = String(message || '').trim()
  if (!text) {
    return ''
  }

  const branchChangedMatch = text.match(/^当前分支已从 (.+) 切换到 (.+)$/)
  if (branchChangedMatch) {
    return translate('diffReview.warningBranchChanged', {
      from: branchChangedMatch[1],
      to: branchChangedMatch[2],
    })
  }

  if (text === '当前 HEAD 已不在基线 commit 的后续历史中，仓库可能经历了 reset、rebase 或切分支') {
    return translate('diffReview.warningHeadDetachedFromBaseline')
  }

  return text
}

function localizeLegacyDiffMessage(message = '') {
  const text = String(message || '').trim()
  if (!text) {
    return ''
  }

  const directMap = new Map([
    ['二进制文件暂不支持在线 diff 预览。', 'diffReview.binaryPreviewUnavailable'],
    ['文件内容较大，暂不展示具体 diff。', 'diffReview.fileTooLarge'],
    ['diff 内容较长，暂不在页面内完整展示。', 'diffReview.diffTooLong'],
    ['当前工作目录不是 Git 仓库，暂不支持代码变更审查。', 'diffReview.notGitRepo'],
    ['任务不存在。', 'diffReview.taskNotFound'],
    ['请选择一轮执行后再查看本轮代码变更。', 'diffReview.runRequired'],
    ['没有找到对应的执行记录。', 'diffReview.runNotFound'],
    ['这轮执行还没有建立代码变更基线，暂时无法查看本轮 diff。', 'diffReview.runBaselineMissing'],
    ['当前任务还没有建立代码变更基线，请先让 Codex 执行一轮。', 'diffReview.taskBaselineMissing'],
    ['这轮执行缺少结束快照，暂时无法准确还原本轮代码变更。', 'diffReview.runSnapshotMissing'],
    ['原工作目录已不是有效的 Git 仓库，暂时无法读取代码变更。', 'diffReview.originalRepoInvalid'],
    ['基线对应的 commit 已不存在，仓库可能被 reset、rebase 或切换到无关历史，暂时无法准确读取该范围的代码变更。', 'diffReview.baselineCommitMissing'],
  ])

  const key = directMap.get(text)
  if (key) {
    return translate(key)
  }

  return text
}

function normalizeDiffPayload(payload = null) {
  if (!payload || typeof payload !== 'object') {
    return payload
  }

  return {
    ...payload,
    reason: localizeLegacyDiffMessage(payload.reason),
    warnings: Array.isArray(payload.warnings)
      ? payload.warnings.map((item) => localizeLegacyDiffWarning(item)).filter(Boolean)
      : [],
    files: Array.isArray(payload.files)
      ? payload.files.map((file) => ({
        ...file,
        message: localizeLegacyDiffMessage(file?.message),
      }))
      : [],
  }
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
      parts.push(translate('diffReview.baselineTime', { value: formatDateTime(baseline.createdAt) }))
    }
    if (baseline.branch) {
      parts.push(translate('diffReview.baselineBranch', { value: baseline.branch }))
    }
    if (baseline.headShort) {
      parts.push(translate('diffReview.baselineCommit', { value: baseline.headShort }))
    }
    if (baseline.currentHeadShort) {
      parts.push(translate('diffReview.currentHead', { value: baseline.currentHeadShort }))
    }

    return parts.join(' · ')
  })

  function getRunStatusLabel(run) {
    if (run?.status === 'completed') {
      return translate('diffReview.completed')
    }
    if (run?.status === 'error') {
      return translate('diffReview.failed')
    }
    if (run?.status === 'interrupted') {
      return translate('diffReview.interrupted')
    }
    return translate('diffReview.stopped')
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
    return `${new Date(run?.startedAt || run?.createdAt).toLocaleString(getCurrentLocale())} · ${getRunStatusLabel(run)}`
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
      return translate('diffReview.added')
    }
    if (normalizeFileStatus(status) === 'D') {
      return translate('diffReview.deleted')
    }
    return translate('diffReview.modified')
  }

  function getStatusClass(status = '') {
    if (normalizeFileStatus(status) === 'A') {
      return 'theme-status-success'
    }
    if (normalizeFileStatus(status) === 'D') {
      return 'theme-status-danger'
    }
    return 'theme-status-warning'
  }

  function getFilterLabel(filter = 'all') {
    if (filter === 'A') {
      return translate('diffReview.added')
    }
    if (filter === 'D') {
      return translate('diffReview.deleted')
    }
    if (filter === 'M') {
      return translate('diffReview.modified')
    }
    return translate('diffReview.all')
  }

  function getFilterButtonClass(filter = 'all') {
    const activeClass = 'theme-filter-active'
    const inactiveClass = 'theme-filter-idle'
    return statusFilter.value === filter ? activeClass : inactiveClass
  }

  function getPatchLineClass(kind = 'context') {
    if (kind === 'add') {
      return 'theme-patch-add'
    }
    if (kind === 'delete') {
      return 'theme-patch-delete'
    }
    if (kind === 'hunk') {
      return 'theme-patch-hunk'
    }
    if (kind === 'meta') {
      return 'theme-patch-meta'
    }
    return 'theme-patch-context'
  }

  function clearCacheEntriesByPrefix(cache, prefix = '') {
    const normalizedPrefix = String(prefix || '').trim()
    if (!normalizedPrefix) {
      return
    }

    Array.from(cache.keys()).forEach((key) => {
      if (String(key || '').startsWith(normalizedPrefix)) {
        cache.delete(key)
      }
    })
  }

  function clearCurrentTaskDiffCache() {
    const prefix = buildTaskSignaturePrefix(props.taskSlug)
    clearCacheEntriesByPrefix(diffListCache, prefix)
    clearCacheEntriesByPrefix(diffStatsCache, prefix)
    clearCacheEntriesByPrefix(filePatchCache, prefix)
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
      events: 'none',
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
          reason: translate('diffReview.noReviewRuns'),
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

      const normalizedPayload = normalizeDiffPayload(payload)
      diffPayload.value = normalizedPayload
      setCachedValue(diffListCache, signature, normalizedPayload, 36)
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

      const normalizedPayload = normalizeDiffPayload(payload)
      diffPayload.value = {
        ...diffPayload.value,
        baseline: normalizedPayload.baseline || diffPayload.value.baseline || null,
        warnings: normalizedPayload.warnings || diffPayload.value.warnings || [],
        summary: normalizedPayload.summary || diffPayload.value.summary,
      }
      setCachedValue(diffStatsCache, signature, {
        baseline: normalizedPayload.baseline || null,
        warnings: normalizedPayload.warnings || [],
        summary: normalizedPayload.summary || null,
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

      const normalizedPayload = normalizeDiffPayload(payload)
      const detailedFile = (normalizedPayload.files || []).find((file) => file.path === filePath)
      if (!detailedFile || !diffPayload.value?.files) {
        return
      }

      setCachedValue(filePatchCache, patchCacheKey, detailedFile, 120)
      diffPayload.value = {
        ...diffPayload.value,
        baseline: normalizedPayload.baseline || diffPayload.value.baseline || null,
        warnings: normalizedPayload.warnings || diffPayload.value.warnings || [],
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

  async function refreshDiff() {
    if (!props.taskSlug || !props.active || loading.value) {
      return
    }

    clearCurrentTaskDiffCache()
    lastLoadedSignature = ''
    lastStatsLoadedSignature = ''
    runsLoadedTaskSlug = ''
    runsLoadedVersion = -1
    await loadDiff()
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
    refreshDiff,
  }
}
