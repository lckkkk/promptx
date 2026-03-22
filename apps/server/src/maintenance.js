import fs from 'node:fs'
import path from 'node:path'

import { serverRootDir } from './appPaths.js'

const DEFAULT_TMP_FILE_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.PROMPTX_TMP_FILE_RETENTION_MS) || 24 * 60 * 60 * 1000
)
const DEFAULT_REPORT_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.PROMPTX_REPORT_RETENTION_MS) || 7 * 24 * 60 * 60 * 1000
)
const DEFAULT_CLEANUP_INTERVAL_MS = Math.max(
  60 * 1000,
  Number(process.env.PROMPTX_MAINTENANCE_INTERVAL_MS) || 60 * 60 * 1000
)

function safeReadDir(targetDir = '') {
  try {
    return fs.readdirSync(targetDir, { withFileTypes: true })
  } catch {
    return []
  }
}

function getEntryAgeMs(targetPath = '', stats = null) {
  try {
    const resolvedStats = stats || fs.statSync(targetPath)
    return Date.now() - resolvedStats.mtimeMs
  } catch {
    return -1
  }
}

function removePath(targetPath = '') {
  try {
    fs.rmSync(targetPath, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

function pruneRunnerCheckDirectories(targetDir = '', maxAgeMs = DEFAULT_REPORT_RETENTION_MS) {
  const removed = []
  const kept = []

  safeReadDir(targetDir).forEach((entry) => {
    if (!entry.isDirectory()) {
      return
    }

    const entryPath = path.join(targetDir, entry.name)
    const ageMs = getEntryAgeMs(entryPath)
    if (ageMs < 0) {
      return
    }

    if (ageMs >= maxAgeMs && removePath(entryPath)) {
      removed.push(entryPath)
      return
    }

    kept.push(entryPath)
  })

  return {
    targetDir,
    removed,
    keptCount: kept.length,
  }
}

function pruneTmpFiles(targetDir = '', maxAgeMs = DEFAULT_TMP_FILE_RETENTION_MS) {
  const removed = []
  const kept = []

  safeReadDir(targetDir).forEach((entry) => {
    if (!entry.isFile()) {
      return
    }

    const entryPath = path.join(targetDir, entry.name)
    const ageMs = getEntryAgeMs(entryPath)
    if (ageMs < 0) {
      return
    }

    if (ageMs >= maxAgeMs && removePath(entryPath)) {
      removed.push(entryPath)
      return
    }

    kept.push(entryPath)
  })

  return {
    targetDir,
    removed,
    keptCount: kept.length,
  }
}

export function createMaintenanceService(options = {}) {
  const logger = options.logger || console
  const tmpDir = String(options.tmpDir || '').trim()
  const tmpFileRetentionMs = Math.max(60 * 1000, Number(options.tmpFileRetentionMs) || DEFAULT_TMP_FILE_RETENTION_MS)
  const reportRetentionMs = Math.max(60 * 1000, Number(options.reportRetentionMs) || DEFAULT_REPORT_RETENTION_MS)
  const reportDirs = (
    Array.isArray(options.reportDirs) && options.reportDirs.length
      ? options.reportDirs
      : [
          path.join(serverRootDir, 'tmp', 'runner-checks'),
          tmpDir ? path.join(tmpDir, 'runner-checks') : '',
        ]
  )
    .map((item) => String(item || '').trim())
    .filter(Boolean)
  const tmpRoots = [tmpDir].filter(Boolean)
  const cleanupIntervalMs = Math.max(60 * 1000, Number(options.cleanupIntervalMs) || DEFAULT_CLEANUP_INTERVAL_MS)

  let timer = null
  let lastCleanup = {
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    removedTmpFiles: 0,
    removedRunnerCheckDirs: 0,
    tmpTargets: [],
    reportTargets: [],
  }

  function runCleanup() {
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()

    const tmpTargets = tmpRoots.map((targetDir) => pruneTmpFiles(targetDir, tmpFileRetentionMs))
    const reportTargets = reportDirs.map((targetDir) => pruneRunnerCheckDirectories(targetDir, reportRetentionMs))

    lastCleanup = {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      removedTmpFiles: tmpTargets.reduce((sum, item) => sum + item.removed.length, 0),
      removedRunnerCheckDirs: reportTargets.reduce((sum, item) => sum + item.removed.length, 0),
      tmpTargets,
      reportTargets,
    }

    logger.info?.({
      removedTmpFiles: lastCleanup.removedTmpFiles,
      removedRunnerCheckDirs: lastCleanup.removedRunnerCheckDirs,
      durationMs: lastCleanup.durationMs,
    }, '[maintenance] cleanup completed')

    return lastCleanup
  }

  function start() {
    if (timer) {
      return
    }

    runCleanup()
    timer = setInterval(() => {
      try {
        runCleanup()
      } catch (error) {
        logger.error?.(error, '[maintenance] cleanup failed')
      }
    }, cleanupIntervalMs)
    timer.unref?.()
  }

  function stop() {
    if (!timer) {
      return
    }
    clearInterval(timer)
    timer = null
  }

  function getDiagnostics() {
    return {
      cleanupIntervalMs,
      tmpFileRetentionMs,
      reportRetentionMs,
      tmpDir,
      reportDirs: [...reportDirs],
      lastCleanup: {
        ...lastCleanup,
        tmpTargets: lastCleanup.tmpTargets.map((item) => ({
          ...item,
          removed: [...item.removed],
        })),
        reportTargets: lastCleanup.reportTargets.map((item) => ({
          ...item,
          removed: [...item.removed],
        })),
      },
    }
  }

  return {
    start,
    stop,
    runCleanup,
    getDiagnostics,
  }
}
