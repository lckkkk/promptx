import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

const PROFILE = String(process.env.PROMPTX_PERF_PROFILE || 'default').trim().toLowerCase() || 'default'
const REPORT_PATH = String(process.env.PROMPTX_PERF_REPORT_PATH || '').trim()

function nowMs() {
  return performance.now()
}

function pickProfile(profile) {
  if (profile === 'nightly') {
    return {
      smoke: {},
      controlPlane: {
        PROMPTX_LOAD_RUNS: '16',
        PROMPTX_LOAD_DURATION_MS: '12000',
        PROMPTX_LOAD_WORKERS: '10',
      },
      sseFanout: {
        PROMPTX_SSE_CLIENTS: '120',
        PROMPTX_SSE_RUNS: '18',
        PROMPTX_SSE_DURATION_MS: '15000',
        PROMPTX_SSE_API_WORKERS: '8',
        PROMPTX_SSE_MIN_EVENTS_PER_CLIENT: '24',
      },
      stopStorm: {
        PROMPTX_STOP_STORM_RUNS: '24',
      },
      chaos: {
        PROMPTX_CHAOS_RUNS: '12',
      },
      soak: {
        PROMPTX_SOAK_DURATION_MS: '240000',
        PROMPTX_SOAK_MAX_ACTIVE_RUNS: '12',
        PROMPTX_SOAK_CREATE_INTERVAL_MS: '900',
        PROMPTX_SOAK_STOP_PROBABILITY: '0.4',
      },
    }
  }

  return {
    smoke: {},
    controlPlane: {
      PROMPTX_LOAD_RUNS: '12',
      PROMPTX_LOAD_DURATION_MS: '10000',
      PROMPTX_LOAD_WORKERS: '8',
    },
    sseFanout: {
      PROMPTX_SSE_CLIENTS: '80',
      PROMPTX_SSE_RUNS: '12',
      PROMPTX_SSE_DURATION_MS: '12000',
      PROMPTX_SSE_API_WORKERS: '6',
      PROMPTX_SSE_MIN_EVENTS_PER_CLIENT: '20',
    },
    stopStorm: {
      PROMPTX_STOP_STORM_RUNS: '20',
    },
    chaos: {
      PROMPTX_CHAOS_RUNS: '10',
    },
    soak: {
      PROMPTX_SOAK_DURATION_MS: '180000',
      PROMPTX_SOAK_MAX_ACTIVE_RUNS: '10',
      PROMPTX_SOAK_CREATE_INTERVAL_MS: '1000',
      PROMPTX_SOAK_STOP_PROBABILITY: '0.35',
    },
  }
}

function createScenarioMatrix(profileEnv) {
  return [
    {
      name: 'smoke',
      script: 'scripts/smoke-runner-split.mjs',
      env: profileEnv.smoke,
      timeoutMs: 60000,
    },
    {
      name: 'control-plane',
      script: 'scripts/load-control-plane.mjs',
      env: profileEnv.controlPlane,
      timeoutMs: 90000,
    },
    {
      name: 'sse-fanout',
      script: 'scripts/load-sse-fanout.mjs',
      env: profileEnv.sseFanout,
      timeoutMs: 120000,
    },
    {
      name: 'stop-storm',
      script: 'scripts/load-stop-storm.mjs',
      env: profileEnv.stopStorm,
      timeoutMs: 90000,
    },
    {
      name: 'chaos-runner-kill',
      script: 'scripts/chaos-runner-kill.mjs',
      env: profileEnv.chaos,
      timeoutMs: 90000,
    },
    {
      name: 'soak-runner-split',
      script: 'scripts/soak-runner-split.mjs',
      env: profileEnv.soak,
      timeoutMs: Math.max(120000, Number(profileEnv.soak?.PROMPTX_SOAK_DURATION_MS || 0) + 120000),
    },
  ]
}

function trimTail(text = '', maxLength = 4000) {
  const value = String(text || '')
  if (value.length <= maxLength) {
    return value
  }
  return value.slice(value.length - maxLength)
}

function extractLastJsonObject(text = '') {
  const source = String(text || '').trim()
  if (!source) {
    return null
  }

  for (let index = source.lastIndexOf('{'); index >= 0; index = source.lastIndexOf('{', index - 1)) {
    const candidate = source.slice(index).trim()
    try {
      return JSON.parse(candidate)
    } catch {
      // Keep scanning backwards until a valid JSON block is found.
    }
  }

  return null
}

function summarizeMetrics(name, payload = {}) {
  if (!payload || typeof payload !== 'object') {
    return {}
  }

  if (name === 'smoke') {
    return {
      stopStatus: payload?.stopRun?.status || '',
      recoveryStatus: payload?.recoveryRun?.status || '',
      recoveryEventCount: Number(payload?.recoveryRun?.eventCount || 0),
    }
  }

  if (name === 'control-plane') {
    return {
      backgroundRuns: Number(payload.backgroundRuns || 0),
      tasksP95Ms: Number(payload?.tasks?.p95 || 0),
      sessionsP95Ms: Number(payload?.sessions?.p95 || 0),
      runsP95Ms: Number(payload?.runs?.p95 || 0),
      errors: Array.isArray(payload.errors) ? payload.errors.length : 0,
    }
  }

  if (name === 'sse-fanout') {
    return {
      clients: Number(payload.clients || 0),
      readyClients: Number(payload.readyClients || 0),
      disconnectRate: Number(payload?.disconnects?.rate || 0),
      firstEventP95Ms: Number(payload?.firstEventLatencyMs?.p95 || 0),
      minClientEvents: Number(payload?.nonReadyMessages?.min || 0),
      tasksP95Ms: Number(payload?.tasks?.p95 || 0),
      runsP95Ms: Number(payload?.runs?.p95 || 0),
    }
  }

  if (name === 'stop-storm') {
    return {
      runs: Number(payload.runs || 0),
      ackP95Ms: Number(payload?.ack?.p95 || 0),
      completionP95Ms: Number(payload?.completion?.p95 || 0),
      stopped: Number(payload?.terminalCounts?.stopped || 0),
      stopTimeout: Number(payload?.terminalCounts?.stop_timeout || 0),
    }
  }

  if (name === 'chaos-runner-kill') {
    return {
      runs: Number(payload.runs || 0),
      tasksP95Ms: Number(payload?.tasksApi?.p95 || 0),
      recoveryP95Ms: Number(payload?.recovery?.p95 || 0),
      errorRuns: Number(payload?.terminalCounts?.error || 0),
      stopTimeoutRuns: Number(payload?.terminalCounts?.stop_timeout || 0),
    }
  }

  if (name === 'soak-runner-split') {
    return {
      runsCreated: Number(payload.runsCreated || 0),
      createdAfterRestart: Number(payload.createdAfterRestart || 0),
      tasksP95Ms: Number(payload?.tasks?.p95 || 0),
      sessionsP95Ms: Number(payload?.sessions?.p95 || 0),
      runsP95Ms: Number(payload?.runs?.p95 || 0),
      stopAckP95Ms: Number(payload?.stopAck?.p95 || 0),
      stuckActiveRuns: Number(payload?.stuckActiveRuns || 0),
      requestErrors: Array.isArray(payload.requestErrors) ? payload.requestErrors.length : 0,
      operationErrors: Array.isArray(payload.operationErrors) ? payload.operationErrors.length : 0,
      stopTimeoutRuns: Number(payload?.terminalCounts?.stop_timeout || 0),
    }
  }

  return {}
}

async function runScenario(scenario) {
  const startedAt = nowMs()
  const scriptPath = path.join(process.cwd(), scenario.script)

  return new Promise((resolve) => {
    const stdoutChunks = []
    const stderrChunks = []
    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      windowsHide: true,
      env: {
        ...process.env,
        ...scenario.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let timeout = null
    if (scenario.timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill('SIGTERM')
      }, scenario.timeoutMs)
      timeout.unref?.()
    }

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(chunk.toString())
    })
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(chunk.toString())
    })

    child.on('close', (code, signal) => {
      if (timeout) {
        clearTimeout(timeout)
      }

      const stdout = stdoutChunks.join('')
      const stderr = stderrChunks.join('')
      const payload = extractLastJsonObject(stdout)
      const durationMs = nowMs() - startedAt
      const status = code === 0 ? 'passed' : 'failed'

      resolve({
        name: scenario.name,
        script: scenario.script,
        env: scenario.env,
        status,
        exitCode: code ?? null,
        signal: signal || '',
        durationMs,
        metrics: summarizeMetrics(scenario.name, payload),
        payload,
        stdoutTail: trimTail(stdout),
        stderrTail: trimTail(stderr),
      })
    })
  })
}

async function main() {
  const profileEnv = pickProfile(PROFILE)
  const scenarios = createScenarioMatrix(profileEnv)
  const results = []
  const startedAt = new Date().toISOString()

  for (const scenario of scenarios) {
    const result = await runScenario(scenario)
    results.push(result)
    console.log(JSON.stringify({
      type: 'scenario.completed',
      profile: PROFILE,
      name: result.name,
      status: result.status,
      durationMs: result.durationMs,
      metrics: result.metrics,
    }, null, 2))

    if (result.status !== 'passed') {
      break
    }
  }

  const failed = results.find((item) => item.status !== 'passed')
  const summary = {
    profile: PROFILE,
    startedAt,
    finishedAt: new Date().toISOString(),
    scenarios: results.map((item) => ({
      name: item.name,
      script: item.script,
      env: item.env,
      status: item.status,
      durationMs: item.durationMs,
      exitCode: item.exitCode,
      signal: item.signal,
      metrics: item.metrics,
      stdoutTail: item.status === 'passed' ? '' : item.stdoutTail,
      stderrTail: item.status === 'passed' ? '' : item.stderrTail,
    })),
  }

  if (REPORT_PATH) {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true })
    fs.writeFileSync(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`)
  }

  console.log(JSON.stringify(summary, null, 2))
  assert.ok(!failed, `${failed?.name || 'unknown'} failed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
