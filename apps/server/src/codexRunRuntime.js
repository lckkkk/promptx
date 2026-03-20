import {
  createSessionEnvelopeEvent,
  createSessionUpdatedEnvelopeEvent,
  createStoppedEnvelopeEvent,
} from '../../../packages/shared/src/index.js'
import { getPromptxCodexSessionById, updatePromptxCodexSession } from './codexSessions.js'
import { appendCodexRunEvent, updateCodexRun } from './codexRuns.js'
import { assertAgentRunner } from './agents/index.js'

export function createAgentRunRuntime(options = {}) {
  const {
    decorateSession = (session) => session,
    onRunEvent = () => {},
    onRunUpdated = () => {},
    onSessionChanged = () => {},
  } = options

  const activeControllers = new Map()

  function getController(runId = '') {
    return activeControllers.get(String(runId || '').trim()) || null
  }

  function setController(runId = '', controller) {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId || !controller) {
      return
    }

    activeControllers.set(normalizedRunId, controller)
  }

  function clearController(runId = '') {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId) {
      return
    }

    activeControllers.delete(normalizedRunId)
  }

  function notifyListeners(runId = '', payload = {}) {
    const controller = getController(runId)
    if (!controller?.listeners?.size) {
      return
    }

    controller.listeners.forEach((listener) => {
      try {
        listener(payload)
      } catch {
        // Ignore observer failures to avoid affecting the run lifecycle.
      }
    })
  }

  function subscribe(runId = '', listener) {
    const controller = getController(runId)
    if (!controller || typeof listener !== 'function') {
      return () => {}
    }

    controller.listeners.add(listener)
    return () => {
      controller.listeners.delete(listener)
    }
  }

  function start(runRecord) {
    const runId = String(runRecord?.id || '').trim()
    if (!runId) {
      return
    }

    const session = getPromptxCodexSessionById(runRecord.sessionId)
    if (!session) {
      updateCodexRun(runId, {
        status: 'error',
        errorMessage: '没有找到对应的 PromptX 项目。',
        finishedAt: new Date().toISOString(),
      })
      return
    }

    let runner
    try {
      runner = assertAgentRunner(session.engine)
    } catch (error) {
      updateCodexRun(runId, {
        status: 'error',
        errorMessage: error.message || '当前执行引擎不可用。',
        finishedAt: new Date().toISOString(),
      })
      return
    }

    let eventSeq = 0
    let stopRequested = false
    let stopFinalized = false

    const persistRunEvent = (payload) => {
      eventSeq += 1
      const event = appendCodexRunEvent(runId, eventSeq, payload)
      if (event) {
        onRunEvent({
          taskSlug: runRecord.taskSlug,
          runId,
          event,
        })
        notifyListeners(runId, {
          type: 'event',
          event,
        })
      }
      return event
    }

    const finalizeStoppedRun = (message = '') => {
      if (stopFinalized) {
        return
      }

      stopFinalized = true
      persistRunEvent(createStoppedEnvelopeEvent('执行已手动停止。'))

      const nextRun = updateCodexRun(runId, {
        status: 'stopped',
        ...(message ? { responseMessage: message } : {}),
        errorMessage: '',
        finishedAt: new Date().toISOString(),
      })

      notifyListeners(runId, {
        type: 'run',
        run: nextRun,
      })
      onRunUpdated({
        taskSlug: runRecord.taskSlug,
        runId,
      })
      onSessionChanged({
        sessionId: session.id,
      })
    }

    persistRunEvent(createSessionEnvelopeEvent(decorateSession(session)))

    const stream = runner.streamSessionPrompt(session, runRecord.prompt, {
      onEvent(payload) {
        persistRunEvent(payload)
      },
      onThreadStarted(threadId) {
        const updatedSession = updatePromptxCodexSession(session.id, {
          codexThreadId: threadId,
          engineThreadId: threadId,
        })

        if (updatedSession) {
          persistRunEvent(createSessionUpdatedEnvelopeEvent(decorateSession(updatedSession)))
          onSessionChanged({
            sessionId: session.id,
          })
        }
      },
    })

    const controller = {
      listeners: new Set(),
      cancel() {
        if (stopRequested) {
          return
        }
        stopRequested = true
        stream.cancel()
      },
      get stopRequested() {
        return stopRequested
      },
    }
    setController(runId, controller)

    stream.result
      .then((result) => {
        if (stopRequested) {
          finalizeStoppedRun(result?.message || '')
          return
        }

        const nextRun = updateCodexRun(runId, {
          status: 'completed',
          responseMessage: result.message || '',
          errorMessage: '',
          finishedAt: new Date().toISOString(),
        })
        notifyListeners(runId, {
          type: 'run',
          run: nextRun,
        })
        onRunUpdated({
          taskSlug: runRecord.taskSlug,
          runId,
        })
        onSessionChanged({
          sessionId: session.id,
        })
      })
      .catch((error) => {
        if (stopRequested) {
          finalizeStoppedRun('')
          return
        }

        const nextRun = updateCodexRun(runId, {
          status: 'error',
          errorMessage: error.message || '执行引擎运行失败。',
          finishedAt: new Date().toISOString(),
        })
        notifyListeners(runId, {
          type: 'run',
          run: nextRun,
        })
        onRunUpdated({
          taskSlug: runRecord.taskSlug,
          runId,
        })
        onSessionChanged({
          sessionId: session.id,
        })
      })
      .finally(() => {
        notifyListeners(runId, { type: 'close' })
        clearController(runId)
      })
  }

  return {
    getController,
    subscribe,
    start,
  }
}

export function createCodexRunRuntime(options = {}) {
  return createAgentRunRuntime(options)
}
