import assert from 'node:assert/strict'
import process from 'node:process'
import {
  createRunnerSplitHarness,
  createStats,
  getRun,
  requestJson,
  waitFor,
} from './lib/runnerSplitHarness.mjs'

const STOP_STORM_RUNS = Math.max(1, Number(process.env.PROMPTX_STOP_STORM_RUNS) || 12)
const STOP_FORCE_AFTER_MS = Math.max(200, Number(process.env.PROMPTX_STOP_FORCE_AFTER_MS) || 1500)
const STOP_ACK_P95_BUDGET_MS = Math.max(50, Number(process.env.PROMPTX_STOP_ACK_P95_BUDGET_MS) || 1000)
const STOP_FINAL_P95_BUDGET_MS = Math.max(500, Number(process.env.PROMPTX_STOP_FINAL_P95_BUDGET_MS) || 12000)
const ALLOWED_TIMEOUT_RATE = Math.max(0, Number(process.env.PROMPTX_ALLOWED_STOP_TIMEOUT_RATE) || 0)

function nowMs() {
  return performance.now()
}

async function main() {
  const harness = await createRunnerSplitHarness()
  const resources = []

  try {
    for (let index = 0; index < STOP_STORM_RUNS; index += 1) {
      const task = await requestJson(harness.serverBaseUrl, '/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: `stop-storm-task-${index + 1}`,
          expiry: 'none',
          visibility: 'private',
        }),
      })
      const session = await requestJson(harness.serverBaseUrl, '/api/codex/sessions', {
        method: 'POST',
        body: JSON.stringify({
          title: `stop-storm-session-${index + 1}`,
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
            prompt: `STOP_CASE_${index + 1}`,
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

    const stopIssuedAt = new Map()
    const ackLatencies = []

    await Promise.all(resources.map(async (item) => {
      const startedAt = nowMs()
      stopIssuedAt.set(item.runId, startedAt)
      const response = await requestJson(
        harness.serverBaseUrl,
        `/api/codex/runs/${encodeURIComponent(item.runId)}/stop`,
        {
          method: 'POST',
          body: JSON.stringify({
            forceAfterMs: STOP_FORCE_AFTER_MS,
          }),
        }
      )
      ackLatencies.push(nowMs() - startedAt)
      assert.equal(response?.run?.status, 'stopping')
    }))

    const completionLatencies = []
    const terminalCounts = {
      stopped: 0,
      stop_timeout: 0,
      error: 0,
      other: 0,
    }

    await Promise.all(resources.map((item) => waitFor(
      async () => {
        const run = await getRun(harness.serverBaseUrl, item.taskSlug, item.runId)
        if (!run || ['queued', 'starting', 'running', 'stopping'].includes(run.status)) {
          return null
        }

        completionLatencies.push(nowMs() - (stopIssuedAt.get(item.runId) || nowMs()))
        if (Object.prototype.hasOwnProperty.call(terminalCounts, run.status)) {
          terminalCounts[run.status] += 1
        } else {
          terminalCounts.other += 1
        }
        return run
      },
      15000,
      `run ${item.runId} 没有进入终态`
    )))

    const summary = {
      runs: STOP_STORM_RUNS,
      forceAfterMs: STOP_FORCE_AFTER_MS,
      ack: createStats(ackLatencies),
      completion: createStats(completionLatencies),
      terminalCounts,
    }

    console.log(JSON.stringify(summary, null, 2))

    const timeoutRate = summary.terminalCounts.stop_timeout / STOP_STORM_RUNS
    assert.equal(summary.terminalCounts.error, 0, '不应出现 error 终态')
    assert.equal(summary.terminalCounts.other, 0, '不应出现未知终态')
    assert.ok(summary.ack.p95 <= STOP_ACK_P95_BUDGET_MS, `stop ack p95=${summary.ack.p95.toFixed(1)}ms`)
    assert.ok(summary.completion.p95 <= STOP_FINAL_P95_BUDGET_MS, `stop completion p95=${summary.completion.p95.toFixed(1)}ms`)
    assert.ok(timeoutRate <= ALLOWED_TIMEOUT_RATE, `stop_timeout rate=${(timeoutRate * 100).toFixed(1)}%`)
  } finally {
    await harness.cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
