import {
  appendCodexRunEventAutoSeq,
  getCodexRunById,
  isActiveRunStatus,
  listStaleActiveCodexRuns,
  updateCodexRunFromRunnerStatus,
} from './codexRuns.js'

const DEFAULT_STARTUP_GRACE_MS = Math.max(1000, Number(process.env.PROMPTX_RUNNER_RECOVERY_STARTUP_GRACE_MS) || 12000)
const DEFAULT_STALE_THRESHOLD_MS = Math.max(5000, Number(process.env.PROMPTX_RUNNER_STALE_THRESHOLD_MS) || 20000)
const DEFAULT_SWEEP_INTERVAL_MS = Math.max(1000, Number(process.env.PROMPTX_RUNNER_SWEEP_INTERVAL_MS) || 5000)

function createRunnerLostMessage(status = '') {
  return status === 'stopping'
    ? 'Runner 停止超时，已将本次运行标记为停止超时。'
    : 'Runner 已失联，当前运行已被服务端回收。'
}

export function createRunRecoveryService(options = {}) {
  const logger = options.logger || console
  const broadcastServerEvent = options.broadcastServerEvent || (() => {})
  const onRecoveredRun = typeof options.onRecoveredRun === 'function'
    ? options.onRecoveredRun
    : () => {}
  const startupGraceMs = Math.max(1000, Number(options.startupGraceMs) || DEFAULT_STARTUP_GRACE_MS)
  const staleThresholdMs = Math.max(5000, Number(options.staleThresholdMs) || DEFAULT_STALE_THRESHOLD_MS)
  const sweepIntervalMs = Math.max(1000, Number(options.sweepIntervalMs) || DEFAULT_SWEEP_INTERVAL_MS)

  let startupTimer = null
  let sweepTimer = null
  let sweeping = false

  function recoverRun(runRecord) {
    const latestRun = getCodexRunById(runRecord?.id)
    if (!latestRun || !isActiveRunStatus(latestRun.status)) {
      return null
    }

    const message = createRunnerLostMessage(latestRun.status)
    const recoveryEvent = appendCodexRunEventAutoSeq(latestRun.id, {
      type: 'error',
      message,
    })

    const nextRun = updateCodexRunFromRunnerStatus(latestRun.id, {
      status: latestRun.status === 'stopping' ? 'stop_timeout' : 'error',
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    })

    if (!nextRun) {
      return null
    }

    broadcastServerEvent('run.event', {
      taskSlug: nextRun.taskSlug,
      runId: nextRun.id,
      event: recoveryEvent,
    })
    broadcastServerEvent('runs.changed', {
      taskSlug: nextRun.taskSlug,
      runId: nextRun.id,
    })
    broadcastServerEvent('sessions.changed', {
      sessionId: nextRun.sessionId,
    })
    onRecoveredRun(nextRun)
    return nextRun
  }

  function sweep() {
    if (sweeping) {
      return []
    }

    sweeping = true
    try {
      const staleRuns = listStaleActiveCodexRuns(staleThresholdMs)
      return staleRuns.map((runRecord) => recoverRun(runRecord)).filter(Boolean)
    } catch (error) {
      logger.error?.(error, '[run-recovery] stale run sweep failed')
      return []
    } finally {
      sweeping = false
    }
  }

  function stop() {
    if (startupTimer) {
      clearTimeout(startupTimer)
      startupTimer = null
    }
    if (sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }

  function start() {
    stop()
    startupTimer = setTimeout(() => {
      sweep()
      sweepTimer = setInterval(() => {
        sweep()
      }, sweepIntervalMs)
      sweepTimer.unref?.()
    }, startupGraceMs)
    startupTimer.unref?.()
  }

  return {
    start,
    stop,
    sweep,
  }
}
