import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'

const HOST = '127.0.0.1'
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function createFakeCodexBinary(tempDir) {
  const scriptPath = path.join(tempDir, process.platform === 'win32' ? 'fake-codex.js' : 'fake-codex')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')

const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output-last-message')
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''
const resumeIndex = args.indexOf('resume')
const resumeTarget = resumeIndex >= 0 ? args[resumeIndex + 1] || '' : ''
const threadId = resumeTarget || 'thread-smoke-1'

let prompt = ''
let heartbeatTimer = null

function cleanupAndExit(code = 0) {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  process.exit(code)
}

process.on('SIGTERM', () => cleanupAndExit(0))
process.on('SIGINT', () => cleanupAndExit(0))

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  prompt += chunk
})
process.stdin.on('end', () => {
  const mode = prompt.includes('RECOVERY_CASE') ? 'recovery' : prompt.includes('STOP_CASE') ? 'stop' : 'complete'

  if (mode === 'complete') {
    if (outputFile) {
      fs.writeFileSync(outputFile, 'SMOKE_OK')
    }
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')
    process.stdout.write(JSON.stringify({ type: 'turn.completed', result: 'SMOKE_OK' }) + '\\n')
    cleanupAndExit(0)
    return
  }

  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')
  process.stdout.write(JSON.stringify({
    type: 'item.started',
    item: {
      type: 'reasoning',
      text: mode === 'recovery' ? 'waiting for runner crash' : 'waiting for stop signal',
    },
  }) + '\\n')

  heartbeatTimer = setInterval(() => {
    process.stdout.write(JSON.stringify({
      type: 'item.updated',
      item: {
        type: 'reasoning',
        text: mode === 'recovery' ? 'runner-recovery-heartbeat' : 'runner-stop-heartbeat',
      },
    }) + '\\n')
  }, 400)
})
`

  fs.writeFileSync(scriptPath, script, { mode: 0o755 })

  if (process.platform !== 'win32') {
    return scriptPath
  }

  const cmdPath = path.join(tempDir, 'fake-codex.cmd')
  fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n')
  return cmdPath
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, HOST, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killProcessTree(pid) {
  if (!isProcessAlive(pid)) {
    return
  }

  if (process.platform === 'win32') {
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    return
  }

  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Ignore already exited process.
    }
  }
}

function spawnService(entryPath, env) {
  return spawn(process.execPath, [entryPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ...env,
    },
  })
}

async function waitForHealth(baseUrl, name, timeoutMs = 15000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) {
        return
      }
    } catch {
      // Ignore until timeout.
    }
    await sleep(200)
  }

  throw new Error(`${name} 健康检查超时：${baseUrl}`)
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    ...options,
  })

  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(payload?.message || `${response.status} ${response.statusText}`)
  }

  return payload
}

async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) {
      return result
    }
    await sleep(200)
  }

  throw new Error(message)
}

async function getTask(baseUrl, taskSlug) {
  const payload = await request(baseUrl, '/api/tasks')
  return (payload.items || []).find((item) => item.slug === taskSlug) || null
}

async function getRun(baseUrl, taskSlug, runId) {
  const payload = await request(baseUrl, `/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs?limit=20&events=latest`)
  return (payload.items || []).find((item) => item.id === runId) || null
}

async function getRunEvents(baseUrl, runId) {
  const payload = await request(baseUrl, `/api/codex/runs/${encodeURIComponent(runId)}/events?limit=500`)
  return payload.items || []
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-runner-split-smoke-'))
  const fakeCodexBin = createFakeCodexBinary(tempRoot)
  const promptxHome = path.join(tempRoot, 'promptx-home')
  const serverPort = await getFreePort()
  const runnerPort = await getFreePort()
  const serverBaseUrl = `http://${HOST}:${serverPort}`
  const runnerBaseUrl = `http://${HOST}:${runnerPort}`
  const commonEnv = {
    HOST,
    PROMPTX_HOME: promptxHome,
    PROMPTX_INTERNAL_TOKEN: 'promptx-smoke-token',
    CODEX_BIN: fakeCodexBin,
  }

  const runnerProcess = spawnService(
    path.join(process.cwd(), 'apps', 'runner', 'src', 'index.js'),
    {
      ...commonEnv,
      RUNNER_PORT: String(runnerPort),
      PROMPTX_RUNNER_PORT: String(runnerPort),
      PROMPTX_SERVER_PORT: String(serverPort),
      PROMPTX_SERVER_BASE_URL: serverBaseUrl,
    }
  )

  const serverProcess = spawnService(
    path.join(process.cwd(), 'apps', 'server', 'src', 'index.js'),
    {
      ...commonEnv,
      PORT: String(serverPort),
      PROMPTX_SERVER_PORT: String(serverPort),
      PROMPTX_RUNNER_PORT: String(runnerPort),
      PROMPTX_RUNNER_BASE_URL: runnerBaseUrl,
      PROMPTX_RUNNER_SWEEP_INTERVAL_MS: '500',
      PROMPTX_RUNNER_STALE_THRESHOLD_MS: '1500',
      PROMPTX_RUNNER_RECOVERY_STARTUP_GRACE_MS: '200',
    }
  )

  let taskSlug = ''
  let sessionId = ''
  let stopRunId = ''
  let recoveryRunId = ''

  const cleanup = async () => {
    try {
      if (taskSlug && isProcessAlive(serverProcess.pid)) {
        await request(serverBaseUrl, `/api/tasks/${encodeURIComponent(taskSlug)}`, { method: 'DELETE' }).catch(() => {})
      }
      if (sessionId && isProcessAlive(serverProcess.pid)) {
        await request(serverBaseUrl, `/api/codex/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {})
      }
    } finally {
      killProcessTree(serverProcess.pid)
      killProcessTree(runnerProcess.pid)
    }
  }

  try {
    await waitForHealth(runnerBaseUrl, 'runner')
    await waitForHealth(serverBaseUrl, 'server')

    const task = await request(serverBaseUrl, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'runner split smoke task',
        expiry: 'none',
        visibility: 'private',
      }),
    })
    taskSlug = task.slug

    const session = await request(serverBaseUrl, '/api/codex/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'runner split smoke session',
        cwd: tempRoot,
        engine: 'codex',
      }),
    })
    sessionId = session.id

    const stopRunPayload = await request(serverBaseUrl, `/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        prompt: 'STOP_CASE',
      }),
    })
    stopRunId = stopRunPayload?.run?.id || ''
    assert.ok(stopRunId)

    const runningStopRun = await waitFor(
      async () => {
        const run = await getRun(serverBaseUrl, taskSlug, stopRunId)
        return run && ['starting', 'running'].includes(run.status) ? run : null
      },
      8000,
      'stop case 没有进入 starting/running'
    )

    assert.ok(['starting', 'running'].includes(runningStopRun.status))
    assert.equal(Boolean((await getTask(serverBaseUrl, taskSlug))?.running), true)

    const stopResponse = await request(serverBaseUrl, `/api/codex/runs/${encodeURIComponent(stopRunId)}/stop`, {
      method: 'POST',
      body: JSON.stringify({
        forceAfterMs: 1500,
      }),
    })
    assert.equal(stopResponse?.run?.status, 'stopping')

    const stoppedRun = await waitFor(
      async () => {
        const run = await getRun(serverBaseUrl, taskSlug, stopRunId)
        return run && ['stopped', 'stop_timeout'].includes(run.status) ? run : null
      },
      10000,
      'stop case 没有进入 stopped/stop_timeout'
    )

    assert.ok(['stopped', 'stop_timeout'].includes(stoppedRun.status))
    assert.equal(Boolean((await getTask(serverBaseUrl, taskSlug))?.running), false)

    const recoveryRunPayload = await request(serverBaseUrl, `/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        prompt: 'RECOVERY_CASE',
      }),
    })
    recoveryRunId = recoveryRunPayload?.run?.id || ''
    assert.ok(recoveryRunId)

    await waitFor(
      async () => {
        const run = await getRun(serverBaseUrl, taskSlug, recoveryRunId)
        return run && ['starting', 'running'].includes(run.status) ? run : null
      },
      8000,
      'recovery case 没有进入 starting/running'
    )

    assert.equal(Boolean((await getTask(serverBaseUrl, taskSlug))?.running), true)
    killProcessTree(runnerProcess.pid)

    const recoveredRun = await waitFor(
      async () => {
        const run = await getRun(serverBaseUrl, taskSlug, recoveryRunId)
        return run && run.status === 'error' ? run : null
      },
      12000,
      'runner 失联后 run 没有被回收为 error'
    )

    const recoveryEvents = await getRunEvents(serverBaseUrl, recoveryRunId)
    assert.ok(recoveryEvents.some((event) => event.payload?.type === 'error'))
    assert.equal(recoveredRun.status, 'error')
    assert.equal(Boolean((await getTask(serverBaseUrl, taskSlug))?.running), false)

    console.log(JSON.stringify({
      serverBaseUrl,
      runnerBaseUrl,
      taskSlug,
      sessionId,
      stopRun: {
        runId: stopRunId,
        status: stoppedRun.status,
      },
      recoveryRun: {
        runId: recoveryRunId,
        status: recoveredRun.status,
        eventCount: recoveryEvents.length,
      },
    }, null, 2))
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
