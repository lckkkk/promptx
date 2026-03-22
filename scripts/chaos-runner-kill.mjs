import assert from 'node:assert/strict'
import process from 'node:process'
import {
  createRunnerSplitHarness,
  createStats,
  getRun,
  getTask,
  killProcessTree,
  requestJson,
  waitFor,
} from './lib/runnerSplitHarness.mjs'

const CHAOS_RUNS = Math.max(1, Number(process.env.PROMPTX_CHAOS_RUNS) || 8)
const TASK_API_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_CHAOS_TASKS_P95_BUDGET_MS) || 400)
const RECOVERY_P95_BUDGET_MS = Math.max(1000, Number(process.env.PROMPTX_CHAOS_RECOVERY_P95_BUDGET_MS) || 12000)

function nowMs() {
  return performance.now()
}

async function main() {
  const harness = await createRunnerSplitHarness({
    serverEnv: {
      PROMPTX_RUNNER_SWEEP_INTERVAL_MS: '500',
      PROMPTX_RUNNER_STALE_THRESHOLD_MS: '1500',
      PROMPTX_RUNNER_RECOVERY_STARTUP_GRACE_MS: '200',
    },
  })
  const resources = []

  try {
    for (let index = 0; index < CHAOS_RUNS; index += 1) {
      const task = await requestJson(harness.serverBaseUrl, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: `chaos-task-${index + 1}`,
          expiry: 'none',
          visibility: 'private',
        }),
      })
      const session = await requestJson(harness.serverBaseUrl, '/api/codex/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: `chaos-session-${index + 1}`,
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
            prompt: `RECOVERY_CASE_${index + 1}`,
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

    const taskApiLatencies = []
    const recoveryStartedAt = nowMs()
    killProcessTree(harness.runnerProcess.pid)

    const recoveredRuns = await Promise.all(resources.map((item) => waitFor(
      async () => {
        const taskStartedAt = nowMs()
        const task = await getTask(harness.serverBaseUrl, item.taskSlug)
        taskApiLatencies.push(nowMs() - taskStartedAt)
        const run = await getRun(harness.serverBaseUrl, item.taskSlug, item.runId)
        if (run && ['error', 'stop_timeout'].includes(run.status) && task && !task.running) {
          return {
            ...run,
            recoveredAfterMs: nowMs() - recoveryStartedAt,
          }
        }
        return null
      },
      15000,
      `run ${item.runId} 在 runner 失联后没有被回收`
    )))

    const recoveryLatencies = recoveredRuns.map((run) => run?.recoveredAfterMs || 0)
    const terminalCounts = recoveredRuns.reduce((accumulator, run) => {
      const key = run?.status || 'missing'
      accumulator[key] = (accumulator[key] || 0) + 1
      return accumulator
    }, {})

    const summary = {
      runs: CHAOS_RUNS,
      tasksApi: createStats(taskApiLatencies),
      recovery: createStats(recoveryLatencies),
      terminalCounts,
    }

    console.log(JSON.stringify(summary, null, 2))

    assert.ok(summary.tasksApi.p95 <= TASK_API_P95_BUDGET_MS, `/api/tasks p95=${summary.tasksApi.p95.toFixed(1)}ms`)
    assert.ok(summary.recovery.p95 <= RECOVERY_P95_BUDGET_MS, `recovery p95=${summary.recovery.p95.toFixed(1)}ms`)
    assert.equal((summary.terminalCounts.error || 0) + (summary.terminalCounts.stop_timeout || 0), CHAOS_RUNS)
  } finally {
    await harness.cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
