import assert from 'node:assert/strict'
import process from 'node:process'
import {
  createRunnerSplitHarness,
  createStats,
  getProcessRssMb,
  getRun,
  requestJson,
  sleep,
  waitFor,
} from './lib/runnerSplitHarness.mjs'

const DURATION_MS = Math.max(10000, Number(process.env.PROMPTX_SOAK_DURATION_MS) || 300000)
const MAX_ACTIVE_RUNS = Math.max(1, Number(process.env.PROMPTX_SOAK_MAX_ACTIVE_RUNS) || 10)
const CREATE_INTERVAL_MS = Math.max(100, Number(process.env.PROMPTX_SOAK_CREATE_INTERVAL_MS) || 1200)
const SAMPLE_INTERVAL_MS = Math.max(200, Number(process.env.PROMPTX_SOAK_SAMPLE_INTERVAL_MS) || 1000)
const STOP_PROBABILITY = Math.min(1, Math.max(0, Number(process.env.PROMPTX_SOAK_STOP_PROBABILITY) || 0.35))
const MIN_RUN_AGE_BEFORE_STOP_MS = Math.max(500, Number(process.env.PROMPTX_SOAK_MIN_RUN_AGE_BEFORE_STOP_MS) || 3000)
const ENABLE_RUNNER_RESTART = String(process.env.PROMPTX_SOAK_RESTART_RUNNER || '1') !== '0'
const RUNNER_KILL_AT_MS = ENABLE_RUNNER_RESTART
  ? Math.max(1000, Number(process.env.PROMPTX_SOAK_KILL_AT_MS) || Math.floor(DURATION_MS / 2))
  : -1
const TASKS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SOAK_TASKS_P95_BUDGET_MS) || 500)
const SESSIONS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SOAK_SESSIONS_P95_BUDGET_MS) || 500)
const RUNS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SOAK_RUNS_P95_BUDGET_MS) || 700)
const STOP_ACK_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SOAK_STOP_ACK_P95_BUDGET_MS) || 1200)
const MAX_REQUEST_ERRORS = Math.max(0, Number(process.env.PROMPTX_SOAK_MAX_REQUEST_ERRORS) || 0)
const MAX_OPERATION_ERRORS = Math.max(0, Number(process.env.PROMPTX_SOAK_MAX_OPERATION_ERRORS) || 0)
const ALLOWED_STOP_TIMEOUT_RATE = Math.max(0, Number(process.env.PROMPTX_SOAK_ALLOWED_STOP_TIMEOUT_RATE) || 0.1)
const REQUIRE_POST_RESTART_RUNS = ENABLE_RUNNER_RESTART && String(process.env.PROMPTX_SOAK_REQUIRE_POST_RESTART_RUNS || '1') !== '0'

function nowMs() {
  return performance.now()
}

function isTerminalStatus(status = '') {
  return ['completed', 'stopped', 'error', 'interrupted', 'stop_timeout'].includes(status)
}

async function main() {
  const harness = await createRunnerSplitHarness({
    serverEnv: {
      PROMPTX_RUNNER_SWEEP_INTERVAL_MS: '500',
      PROMPTX_RUNNER_STALE_THRESHOLD_MS: '1500',
      PROMPTX_RUNNER_RECOVERY_STARTUP_GRACE_MS: '200',
    },
  })

  const resources = new Map()
  const requestErrors = []
  const operationErrors = []
  const endpointMetrics = {
    tasks: [],
    sessions: [],
    runs: [],
  }
  const stopAckLatencies = []
  const serverRssSamples = []
  const runnerRssSamples = []
  let createCursor = 0
  let lastCreateAt = 0
  let runnerAvailable = true
  let restartTriggered = false
  let restartRecoveredCount = 0
  let createdAfterRestart = 0
  let runnerRestartStartedAt = 0
  let runnerRestartCompletedAt = 0

  async function createRun() {
    createCursor += 1
    const task = await requestJson(harness.serverBaseUrl, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: `soak-task-${createCursor}`,
        expiry: 'none',
        visibility: 'private',
      }),
    })
    const session = await requestJson(harness.serverBaseUrl, '/api/codex/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: `soak-session-${createCursor}`,
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
          prompt: `LONG_CASE_${createCursor}`,
        }),
      }
    )

    const resource = {
      taskSlug: task.slug,
      sessionId: session.id,
      runId: runPayload?.run?.id || '',
      createdAt: Date.now(),
      createdAfterRestart: restartTriggered,
      stopRequested: false,
      status: runPayload?.run?.status || 'queued',
      lastObservedAt: Date.now(),
    }

    resources.set(resource.runId, resource)

    await waitFor(
      async () => {
        const run = await getRun(harness.serverBaseUrl, resource.taskSlug, resource.runId)
        if (!run) {
          return null
        }
        resource.status = run.status
        resource.lastObservedAt = Date.now()
        return ['starting', 'running'].includes(run.status) ? run : null
      },
      10000,
      `run ${resource.runId} did not become active`
    )

    if (resource.createdAfterRestart) {
      createdAfterRestart += 1
    }

    return resource
  }

  async function refreshRunStates(targetResources = [...resources.values()]) {
    await Promise.all(targetResources.map(async (resource) => {
      if (!resource?.runId || isTerminalStatus(resource.status)) {
        return
      }
      try {
        const run = await getRun(harness.serverBaseUrl, resource.taskSlug, resource.runId)
        if (!run) {
          return
        }
        resource.status = run.status
        resource.lastObservedAt = Date.now()
      } catch (error) {
        requestErrors.push({
          kind: 'poll-run',
          message: error?.message || String(error),
          runId: resource.runId,
        })
      }
    }))
  }

  async function hitEndpoint(kind) {
    const startedAt = nowMs()
    try {
      if (kind === 'tasks') {
        await requestJson(harness.serverBaseUrl, '/api/tasks')
      } else if (kind === 'sessions') {
        await requestJson(harness.serverBaseUrl, '/api/codex/sessions')
      } else {
        const allResources = [...resources.values()]
        if (!allResources.length) {
          return
        }
        const target = allResources[Math.floor(Math.random() * allResources.length)]
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

  async function maybeStopRandomRuns() {
    const activeRuns = [...resources.values()].filter((resource) => ['starting', 'running'].includes(resource.status) && !resource.stopRequested)
    for (const resource of activeRuns) {
      if (Date.now() - resource.createdAt < MIN_RUN_AGE_BEFORE_STOP_MS) {
        continue
      }
      if (Math.random() > STOP_PROBABILITY) {
        continue
      }

      const startedAt = nowMs()
      try {
        const response = await requestJson(
          harness.serverBaseUrl,
          `/api/codex/runs/${encodeURIComponent(resource.runId)}/stop`,
          {
            method: 'POST',
            body: JSON.stringify({
              forceAfterMs: 1500,
            }),
          }
        )
        stopAckLatencies.push(nowMs() - startedAt)
        resource.stopRequested = true
        resource.status = response?.run?.status || resource.status
        resource.lastObservedAt = Date.now()
      } catch (error) {
        operationErrors.push({
          kind: 'stop-run',
          runId: resource.runId,
          message: error?.message || String(error),
        })
      }
    }
  }

  async function restartRunnerFlow() {
    runnerAvailable = false
    restartTriggered = true
    runnerRestartStartedAt = Date.now()
    const impactedRuns = [...resources.values()].filter((resource) => ['starting', 'running', 'stopping'].includes(resource.status))

    await harness.stopRunner()

    await Promise.all(impactedRuns.map((resource) => waitFor(
      async () => {
        const run = await getRun(harness.serverBaseUrl, resource.taskSlug, resource.runId)
        if (!run || !isTerminalStatus(run.status)) {
          return null
        }
        resource.status = run.status
        resource.lastObservedAt = Date.now()
        return run
      },
      15000,
      `run ${resource.runId} did not recover after runner stop`
    )))

    restartRecoveredCount = impactedRuns.filter((resource) => ['error', 'stop_timeout'].includes(resource.status)).length
    await harness.restartRunner()
    runnerRestartCompletedAt = Date.now()
    runnerAvailable = true
  }

  try {
    const startedAt = Date.now()
    while (Date.now() - startedAt < DURATION_MS) {
      await refreshRunStates()

      const elapsedMs = Date.now() - startedAt
      if (
        ENABLE_RUNNER_RESTART
        && !restartTriggered
        && elapsedMs >= RUNNER_KILL_AT_MS
      ) {
        await restartRunnerFlow()
      }

      if (runnerAvailable) {
        const activeCount = [...resources.values()].filter((resource) => ['queued', 'starting', 'running', 'stopping'].includes(resource.status)).length
        if (activeCount < MAX_ACTIVE_RUNS && Date.now() - lastCreateAt >= CREATE_INTERVAL_MS) {
          try {
            await createRun()
            lastCreateAt = Date.now()
          } catch (error) {
            operationErrors.push({
              kind: 'create-run',
              message: error?.message || String(error),
            })
          }
        }

        await maybeStopRandomRuns()
      }

      await Promise.all([
        hitEndpoint('tasks'),
        hitEndpoint('sessions'),
        hitEndpoint('runs'),
      ])

      const serverRssMb = getProcessRssMb(harness.serverProcess?.pid)
      if (serverRssMb > 0) {
        serverRssSamples.push(serverRssMb)
      }
      const runnerRssMb = getProcessRssMb(harness.runnerProcess?.pid)
      if (runnerRssMb > 0) {
        runnerRssSamples.push(runnerRssMb)
      }

      await sleep(SAMPLE_INTERVAL_MS)
    }

    if (ENABLE_RUNNER_RESTART && !runnerAvailable) {
      await harness.restartRunner()
      runnerAvailable = true
      runnerRestartCompletedAt = Date.now()
    }

    await refreshRunStates()

    const remainingActiveRuns = [...resources.values()].filter((resource) => ['queued', 'starting', 'running'].includes(resource.status))
    await Promise.all(remainingActiveRuns.map(async (resource) => {
      try {
        const response = await requestJson(
          harness.serverBaseUrl,
          `/api/codex/runs/${encodeURIComponent(resource.runId)}/stop`,
          {
            method: 'POST',
            body: JSON.stringify({
              forceAfterMs: 1500,
            }),
          }
        )
        resource.stopRequested = true
        resource.status = response?.run?.status || resource.status
      } catch (error) {
        operationErrors.push({
          kind: 'drain-stop',
          runId: resource.runId,
          message: error?.message || String(error),
        })
      }
    }))

    await Promise.all([...resources.values()].map((resource) => waitFor(
      async () => {
        const run = await getRun(harness.serverBaseUrl, resource.taskSlug, resource.runId)
        if (!run || !isTerminalStatus(run.status)) {
          return null
        }
        resource.status = run.status
        resource.lastObservedAt = Date.now()
        return run
      },
      15000,
      `run ${resource.runId} did not finish during drain`
    )))

    const terminalCounts = [...resources.values()].reduce((accumulator, resource) => {
      const key = resource.status || 'missing'
      accumulator[key] = (accumulator[key] || 0) + 1
      return accumulator
    }, {})
    const stuckActiveRuns = [...resources.values()].filter((resource) => !isTerminalStatus(resource.status)).length
    const summary = {
      durationMs: DURATION_MS,
      maxActiveRuns: MAX_ACTIVE_RUNS,
      createIntervalMs: CREATE_INTERVAL_MS,
      sampleIntervalMs: SAMPLE_INTERVAL_MS,
      stopProbability: STOP_PROBABILITY,
      runsCreated: resources.size,
      createdAfterRestart,
      restart: {
        enabled: ENABLE_RUNNER_RESTART,
        triggered: restartTriggered,
        killAtMs: RUNNER_KILL_AT_MS,
        recoveredRuns: restartRecoveredCount,
        downtimeMs: runnerRestartCompletedAt > runnerRestartStartedAt
          ? runnerRestartCompletedAt - runnerRestartStartedAt
          : 0,
      },
      tasks: createStats(endpointMetrics.tasks),
      sessions: createStats(endpointMetrics.sessions),
      runs: createStats(endpointMetrics.runs),
      stopAck: createStats(stopAckLatencies),
      rssMb: {
        server: createStats(serverRssSamples),
        runner: createStats(runnerRssSamples),
      },
      requestErrors,
      operationErrors,
      stuckActiveRuns,
      terminalCounts,
    }

    console.log(JSON.stringify(summary, null, 2))

    const timeoutRate = (summary.terminalCounts.stop_timeout || 0) / Math.max(1, resources.size)
    assert.ok(resources.size > 0, 'soak test did not create any runs')
    assert.ok(summary.tasks.p95 <= TASKS_P95_BUDGET_MS, `/api/tasks p95=${summary.tasks.p95.toFixed(1)}ms`)
    assert.ok(summary.sessions.p95 <= SESSIONS_P95_BUDGET_MS, `/api/codex/sessions p95=${summary.sessions.p95.toFixed(1)}ms`)
    assert.ok(summary.runs.p95 <= RUNS_P95_BUDGET_MS, `/api/tasks/:slug/codex-runs p95=${summary.runs.p95.toFixed(1)}ms`)
    assert.ok(summary.stopAck.p95 <= STOP_ACK_P95_BUDGET_MS, `stop ack p95=${summary.stopAck.p95.toFixed(1)}ms`)
    assert.ok(requestErrors.length <= MAX_REQUEST_ERRORS, `request errors=${requestErrors.length}`)
    assert.ok(operationErrors.length <= MAX_OPERATION_ERRORS, `operation errors=${operationErrors.length}`)
    assert.equal(stuckActiveRuns, 0, 'stuck active runs should be zero')
    assert.ok(timeoutRate <= ALLOWED_STOP_TIMEOUT_RATE, `stop_timeout rate=${(timeoutRate * 100).toFixed(1)}%`)
    if (REQUIRE_POST_RESTART_RUNS) {
      assert.ok(createdAfterRestart > 0, 'runner restart happened but no new run was created afterwards')
    }
  } finally {
    await harness.cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
