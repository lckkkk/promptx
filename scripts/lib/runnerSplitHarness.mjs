import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { execFileSync, spawn } from 'node:child_process'

const DEFAULT_HOST = '127.0.0.1'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createFakeCodexBinary(tempDir) {
  const scriptPath = path.join(tempDir, process.platform === 'win32' ? 'fake-codex.js' : 'fake-codex')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')

const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output-last-message')
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''
const resumeIndex = args.indexOf('resume')
const resumeTarget = resumeIndex >= 0 ? args[resumeIndex + 1] || '' : ''
const threadId = resumeTarget || 'thread-harness-1'

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
  const mode = prompt.includes('RECOVERY_CASE')
    ? 'recovery'
    : prompt.includes('STOP_CASE')
      ? 'stop'
      : prompt.includes('LONG_CASE')
        ? 'long'
        : prompt.includes('FAIL_CASE')
          ? 'fail'
          : 'complete'

  if (mode === 'fail') {
    process.stderr.write('fake codex failure\\n')
    cleanupAndExit(2)
    return
  }

  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')

  if (mode === 'complete') {
    if (outputFile) {
      fs.writeFileSync(outputFile, 'HARNESS_OK')
    }
    process.stdout.write(JSON.stringify({ type: 'turn.completed', result: 'HARNESS_OK' }) + '\\n')
    cleanupAndExit(0)
    return
  }

  process.stdout.write(JSON.stringify({
    type: 'item.started',
    item: {
      type: 'reasoning',
      text: mode === 'recovery'
        ? 'waiting for runner crash'
        : mode === 'stop'
          ? 'waiting for stop signal'
          : 'running long task',
    },
  }) + '\\n')

  heartbeatTimer = setInterval(() => {
    process.stdout.write(JSON.stringify({
      type: 'item.updated',
      item: {
        type: 'reasoning',
        text: mode === 'recovery'
          ? 'runner-recovery-heartbeat'
          : mode === 'stop'
            ? 'runner-stop-heartbeat'
            : 'runner-long-heartbeat',
      },
    }) + '\\n')
  }, 300)
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

export async function getFreePort(host = DEFAULT_HOST) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, host, () => {
      const address = server.address()
      const port = Number(address?.port || 0)
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

export function isProcessAlive(pid) {
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

export function killProcessTree(pid) {
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

export function getProcessRssMb(pid) {
  if (!isProcessAlive(pid)) {
    return 0
  }

  try {
    if (process.platform === 'win32') {
      const output = execFileSync(
        'tasklist.exe',
        ['/FO', 'CSV', '/NH', '/FI', `PID eq ${pid}`],
        {
          encoding: 'utf8',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      ).trim()

      if (!output || output.startsWith('INFO:')) {
        return 0
      }

      const columns = output
        .split(/\r?\n/g)
        .find(Boolean)
        ?.split('","')
        .map((item) => item.replace(/^"/, '').replace(/"$/, '').trim()) || []
      const memoryColumn = columns[4] || ''
      const memoryKb = Number(memoryColumn.replace(/[^\d]/g, '')) || 0
      return memoryKb / 1024
    }

    const output = execFileSync(
      'ps',
      ['-o', 'rss=', '-p', String(pid)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim()

    return (Number(output) || 0) / 1024
  } catch {
    return 0
  }
}

function createOutputTail(maxLines = 80) {
  const lines = []
  return {
    push(chunk = '') {
      String(chunk || '')
        .split(/\r?\n/g)
        .filter(Boolean)
        .forEach((line) => {
          lines.push(line)
          if (lines.length > maxLines) {
            lines.shift()
          }
        })
    },
    read() {
      return lines.join('\n')
    },
  }
}

function spawnService(entryPath, env) {
  const stdoutTail = createOutputTail()
  const stderrTail = createOutputTail()
  const child = spawn(process.execPath, [entryPath], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      ...env,
    },
  })

  child.stdout.on('data', (chunk) => stdoutTail.push(chunk.toString()))
  child.stderr.on('data', (chunk) => stderrTail.push(chunk.toString()))

  return {
    child,
    readStdout() {
      return stdoutTail.read()
    },
    readStderr() {
      return stderrTail.read()
    },
  }
}

export async function waitFor(predicate, timeoutMs, message) {
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

export async function waitForHealth(baseUrl, name, timeoutMs = 15000) {
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

export async function requestJson(baseUrl, pathname, options = {}) {
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

export async function getTask(baseUrl, taskSlug) {
  const payload = await requestJson(baseUrl, '/api/tasks')
  return (payload.items || []).find((item) => item.slug === taskSlug) || null
}

export async function getTaskRuns(baseUrl, taskSlug, options = {}) {
  const params = new URLSearchParams()
  params.set('limit', String(options.limit || 50))
  if (options.events) {
    params.set('events', String(options.events))
  }

  const payload = await requestJson(
    baseUrl,
    `/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs?${params.toString()}`
  )
  return payload.items || []
}

export async function getRun(baseUrl, taskSlug, runId, options = {}) {
  const items = await getTaskRuns(baseUrl, taskSlug, options)
  return items.find((item) => item.id === runId) || null
}

export async function getRunEvents(baseUrl, runId, limit = 500) {
  const payload = await requestJson(baseUrl, `/api/codex/runs/${encodeURIComponent(runId)}/events?limit=${limit}`)
  return payload.items || []
}

export function createStats(values = []) {
  const numbers = values
    .map((value) => Number(value) || 0)
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right)

  if (!numbers.length) {
    return {
      count: 0,
      min: 0,
      max: 0,
      avg: 0,
      p50: 0,
      p95: 0,
      p99: 0,
    }
  }

  const pick = (ratio) => numbers[Math.min(numbers.length - 1, Math.max(0, Math.ceil(numbers.length * ratio) - 1))]
  const total = numbers.reduce((sum, value) => sum + value, 0)
  return {
    count: numbers.length,
    min: numbers[0],
    max: numbers[numbers.length - 1],
    avg: total / numbers.length,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
  }
}

export async function createRunnerSplitHarness(options = {}) {
  const host = String(options.host || DEFAULT_HOST).trim() || DEFAULT_HOST
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), options.tempPrefix || 'promptx-runner-harness-'))
  const promptxHome = path.join(tempRoot, 'promptx-home')
  const useFakeCodexBin = options.useFakeCodexBin !== false
  const fakeCodexBin = useFakeCodexBin ? createFakeCodexBinary(tempRoot) : ''
  const serverPort = options.serverPort || await getFreePort(host)
  const runnerPort = options.runnerPort || await getFreePort(host)
  const serverBaseUrl = `http://${host}:${serverPort}`
  const runnerBaseUrl = `http://${host}:${runnerPort}`
  const internalToken = String(options.internalToken || 'promptx-harness-token').trim() || 'promptx-harness-token'
  const commonEnv = {
    HOST: host,
    PROMPTX_HOME: promptxHome,
    PROMPTX_INTERNAL_TOKEN: internalToken,
    ...(options.commonEnv || {}),
  }
  if (fakeCodexBin && !Object.prototype.hasOwnProperty.call(commonEnv, 'CODEX_BIN')) {
    commonEnv.CODEX_BIN = fakeCodexBin
  }
  const resolvedRunnerEnv = {
    ...commonEnv,
    RUNNER_PORT: String(runnerPort),
    PROMPTX_RUNNER_PORT: String(runnerPort),
    PROMPTX_SERVER_PORT: String(serverPort),
    PROMPTX_SERVER_BASE_URL: serverBaseUrl,
    ...(options.runnerEnv || {}),
  }
  const resolvedServerEnv = {
    ...commonEnv,
    PORT: String(serverPort),
    PROMPTX_SERVER_PORT: String(serverPort),
    PROMPTX_RUNNER_PORT: String(runnerPort),
    PROMPTX_RUNNER_BASE_URL: runnerBaseUrl,
    ...(options.serverEnv || {}),
  }
  const runnerEntryPath = path.join(process.cwd(), 'apps', 'runner', 'src', 'index.js')
  const serverEntryPath = path.join(process.cwd(), 'apps', 'server', 'src', 'index.js')

  let runner = spawnService(runnerEntryPath, resolvedRunnerEnv)
  let server = spawnService(serverEntryPath, resolvedServerEnv)

  try {
    await waitForHealth(runnerBaseUrl, 'runner', options.healthTimeoutMs || 15000)
    await waitForHealth(serverBaseUrl, 'server', options.healthTimeoutMs || 15000)
  } catch (error) {
    killProcessTree(server.child.pid)
    killProcessTree(runner.child.pid)
    throw new Error([
      error.message || 'harness startup failed',
      runner.readStdout() ? `runner stdout:\n${runner.readStdout()}` : '',
      runner.readStderr() ? `runner stderr:\n${runner.readStderr()}` : '',
      server.readStdout() ? `server stdout:\n${server.readStdout()}` : '',
      server.readStderr() ? `server stderr:\n${server.readStderr()}` : '',
    ].filter(Boolean).join('\n\n'))
  }

  async function cleanup() {
    killProcessTree(server.child?.pid)
    killProcessTree(runner.child?.pid)
    await sleep(300)
  }

  async function waitForRunnerHealth(timeoutMs = options.healthTimeoutMs || 15000) {
    await waitForHealth(runnerBaseUrl, 'runner', timeoutMs)
  }

  async function stopRunner() {
    killProcessTree(runner.child?.pid)
    await sleep(300)
  }

  async function restartRunner(timeoutMs = options.healthTimeoutMs || 15000) {
    await stopRunner()
    runner = spawnService(runnerEntryPath, resolvedRunnerEnv)

    try {
      await waitForRunnerHealth(timeoutMs)
    } catch (error) {
      throw new Error([
        error.message || 'runner restart failed',
        runner.readStdout() ? `runner stdout:\n${runner.readStdout()}` : '',
        runner.readStderr() ? `runner stderr:\n${runner.readStderr()}` : '',
      ].filter(Boolean).join('\n\n'))
    }

    return runner.child
  }

  return {
    host,
    tempRoot,
    promptxHome,
    fakeCodexBin,
    internalToken,
    serverBaseUrl,
    runnerBaseUrl,
    get serverProcess() {
      return server.child
    },
    get runnerProcess() {
      return runner.child
    },
    readServerStdout() {
      return server.readStdout()
    },
    readServerStderr() {
      return server.readStderr()
    },
    readRunnerStdout() {
      return runner.readStdout()
    },
    readRunnerStderr() {
      return runner.readStderr()
    },
    waitForRunnerHealth,
    stopRunner,
    restartRunner,
    cleanup,
  }
}
