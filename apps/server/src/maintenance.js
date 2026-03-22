import fs from 'node:fs'
import path from 'node:path'

import { serverRootDir } from './appPaths.js'
import { pruneCodexRunEvents } from './codexRuns.js'
import { getDatabaseFileStats, runDatabaseMaintenance } from './db.js'

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
const DEFAULT_RUN_EVENT_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.PROMPTX_CODEX_RUN_EVENT_RETENTION_MS) || 14 * 24 * 60 * 60 * 1000
)
const DEFAULT_MAX_EVENTS_PER_RUN = Math.max(
  50,
  Number(process.env.PROMPTX_CODEX_RUN_EVENTS_MAX_PER_RUN) || 2000
)
const DEFAULT_DB_VACUUM_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.PROMPTX_DB_VACUUM_INTERVAL_MS) || 24 * 60 * 60 * 1000
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
  const runEventRetentionMs = Math.max(
    60 * 1000,
    Number(options.runEventRetentionMs) || DEFAULT_RUN_EVENT_RETENTION_MS
  )
  const maxRunEventsPerRun = Math.max(
    1,
    Number(options.maxRunEventsPerRun) || DEFAULT_MAX_EVENTS_PER_RUN
  )
  const dbVacuumIntervalMs = Math.max(
    60 * 1000,
    Number(options.dbVacuumIntervalMs) || DEFAULT_DB_VACUUM_INTERVAL_MS
  )

  let timer = null
  let lastVacuumAt = ''
  let lastCleanup = {
    startedAt: '',
    finishedAt: '',
    durationMs: 0,
    removedTmpFiles: 0,
    removedRunnerCheckDirs: 0,
    runEvents: null,
    dbMaintenance: null,
    tmpTargets: [],
    reportTargets: [],
  }

  function shouldRunVacuum(now = Date.now(), force = false, hasCleanupWork = false) {
    if (force) {
      return true
    }
    if (!hasCleanupWork) {
      return false
    }
    if (!lastVacuumAt) {
      return true
    }
    const lastVacuumMs = Date.parse(lastVacuumAt)
    if (!Number.isFinite(lastVacuumMs)) {
      return true
    }
    return now - lastVacuumMs >= dbVacuumIntervalMs
  }

  function runCleanup(options = {}) {
    const startedAt = new Date().toISOString()
    const startedMs = Date.now()
    const forceDbVacuum = Boolean(options.forceDbVacuum)

    const tmpTargets = tmpRoots.map((targetDir) => pruneTmpFiles(targetDir, tmpFileRetentionMs))
    const reportTargets = reportDirs.map((targetDir) => pruneRunnerCheckDirectories(targetDir, reportRetentionMs))
    const runEvents = pruneCodexRunEvents({
      retentionMs: runEventRetentionMs,
      maxEventsPerRun: maxRunEventsPerRun,
      now: startedMs,
    })
    const shouldVacuumDb = shouldRunVacuum(startedMs, forceDbVacuum, runEvents.removedTotal > 0)
    const dbMaintenance = runDatabaseMaintenance({
      vacuum: shouldVacuumDb,
    })
    if (dbMaintenance.vacuumed) {
      lastVacuumAt = dbMaintenance.finishedAt
    }

    lastCleanup = {
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      removedTmpFiles: tmpTargets.reduce((sum, item) => sum + item.removed.length, 0),
      removedRunnerCheckDirs: reportTargets.reduce((sum, item) => sum + item.removed.length, 0),
      runEvents,
      dbMaintenance,
      tmpTargets,
      reportTargets,
    }

    logger.info?.({
      removedTmpFiles: lastCleanup.removedTmpFiles,
      removedRunnerCheckDirs: lastCleanup.removedRunnerCheckDirs,
      removedRunEvents: runEvents.removedTotal,
      dbVacuumed: dbMaintenance.vacuumed,
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
      runEventRetentionMs,
      maxRunEventsPerRun,
      dbVacuumIntervalMs,
      lastVacuumAt,
      tmpDir,
      reportDirs: [...reportDirs],
      db: getDatabaseFileStats(),
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
