import {
  createSessionEnvelopeEvent,
  createSessionUpdatedEnvelopeEvent,
  createStoppedEnvelopeEvent,
} from '../../../packages/shared/src/index.js'
import { assertAgentRunner } from './engines/index.js'

const EVENT_FLUSH_INTERVAL_MS = Math.max(50, Number(process.env.PROMPTX_RUNNER_EVENT_FLUSH_MS) || 250)
const HEARTBEAT_INTERVAL_MS = Math.max(1000, Number(process.env.PROMPTX_RUNNER_HEARTBEAT_MS) || 3000)
const STOPPING_HEARTBEAT_INTERVAL_MS = Math.max(
  250,
  Number(process.env.PROMPTX_RUNNER_STOP_HEARTBEAT_MS) || Math.min(HEARTBEAT_INTERVAL_MS, 500)
)
const DEFAULT_STOP_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTX_RUNNER_STOP_TIMEOUT_MS) || 10000)
const STOP_TIMEOUT_BUFFER_MS = Math.max(500, Number(process.env.PROMPTX_RUNNER_STOP_TIMEOUT_BUFFER_MS) || 2000)
const RUNNER_ID = String(process.env.PROMPTX_RUNNER_ID || 'local-runner').trim() || 'local-runner'

function nowIso() {
  return new Date().toISOString()
}

function normalizeSession(payload = {}) {
  return {
    id: String(payload.sessionId || payload.id || '').trim(),
    title: String(payload.sessionTitle || payload.title || '').trim(),
    engine: String(payload.engine || '').trim() || 'codex',
    cwd: String(payload.cwd || '').trim(),
    codexThreadId: String(payload.codexThreadId || payload.engineThreadId || '').trim(),
    engineSessionId: String(payload.engineSessionId || '').trim(),
    engineThreadId: String(payload.engineThreadId || payload.codexThreadId || '').trim(),
    engineMeta: payload.engineMeta && typeof payload.engineMeta === 'object' ? payload.engineMeta : {},
    running: true,
    started: Boolean(String(payload.engineThreadId || payload.codexThreadId || '').trim()),
    createdAt: String(payload.sessionCreatedAt || '').trim(),
    updatedAt: String(payload.sessionUpdatedAt || '').trim(),
  }
}

function createRunSnapshot(context = {}) {
  return {
    runId: context.runId,
    taskSlug: context.taskSlug,
    sessionId: context.session?.id || '',
    engine: context.engine,
    status: context.status,
    pid: Number(context.child?.pid || context.pid || 0) || 0,
    stopRequested: Boolean(context.stopRequestedAt),
    startedAt: context.startedAt || '',
    finishedAt: context.finishedAt || '',
    lastHeartbeatAt: context.lastHeartbeatAt || '',
    lastSeq: Math.max(0, Number(context.lastSeq) || 0),
  }
}

export function createRunManager(options = {}) {
  const serverClient = options.serverClient
  const logger = options.logger || console
  const resolveRunner = typeof options.resolveRunner === 'function' ? options.resolveRunner : assertAgentRunner
  const activeRuns = new Map()
  const startedAt = nowIso()
  const metrics = {
    totalStarted: 0,
    totalCompleted: 0,
    totalErrored: 0,
    totalStopped: 0,
    totalStopTimeout: 0,
  }

  async function postStatus(context, payload = {}) {
    context.lastHeartbeatAt = nowIso()
    try {
      await serverClient.postStatus({
        runnerId: RUNNER_ID,
        runId: context.runId,
        taskSlug: context.taskSlug,
        sessionId: context.session?.id || '',
        status: context.status,
        pid: Number(context.child?.pid || context.pid || 0) || 0,
        heartbeatAt: context.lastHeartbeatAt,
        ...payload,
      })
    } catch (error) {
      logger.error?.(error, 'runner status push failed')
    }
  }

  function queueEvent(context, payload = {}) {
    const normalizedPayload = payload && typeof payload === 'object'
      ? payload
      : { type: 'status', message: String(payload || '') }

    context.lastSeq += 1
    context.eventBuffer.push({
      runId: context.runId,
      seq: context.lastSeq,
      type: String(normalizedPayload.type || '').trim() || 'event',
      ts: nowIso(),
      payload: normalizedPayload,
    })
    scheduleFlush(context)
  }

  async function flushEvents(context, force = false) {
    if (!context) {
      return 0
    }

    if (!force && context.flushing) {
      return 0
    }

    if (!context.eventBuffer.length) {
      if (context.flushTimer) {
        clearTimeout(context.flushTimer)
        context.flushTimer = null
      }
      return 0
    }

    if (context.flushTimer) {
      clearTimeout(context.flushTimer)
      context.flushTimer = null
    }

    const pendingItems = context.eventBuffer.splice(0, context.eventBuffer.length)
    context.flushing = true

    try {
      await serverClient.postEvents(pendingItems, { runnerId: RUNNER_ID })
      return pendingItems.length
    } catch (error) {
      context.eventBuffer.unshift(...pendingItems)
      logger.error?.(error, 'runner event flush failed')
      if (!context.finalized) {
        scheduleFlush(context)
      }
      return 0
    } finally {
      context.flushing = false
    }
  }

  function scheduleFlush(context) {
    if (context.flushTimer) {
      return
    }

    context.flushTimer = setTimeout(() => {
      context.flushTimer = null
      flushEvents(context).catch(() => {})
    }, EVENT_FLUSH_INTERVAL_MS)
    context.flushTimer.unref?.()
  }

  function startHeartbeat(context) {
    if (context.heartbeatTimer) {
      return
    }

    context.heartbeatTimer = setInterval(() => {
      if (context.finalized) {
        return
      }
      postStatus(context).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    context.heartbeatTimer.unref?.()
  }

  function stopHeartbeat(context) {
    if (context.heartbeatTimer) {
      clearInterval(context.heartbeatTimer)
      context.heartbeatTimer = null
    }
  }

  function startStopProgressHeartbeat(context) {
    if (context.stopProgressTimer) {
      return
    }

    context.stopProgressTimer = setInterval(() => {
      if (context.finalized || !context.stopRequestedAt) {
        return
      }
      postStatus(context, {
        stopRequestedAt: context.stopRequestedAt,
      }).catch(() => {})
    }, STOPPING_HEARTBEAT_INTERVAL_MS)
    context.stopProgressTimer.unref?.()
  }

  function stopStopProgressHeartbeat(context) {
    if (context.stopProgressTimer) {
      clearInterval(context.stopProgressTimer)
      context.stopProgressTimer = null
    }
  }

  async function finalizeRun(context, nextStatus, payload = {}) {
    if (!context || context.finalized) {
      return createRunSnapshot(context)
    }

    context.finalized = true
    context.status = String(nextStatus || context.status || 'completed').trim() || 'completed'
    context.finishedAt = payload.finishedAt || nowIso()

    if (context.status === 'completed') {
      metrics.totalCompleted += 1
    } else if (context.status === 'error') {
      metrics.totalErrored += 1
    } else if (context.status === 'stopped') {
      metrics.totalStopped += 1
    } else if (context.status === 'stop_timeout') {
      metrics.totalStopTimeout += 1
    }

    stopHeartbeat(context)
    stopStopProgressHeartbeat(context)

    if (context.stopTimeoutTimer) {
      clearTimeout(context.stopTimeoutTimer)
      context.stopTimeoutTimer = null
    }

    if (payload.event) {
      queueEvent(context, payload.event)
    }

    await flushEvents(context, true)
    await postStatus(context, {
      exitCode: payload.exitCode ?? context.child?.exitCode ?? null,
      signal: payload.signal ?? context.child?.signalCode ?? null,
      responseMessage: String(payload.responseMessage || '').trim(),
      errorMessage: String(payload.errorMessage || '').trim(),
      finishedAt: context.finishedAt,
      session: context.session,
    })

    activeRuns.delete(context.runId)
    return createRunSnapshot(context)
  }

  async function handleStreamCompletion(context, result = {}) {
    if (context.stopRequestedAt) {
      await finalizeRun(context, 'stopped', {
        responseMessage: String(result?.message || '').trim(),
        event: createStoppedEnvelopeEvent('执行已手动停止'),
      })
      return
    }

    await flushEvents(context, true)
    await finalizeRun(context, 'completed', {
      responseMessage: String(result?.message || '').trim(),
    })
  }

  async function handleStreamError(context, error) {
    if (context.stopRequestedAt) {
      await finalizeRun(context, 'stopped', {
        event: createStoppedEnvelopeEvent('执行已手动停止'),
      })
      return
    }

    await finalizeRun(context, 'error', {
      errorMessage: error?.message || '执行引擎运行失败。',
    })
  }

  async function executeRun(context) {
    let runner
    try {
      runner = resolveRunner(context.engine)
    } catch (error) {
      await finalizeRun(context, 'error', {
        errorMessage: error.message || '当前执行引擎不可用。',
      })
      return
    }

    queueEvent(context, createSessionEnvelopeEvent(context.session))

    try {
      const stream = runner.streamSessionPrompt(context.session, context.prompt, {
        onEvent(event) {
          queueEvent(context, event)
        },
        onThreadStarted(threadId) {
          const value = String(threadId || '').trim()
          if (!value) {
            return
          }

          context.session = {
            ...context.session,
            codexThreadId: value,
            engineThreadId: value,
            running: true,
            started: true,
            updatedAt: nowIso(),
          }
          queueEvent(context, createSessionUpdatedEnvelopeEvent(context.session))
        },
      })

      context.stream = stream
      context.child = stream.child || null
      context.pid = Number(stream.child?.pid || 0) || 0
      context.startedAt = nowIso()
      context.status = 'running'

      startHeartbeat(context)
      await postStatus(context, {
        startedAt: context.startedAt,
        session: context.session,
      })

      if (context.stopRequestedAt) {
        try {
          stream.cancel({
            graceMs: context.stopGraceMs,
          })
        } catch {
          // Ignore cancel failures here; stop timeout will handle the rest.
        }
      }

      const result = await stream.result
      await handleStreamCompletion(context, result)
    } catch (error) {
      await handleStreamError(context, error)
    }
  }

  function ensureStopTimeout(context, stopTimeoutMs) {
    if (context.stopTimeoutTimer) {
      return
    }

    context.stopTimeoutTimer = setTimeout(() => {
      finalizeRun(context, 'stop_timeout', {
        errorMessage: '停止超时，runner 未能在限定时间内完成回收。',
      }).catch(() => {})
    }, stopTimeoutMs)
    context.stopTimeoutTimer.unref?.()
  }

  return {
    getRun(runId = '') {
      const context = activeRuns.get(String(runId || '').trim())
      return context ? createRunSnapshot(context) : null
    },
    getDiagnostics() {
      return {
        runnerId: RUNNER_ID,
        startedAt,
        activeRunCount: activeRuns.size,
        activeRuns: [...activeRuns.values()].map((context) => ({
          ...createRunSnapshot(context),
          cwd: String(context.session?.cwd || '').trim(),
          title: String(context.session?.title || '').trim(),
        })),
        metrics: {
          ...metrics,
        },
        config: {
          eventFlushIntervalMs: EVENT_FLUSH_INTERVAL_MS,
          heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
          stoppingHeartbeatIntervalMs: STOPPING_HEARTBEAT_INTERVAL_MS,
          defaultStopTimeoutMs: DEFAULT_STOP_TIMEOUT_MS,
        },
      }
    },
    async startRun(payload = {}) {
      const runId = String(payload.runId || '').trim()
      if (!runId) {
        throw new Error('缺少 runId')
      }

      const existing = activeRuns.get(runId)
      if (existing) {
        return createRunSnapshot(existing)
      }

      const session = normalizeSession(payload)
      if (!session.id || !session.cwd) {
        throw new Error('缺少 PromptX 项目上下文')
      }

      const context = {
        runId,
        taskSlug: String(payload.taskSlug || '').trim(),
        prompt: String(payload.prompt || '').trim(),
        promptBlocks: Array.isArray(payload.promptBlocks) ? payload.promptBlocks : [],
        engine: String(payload.engine || session.engine || 'codex').trim() || 'codex',
        session,
        status: 'starting',
        startedAt: '',
        finishedAt: '',
        stopRequestedAt: '',
        lastHeartbeatAt: '',
        lastSeq: 0,
        eventBuffer: [],
        flushTimer: null,
        flushing: false,
        heartbeatTimer: null,
        stopProgressTimer: null,
        stopTimeoutTimer: null,
        stopGraceMs: 0,
        finalized: false,
        child: null,
        stream: null,
      }

      activeRuns.set(runId, context)
      metrics.totalStarted += 1
      await postStatus(context, {
        session: context.session,
      })
      executeRun(context).catch((error) => {
        logger.error?.(error, 'runner execute failed unexpectedly')
      })
      return createRunSnapshot(context)
    },
    async stopRun(runId = '', options = {}) {
      const context = activeRuns.get(String(runId || '').trim())
      if (!context) {
        return null
      }

      if (context.finalized) {
        return createRunSnapshot(context)
      }

      if (context.stopRequestedAt) {
        return createRunSnapshot(context)
      }

      context.stopRequestedAt = nowIso()
      context.status = 'stopping'
      await postStatus(context, {
        stopRequestedAt: context.stopRequestedAt,
      })
      startStopProgressHeartbeat(context)

      const stopGraceMs = Math.max(200, Number(options.forceAfterMs) || 1500)
      context.stopGraceMs = stopGraceMs
      const stopTimeoutMs = Math.max(DEFAULT_STOP_TIMEOUT_MS, stopGraceMs + STOP_TIMEOUT_BUFFER_MS)
      ensureStopTimeout(context, stopTimeoutMs)

      try {
        context.stream?.cancel?.({
          graceMs: stopGraceMs,
        })
      } catch {
        // Ignore runner cancel failures and rely on timeout handling.
      }

      return createRunSnapshot(context)
    },
    async dispose() {
      await Promise.all(
        [...activeRuns.values()].map((context) =>
          this.stopRun(context.runId, { forceAfterMs: 1000 }).catch(() => null)
        )
      )
    },
  }
}
