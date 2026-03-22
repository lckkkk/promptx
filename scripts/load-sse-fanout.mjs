import assert from 'node:assert/strict'
import process from 'node:process'
import {
  createRunnerSplitHarness,
  createStats,
  getRun,
  requestJson,
  waitFor,
} from './lib/runnerSplitHarness.mjs'

const SSE_CLIENTS = Math.max(1, Number(process.env.PROMPTX_SSE_CLIENTS) || 40)
const BACKGROUND_RUNS = Math.max(1, Number(process.env.PROMPTX_SSE_RUNS) || 10)
const DURATION_MS = Math.max(3000, Number(process.env.PROMPTX_SSE_DURATION_MS) || 10000)
const WORKERS = Math.max(1, Number(process.env.PROMPTX_SSE_API_WORKERS) || 4)
const CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTX_SSE_CONNECT_TIMEOUT_MS) || 5000)
const MIN_EVENTS_PER_CLIENT = Math.max(1, Number(process.env.PROMPTX_SSE_MIN_EVENTS_PER_CLIENT) || 20)
const MAX_DISCONNECT_RATE = Math.max(0, Number(process.env.PROMPTX_SSE_MAX_DISCONNECT_RATE) || 0)
const FIRST_EVENT_P95_BUDGET_MS = Math.max(100, Number(process.env.PROMPTX_SSE_FIRST_EVENT_P95_BUDGET_MS) || 1500)
const TASKS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SSE_TASKS_P95_BUDGET_MS) || 400)
const SESSIONS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SSE_SESSIONS_P95_BUDGET_MS) || 400)
const RUNS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SSE_RUNS_P95_BUDGET_MS) || 500)

function nowMs() {
  return performance.now()
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

function parseSseMessage(block = '') {
  const lines = String(block || '').split(/\r?\n/g)
  let id = ''
  const dataLines = []

  lines.forEach((line) => {
    if (!line || line.startsWith(':')) {
      return
    }
    if (line.startsWith('id:')) {
      id = line.slice(3).trim()
      return
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim())
    }
  })

  if (!dataLines.length) {
    return null
  }

  return {
    id,
    payload: JSON.parse(dataLines.join('\n')),
  }
}

function connectSseClient(baseUrl, workloadState) {
  const controller = new AbortController()
  const readyDeferred = createDeferred()
  const decoder = new TextDecoder()
  const state = {
    connected: false,
    ready: false,
    readyAt: 0,
    messageCount: 0,
    nonReadyCount: 0,
    runEventCount: 0,
    runsChangedCount: 0,
    sessionsChangedCount: 0,
    tasksChangedCount: 0,
    firstNonReadyAt: null,
    lastEventId: '',
    unexpectedDisconnect: false,
    errors: [],
  }

  const finished = (async () => {
    let reader = null
    let abortRequested = false
    try {
      const response = await fetch(`${baseUrl}/api/events/stream`, {
        headers: {
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        throw new Error(`SSE connect failed: ${response.status} ${response.statusText}`)
      }

      state.connected = true
      reader = response.body.getReader()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          if (!abortRequested) {
            state.unexpectedDisconnect = true
          }
          break
        }

        buffer += decoder.decode(value, { stream: true })
        const blocks = buffer.split(/\r?\n\r?\n/g)
        buffer = blocks.pop() || ''

        blocks.forEach((block) => {
          const message = parseSseMessage(block)
          if (!message) {
            return
          }

          const payload = message.payload || {}
          state.lastEventId = message.id || state.lastEventId
          state.messageCount += 1
          if (payload.type === 'ready') {
            if (!state.ready) {
              state.ready = true
              state.readyAt = nowMs()
              readyDeferred.resolve(state)
            }
            return
          }

          state.nonReadyCount += 1
          if (payload.type === 'run.event') {
            state.runEventCount += 1
          } else if (payload.type === 'runs.changed') {
            state.runsChangedCount += 1
          } else if (payload.type === 'sessions.changed') {
            state.sessionsChangedCount += 1
          } else if (payload.type === 'tasks.changed') {
            state.tasksChangedCount += 1
          }

          if (state.firstNonReadyAt == null && workloadState.startedAt > 0) {
            state.firstNonReadyAt = nowMs()
          }
        })
      }

      if (!state.ready) {
        readyDeferred.reject(new Error('SSE ready event missing'))
      }
    } catch (error) {
      if (error?.name === 'AbortError') {
        abortRequested = true
        if (!state.ready) {
          readyDeferred.reject(new Error('SSE connect aborted before ready'))
        }
        return
      }

      state.errors.push(error?.message || String(error))
      if (!state.ready) {
        readyDeferred.reject(error)
      }
    } finally {
      try {
        reader?.releaseLock?.()
      } catch {
        // Ignore reader release errors during shutdown.
      }
    }
  })()

  return {
    state,
    ready: readyDeferred.promise,
    finished,
    close() {
      controller.abort()
    },
  }
}

async function main() {
  const harness = await createRunnerSplitHarness()
  const resources = []
  const workloadState = {
    startedAt: 0,
  }

  try {
    const clients = Array.from({ length: SSE_CLIENTS }, () => connectSseClient(harness.serverBaseUrl, workloadState))
    await Promise.all(clients.map((client) => Promise.race([
      client.ready,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('SSE connect timeout')), CONNECT_TIMEOUT_MS)
      }),
    ])))

    workloadState.startedAt = nowMs()

    for (let index = 0; index < BACKGROUND_RUNS; index += 1) {
      const task = await requestJson(harness.serverBaseUrl, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: `sse-fanout-task-${index + 1}`,
          expiry: 'none',
          visibility: 'private',
        }),
      })
      const session = await requestJson(harness.serverBaseUrl, '/api/codex/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: `sse-fanout-session-${index + 1}`,
          cwd: harness.tempRoot,
          engine: 'codex',
        }),
      })
      const runPayload = await requestJson(
        harness.serverBaseUrl,
        `/api/tasks/${encodeURIComponent(task.slug)}/codex-runs`,
        {
          method: 'POST',
          body: JSON.stringify({
            sessionId: session.id,
            prompt: `LONG_CASE_${index + 1}`,
          }),
        }
      )

      resources.push({
        taskSlug: task.slug,
        runId: runPayload?.run?.id || '',
      })
    }

    await Promise.all(resources.map((item) => waitFor(
      async () => {
        const run = await getRun(harness.serverBaseUrl, item.taskSlug, item.runId)
        return run && ['starting', 'running'].includes(run.status) ? run : null
      },
      10000,
      `run ${item.runId} did not become active`
    )))

    const endpointMetrics = {
      tasks: [],
      sessions: [],
      runs: [],
    }
    const requestErrors = []
    const deadline = Date.now() + DURATION_MS

    async function hitEndpoint(kind) {
      const startedAt = nowMs()
      try {
        if (kind === 'tasks') {
          await requestJson(harness.serverBaseUrl, '/api/tasks')
        } else if (kind === 'sessions') {
          await requestJson(harness.serverBaseUrl, '/api/codex/sessions')
        } else {
          const target = resources[Math.floor(Math.random() * resources.length)]
          await requestJson(
            harness.serverBaseUrl,
            `/api/tasks/${encodeURIComponent(target.taskSlug)}/codex-runs?limit=20`
          )
        }
        endpointMetrics[kind].push(nowMs() - startedAt)
      } catch (error) {
        requestErrors.push({
          kind,
          message: error?.message || String(error),
        })
      }
    }

    await Promise.all(Array.from({ length: WORKERS }, (_, workerIndex) => (async () => {
      const kinds = ['tasks', 'sessions', 'runs']
      let cursor = workerIndex % kinds.length
      while (Date.now() < deadline) {
        const kind = kinds[cursor % kinds.length]
        cursor += 1
        await hitEndpoint(kind)
      }
    })()))

    await Promise.all(resources.map((item) => requestJson(
      harness.serverBaseUrl,
      `/api/codex/runs/${encodeURIComponent(item.runId)}/stop`,
      {
        method: 'POST',
        body: JSON.stringify({
          forceAfterMs: 1500,
        }),
      }
    )))

    const terminalRuns = await Promise.all(resources.map((item) => waitFor(
      async () => {
        const run = await getRun(harness.serverBaseUrl, item.taskSlug, item.runId)
        if (!run || ['queued', 'starting', 'running', 'stopping'].includes(run.status)) {
          return null
        }
        return run
      },
      15000,
      `run ${item.runId} did not finish`
    )))

    clients.forEach((client) => client.close())
    await Promise.all(clients.map((client) => client.finished.catch(() => {})))

    const clientStates = clients.map((client) => client.state)
    const unexpectedDisconnects = clientStates.filter((state) => state.unexpectedDisconnect).length
    const clientErrors = clientStates.flatMap((state) => state.errors)
    const firstEventLatencies = clientStates
      .map((state) => (state.firstNonReadyAt == null ? null : state.firstNonReadyAt - workloadState.startedAt))
      .filter((value) => value != null)
    const nonReadyCounts = clientStates.map((state) => state.nonReadyCount)
    const messageCounts = clientStates.map((state) => state.messageCount)
    const runEventCounts = clientStates.map((state) => state.runEventCount)
    const terminalCounts = terminalRuns.reduce((accumulator, run) => {
      const key = run?.status || 'missing'
      accumulator[key] = (accumulator[key] || 0) + 1
      return accumulator
    }, {})

    const summary = {
      clients: SSE_CLIENTS,
      backgroundRuns: BACKGROUND_RUNS,
      durationMs: DURATION_MS,
      workers: WORKERS,
      clientErrors,
      disconnects: {
        unexpected: unexpectedDisconnects,
        rate: unexpectedDisconnects / SSE_CLIENTS,
      },
      readyClients: clientStates.filter((state) => state.ready).length,
      messages: createStats(messageCounts),
      nonReadyMessages: createStats(nonReadyCounts),
      runEvents: createStats(runEventCounts),
      firstEventLatencyMs: createStats(firstEventLatencies),
      tasks: createStats(endpointMetrics.tasks),
      sessions: createStats(endpointMetrics.sessions),
      runs: createStats(endpointMetrics.runs),
      requestErrors,
      terminalCounts,
    }

    console.log(JSON.stringify(summary, null, 2))

    const minNonReady = Math.min(...nonReadyCounts)
    assert.equal(summary.readyClients, SSE_CLIENTS, 'not all SSE clients became ready')
    assert.equal(clientErrors.length, 0, `SSE client errors: ${clientErrors.join('; ')}`)
    assert.equal(requestErrors.length, 0, `request errors: ${requestErrors.length}`)
    assert.ok(summary.disconnects.rate <= MAX_DISCONNECT_RATE, `disconnect rate=${(summary.disconnects.rate * 100).toFixed(1)}%`)
    assert.ok(summary.firstEventLatencyMs.p95 <= FIRST_EVENT_P95_BUDGET_MS, `SSE first event p95=${summary.firstEventLatencyMs.p95.toFixed(1)}ms`)
    assert.ok(minNonReady >= MIN_EVENTS_PER_CLIENT, `min SSE events per client=${minNonReady}`)
    assert.ok(summary.tasks.p95 <= TASKS_P95_BUDGET_MS, `/api/tasks p95=${summary.tasks.p95.toFixed(1)}ms`)
    assert.ok(summary.sessions.p95 <= SESSIONS_P95_BUDGET_MS, `/api/codex/sessions p95=${summary.sessions.p95.toFixed(1)}ms`)
    assert.ok(summary.runs.p95 <= RUNS_P95_BUDGET_MS, `/api/tasks/:slug/codex-runs p95=${summary.runs.p95.toFixed(1)}ms`)
    assert.equal(summary.terminalCounts.error || 0, 0, 'terminal error runs should be zero')
    assert.equal(summary.terminalCounts.stop_timeout || 0, 0, 'terminal stop_timeout runs should be zero')
  } finally {
    await harness.cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
