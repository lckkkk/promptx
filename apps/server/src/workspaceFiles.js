import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApiError } from './apiErrors.js'

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'tmp',
  'temp',
  'uploads',
])

const DIRECTORY_PICKER_HIDDEN_NAMES = new Set([
  'Applications',
  'Downloads',
  'Library',
  'Movies',
  'Music',
  'Pictures',
  'Public',
])

const DEFAULT_TREE_LIMIT = 200
const DEFAULT_SEARCH_LIMIT = 80
const MAX_SEARCH_VISITS = 20000
const DIRECTORY_PICKER_LIMIT = 240

function createHttpError(message, statusCode = 400) {
  return createApiError('', message, statusCode)
}

function toPosixPath(value = '') {
  return String(value || '').replace(/\\/g, '/')
}

function normalizeRelativePath(relativePath = '') {
  const value = toPosixPath(relativePath).trim()
  if (!value || value === '.') {
    return ''
  }

  if (value.includes('\0')) {
    throw createApiError('errors.invalidPath', '路径不合法。')
  }

  const cleaned = value
    .replace(/^\/+/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')

  if (!cleaned) {
    return ''
  }

  const segments = cleaned.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw createApiError('errors.invalidPath', '路径不合法。')
  }

  return cleaned
}

function ensurePathInsideWorkspace(workspacePath, targetPath) {
  const root = path.resolve(String(workspacePath || ''))
  const target = path.resolve(String(targetPath || ''))

  if (target === root) {
    return target
  }

  if (target.startsWith(`${root}${path.sep}`)) {
    return target
  }

  throw createApiError('errors.pathOutsideWorkspace', '只能访问当前工作目录内的文件。', 403)
}

function resolveWorkspaceTarget(workspacePath, relativePath = '') {
  const root = path.resolve(String(workspacePath || ''))
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const targetPath = normalizedRelativePath
    ? path.resolve(root, normalizedRelativePath)
    : root

  return {
    root,
    relativePath: normalizedRelativePath,
    absolutePath: ensurePathInsideWorkspace(root, targetPath),
  }
}

function getPathType(absolutePath = '') {
  try {
    const stats = fs.statSync(absolutePath)
    if (stats.isDirectory()) {
      return 'directory'
    }
    if (stats.isFile()) {
      return 'file'
    }
  } catch {
    return ''
  }

  return ''
}

function shouldIgnoreDirectory(entry) {
  return entry?.isDirectory?.() && IGNORED_DIRECTORY_NAMES.has(entry.name)
}

function shouldIgnorePickerDirectory(entry) {
  if (!entry?.isDirectory?.()) {
    return false
  }

  const name = String(entry.name || '').trim()
  if (!name) {
    return false
  }

  return name.startsWith('.')
    || IGNORED_DIRECTORY_NAMES.has(name)
    || DIRECTORY_PICKER_HIDDEN_NAMES.has(name)
}

function compareWorkspaceEntries(left, right) {
  const typeDiff = Number(left.type !== 'directory') - Number(right.type !== 'directory')
  if (typeDiff) {
    return typeDiff
  }

  return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
}

function compareDirectoryEntries(left, right) {
  return String(left.name || left.path || '').localeCompare(String(right.name || right.path || ''), 'zh-CN')
}

function buildWorkspaceItem(workspacePath, absolutePath, entry, typeOverride = '') {
  const type = typeOverride || (entry?.isDirectory?.() ? 'directory' : 'file')
  const relativePath = path.relative(workspacePath, absolutePath)

  return {
    name: entry?.name || path.basename(absolutePath),
    path: toPosixPath(relativePath),
    type,
    hasChildren: type === 'directory' ? directoryHasVisibleChildren(absolutePath) : false,
  }
}

function directoryHasVisibleChildren(directoryPath = '') {
  try {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    return entries.some((entry) => !shouldIgnoreDirectory(entry))
  } catch {
    return false
  }
}

function directoryHasVisiblePickerChildren(directoryPath = '') {
  try {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    return entries.some((entry) => entry.isDirectory() && !shouldIgnorePickerDirectory(entry))
  } catch {
    return false
  }
}

function createDirectoryPickerItem(directoryPath = '', entryName = '') {
  const normalizedPath = path.resolve(String(directoryPath || ''))
  const parsed = path.parse(normalizedPath)
  const isRoot = normalizedPath === parsed.root
  const displayPath = normalizedPath
  const displayName = entryName
    || (isRoot
      ? (process.platform === 'win32'
        ? normalizedPath.replace(/[\\/]+$/, '')
        : normalizedPath)
      : path.basename(normalizedPath))

  return {
    name: displayName || displayPath,
    path: displayPath,
    type: 'directory',
    hasChildren: directoryHasVisiblePickerChildren(normalizedPath),
    isRoot,
  }
}

function getDirectoryPickerHomePath() {
  return path.resolve(os.homedir())
}

function normalizeDirectoryPickerPath(input = '') {
  const value = String(input || '').trim()
  if (!value) {
    return ''
  }

  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved)) {
    throw createApiError('errors.directoryNotFound', '目录不存在，请重新选择。', 404)
  }

  const stats = fs.statSync(resolved)
  if (!stats.isDirectory()) {
    throw createApiError('errors.directoryOnly', '只能选择文件夹。')
  }

  return resolved
}

function getDirectoryParentPath(directoryPath = '') {
  const resolved = path.resolve(String(directoryPath || ''))
  const parsed = path.parse(resolved)

  if (resolved === parsed.root) {
    return ''
  }

  const parentPath = path.dirname(resolved)
  return parentPath === resolved ? '' : parentPath
}

function clampLimit(value, fallback, max) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback
  }

  return Math.min(Math.floor(normalized), max)
}

function removeExtension(value = '') {
  const normalized = String(value || '')
  const extensionIndex = normalized.lastIndexOf('.')
  if (extensionIndex <= 0) {
    return normalized
  }

  return normalized.slice(0, extensionIndex)
}

function splitSegmentWords(segment = '') {
  return removeExtension(String(segment || ''))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

function scoreExactPrefixSubstring(candidate = '', query = '', weights = {}) {
  const source = String(candidate || '').toLowerCase()
  const keyword = String(query || '').trim().toLowerCase()

  if (!source || !keyword) {
    return 0
  }

  if (source === keyword) {
    return weights.exact ?? 0
  }

  if (source.startsWith(keyword)) {
    return (weights.prefix ?? 0) - source.length
  }

  const substringIndex = source.indexOf(keyword)
  if (substringIndex >= 0) {
    return (weights.substring ?? 0) - substringIndex * 12 - Math.max(source.length - keyword.length, 0)
  }

  return 0
}

function scoreCompactSubsequence(candidate = '', query = '') {
  const source = String(candidate || '').toLowerCase()
  const keyword = String(query || '').trim().toLowerCase()

  if (!source || !keyword || keyword.length < 2 || keyword.length > source.length) {
    return 0
  }

  const positions = []
  let searchIndex = 0

  for (const char of keyword) {
    const matchIndex = source.indexOf(char, searchIndex)
    if (matchIndex < 0) {
      return 0
    }
    positions.push(matchIndex)
    searchIndex = matchIndex + 1
  }

  const span = positions[positions.length - 1] - positions[0] + 1
  const gap = span - keyword.length
  const maxGap = Math.max(2, Math.floor(keyword.length * 0.6))
  const coverage = keyword.length / span

  if (gap > maxGap || coverage < 0.72) {
    return 0
  }

  return 3200 - gap * 120 - Math.max(source.length - keyword.length, 0)
}

function scorePathMatch(relativePath = '', query = '') {
  const normalizedPath = toPosixPath(relativePath).toLowerCase()
  const keyword = String(query || '').trim().toLowerCase()

  if (!normalizedPath || !keyword) {
    return 0
  }

  if (normalizedPath === keyword) {
    return 16000
  }

  if (normalizedPath.startsWith(keyword)) {
    return 13200 - normalizedPath.length
  }

  const boundaryPrefixIndex = normalizedPath.indexOf(`/${keyword}`)
  if (boundaryPrefixIndex >= 0) {
    return 12000 - boundaryPrefixIndex * 8 - normalizedPath.length
  }

  const substringIndex = normalizedPath.indexOf(keyword)
  if (substringIndex >= 0) {
    return 9800 - substringIndex * 12 - Math.max(normalizedPath.length - keyword.length, 0)
  }

  return 0
}

function scoreSegmentMatch(segment = '', query = '', options = {}) {
  const keyword = String(query || '').trim().toLowerCase()
  const normalizedSegment = String(segment || '').toLowerCase()
  const bareSegment = removeExtension(normalizedSegment)

  if (!normalizedSegment || !keyword) {
    return 0
  }

  const exactWeights = options.isFileName
    ? { exact: 15000, prefix: 12600, substring: 10600 }
    : { exact: 12400, prefix: 10400, substring: 9000 }

  let bestScore = Math.max(
    scoreExactPrefixSubstring(normalizedSegment, keyword, exactWeights),
    scoreExactPrefixSubstring(bareSegment, keyword, exactWeights)
  )

  const words = splitSegmentWords(segment)
  if (words.length) {
    const initials = words.map((word) => word[0]).join('')
    const compact = words.join('')

    for (const word of words) {
      bestScore = Math.max(
        bestScore,
        scoreExactPrefixSubstring(word, keyword, {
          exact: 11600,
          prefix: 9800,
          substring: 8200,
        })
      )
    }

    if (initials && keyword.length >= 2 && initials.startsWith(keyword)) {
      bestScore = Math.max(bestScore, 6000 - initials.length * 10)
    }

    bestScore = Math.max(bestScore, scoreCompactSubsequence(compact || bareSegment, keyword))
  } else {
    bestScore = Math.max(bestScore, scoreCompactSubsequence(bareSegment || normalizedSegment, keyword))
  }

  return bestScore
}

function scoreWorkspaceMatch(relativePath = '', query = '') {
  const normalizedPath = toPosixPath(relativePath)
  const keyword = String(query || '').trim().toLowerCase()

  if (!normalizedPath || !keyword) {
    return 0
  }

  const pathScore = scorePathMatch(normalizedPath, keyword)
  if (keyword.includes('/')) {
    return pathScore
  }

  const segments = normalizedPath.split('/').filter(Boolean)
  const fileName = segments.at(-1) || normalizedPath
  const nameScore = scoreSegmentMatch(fileName, keyword, { isFileName: true })
  const segmentScore = segments.reduce((bestScore, segment, index) => Math.max(
    bestScore,
    scoreSegmentMatch(segment, keyword, { isFileName: index === segments.length - 1 })
  ), 0)

  return Math.max(pathScore, nameScore, segmentScore)
}

export function listWorkspaceTree(workspacePath, options = {}) {
  const target = resolveWorkspaceTarget(workspacePath, options.path)
  const type = getPathType(target.absolutePath)

  if (!type) {
    throw createApiError('errors.targetPathNotFound', '目标路径不存在。', 404)
  }

  if (type !== 'directory') {
    throw createApiError('errors.directoryExpandOnly', '只能展开目录。')
  }

  const limit = clampLimit(options.limit, DEFAULT_TREE_LIMIT, 500)
  const entries = fs.readdirSync(target.absolutePath, { withFileTypes: true })
    .filter((entry) => !shouldIgnoreDirectory(entry))
    .map((entry) => buildWorkspaceItem(target.root, path.join(target.absolutePath, entry.name), entry))
    .sort(compareWorkspaceEntries)

  return {
    cwd: target.root,
    path: target.relativePath,
    parentPath: target.relativePath.includes('/')
      ? target.relativePath.slice(0, target.relativePath.lastIndexOf('/'))
      : '',
    items: entries.slice(0, limit),
    truncated: entries.length > limit,
  }
}

export function searchWorkspaceEntries(workspacePath, options = {}) {
  const root = path.resolve(String(workspacePath || ''))
  const query = String(options.query || '').trim()
  const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, 200)

  if (!query) {
    return {
      cwd: root,
      query: '',
      items: [],
      truncated: false,
    }
  }

  const matches = []
  let visited = 0
  let truncated = false
  const stack = ['']

  while (stack.length) {
    const currentRelativePath = stack.pop()
    const currentAbsolutePath = currentRelativePath
      ? path.join(root, currentRelativePath)
      : root

    let entries = []
    try {
      entries = fs.readdirSync(currentAbsolutePath, { withFileTypes: true })
    } catch {
      continue
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

    for (const entry of entries) {
      if (shouldIgnoreDirectory(entry)) {
        continue
      }

      visited += 1
      if (visited > MAX_SEARCH_VISITS) {
        truncated = true
        stack.length = 0
        break
      }

      const relativePath = currentRelativePath
        ? `${toPosixPath(currentRelativePath)}/${entry.name}`
        : entry.name
      const absolutePath = path.join(currentAbsolutePath, entry.name)
      const type = entry.isDirectory() ? 'directory' : 'file'
      const score = scoreWorkspaceMatch(relativePath, query)

      if (score > 0) {
        matches.push({
          ...buildWorkspaceItem(root, absolutePath, entry, type),
          score,
        })
      }

      if (entry.isDirectory()) {
        stack.push(path.join(currentRelativePath, entry.name))
      }
    }
  }

  matches.sort((left, right) => {
    const scoreDiff = right.score - left.score
    if (scoreDiff) {
      return scoreDiff
    }

    const typeDiff = Number(left.type !== 'directory') - Number(right.type !== 'directory')
    if (typeDiff) {
      return typeDiff
    }

    const pathLengthDiff = left.path.length - right.path.length
    if (pathLengthDiff) {
      return pathLengthDiff
    }

    return left.path.localeCompare(right.path, 'zh-CN')
  })

  return {
    cwd: root,
    query,
    items: matches.slice(0, limit).map(({ score, ...item }) => item),
    truncated: truncated || matches.length > limit,
  }
}

export function listDirectoryPickerTree(options = {}) {
  const targetPath = normalizeDirectoryPickerPath(options.path) || getDirectoryPickerHomePath()

  const limit = clampLimit(options.limit, DIRECTORY_PICKER_LIMIT, 600)
  const entries = fs.readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !shouldIgnorePickerDirectory(entry))
    .map((entry) => createDirectoryPickerItem(path.join(targetPath, entry.name), entry.name))
    .sort(compareDirectoryEntries)

  return {
    path: targetPath,
    parentPath: '',
    items: entries.slice(0, limit),
    truncated: entries.length > limit,
  }
}

function scoreDirectoryPickerMatch(directoryPath = '', basePath = '', query = '') {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!directoryPath || !normalizedQuery) {
    return 0
  }

  const absoluteScore = scoreWorkspaceMatch(toPosixPath(directoryPath), normalizedQuery)
  const base = String(basePath || '').trim()
  const relativePath = base ? toPosixPath(path.relative(base, directoryPath)) : toPosixPath(directoryPath)
  const relativeScore = scoreWorkspaceMatch(relativePath, normalizedQuery)
  const nameScore = scoreSegmentMatch(path.basename(directoryPath), normalizedQuery, { isFileName: false })
  return Math.max(absoluteScore, relativeScore, nameScore)
}

export function searchDirectoryPickerEntries(options = {}) {
  const query = String(options.query || '').trim()
  const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, 200)

  if (!query) {
    return {
      path: '',
      query: '',
      items: [],
      truncated: false,
    }
  }

  const targetPath = normalizeDirectoryPickerPath(options.path) || getDirectoryPickerHomePath()
  const roots = [targetPath]
  const matches = []
  let visited = 0
  let truncated = false

  for (const rootPath of roots) {
    const stack = [rootPath]

    while (stack.length) {
      const currentPath = stack.pop()
      let entries = []

      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true })
      } catch {
        continue
      }

      entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

      for (const entry of entries) {
        if (!entry.isDirectory() || shouldIgnorePickerDirectory(entry)) {
          continue
        }

        visited += 1
        if (visited > MAX_SEARCH_VISITS) {
          truncated = true
          stack.length = 0
          break
        }

        const absolutePath = path.join(currentPath, entry.name)
        const score = scoreDirectoryPickerMatch(absolutePath, rootPath, query)
        if (score > 0) {
          matches.push({
            ...createDirectoryPickerItem(absolutePath, entry.name),
            score,
          })
        }

        stack.push(absolutePath)
      }

      if (truncated) {
        break
      }
    }

    if (truncated) {
      break
    }
  }

  matches.sort((left, right) => {
    const scoreDiff = right.score - left.score
    if (scoreDiff) {
      return scoreDiff
    }

    const depthDiff = left.path.split(path.sep).length - right.path.split(path.sep).length
    if (depthDiff) {
      return depthDiff
    }

    return String(left.path || '').localeCompare(String(right.path || ''), 'zh-CN')
  })

  return {
    path: targetPath,
    query,
    items: matches.slice(0, limit).map(({ score, ...item }) => item),
    truncated: truncated || matches.length > limit,
  }
}
