import assert from 'node:assert/strict'
import process from 'node:process'
import {
  createRunnerSplitHarness,
  createStats,
  getRun,
  requestJson,
  waitFor,
} from './lib/runnerSplitHarness.mjs'

const BACKGROUND_RUNS = Math.max(1, Number(process.env.PROMPTX_LOAD_RUNS) || 8)
const DURATION_MS = Math.max(2000, Number(process.env.PROMPTX_LOAD_DURATION_MS) || 8000)
const WORKERS = Math.max(1, Number(process.env.PROMPTX_LOAD_WORKERS) || 6)
const TASKS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_TASKS_P95_BUDGET_MS) || 300)
const SESSIONS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_SESSIONS_P95_BUDGET_MS) || 300)
const RUNS_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_RUNS_P95_BUDGET_MS) || 500)

function nowMs() {
  return performance.now()
}

async function main() {
  const harness = await createRunnerSplitHarness()
  const resources = []

  try {
    for (let index = 0; index < BACKGROUND_RUNS; index += 1) {
      const task = await requestJson(harness.serverBaseUrl, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: `control-plane-load-${index + 1}`,
          expiry: 'none',
          visibility: 'private',
        }),
      })
      const session = await requestJson(harness.serverBaseUrl, '/api/codex/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: `control-plane-session-${index + 1}`,
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
        sessionId: session.id,
        runId: runPayload?.run?.id || '',
      })
    }

    await Promise.all(resources.map((item) => waitFor(
      async () => {
        const run = await getRun(harness.serverBaseUrl, item.taskSlug, item.runId)
        return run && ['starting', 'running'].includes(run.status) ? run : null
      },
      10000,
      `run ${item.runId} 没有进入活跃状态`
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
          message: error.message || String(error),
        })
      }
    }

    const workers = Array.from({ length: WORKERS }, (_, workerIndex) => (async () => {
      const kinds = ['tasks', 'sessions', 'runs']
      let cursor = workerIndex % kinds.length
      while (Date.now() < deadline) {
        const kind = kinds[cursor % kinds.length]
        cursor += 1
        await hitEndpoint(kind)
      }
    })())

    await Promise.all(workers)

    const summary = {
      backgroundRuns: BACKGROUND_RUNS,
      durationMs: DURATION_MS,
      workers: WORKERS,
      errors: requestErrors,
      tasks: createStats(endpointMetrics.tasks),
      sessions: createStats(endpointMetrics.sessions),
      runs: createStats(endpointMetrics.runs),
    }

    console.log(JSON.stringify(summary, null, 2))

    assert.equal(requestErrors.length, 0, `出现 ${requestErrors.length} 个请求错误`)
    assert.ok(summary.tasks.p95 <= TASKS_P95_BUDGET_MS, `/api/tasks p95=${summary.tasks.p95.toFixed(1)}ms`)
    assert.ok(summary.sessions.p95 <= SESSIONS_P95_BUDGET_MS, `/api/codex/sessions p95=${summary.sessions.p95.toFixed(1)}ms`)
    assert.ok(summary.runs.p95 <= RUNS_P95_BUDGET_MS, `/api/tasks/:slug/codex-runs p95=${summary.runs.p95.toFixed(1)}ms`)
  } finally {
    await harness.cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
