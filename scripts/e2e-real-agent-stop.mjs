import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execSync } from 'node:child_process'
import {
  createRunnerSplitHarness,
  getRun,
  getRunEvents,
  isProcessAlive,
  requestJson,
  sleep,
  waitFor,
} from './lib/runnerSplitHarness.mjs'

const RUN_START_TIMEOUT_MS = Math.max(10000, Number(process.env.PROMPTX_REAL_STOP_START_TIMEOUT_MS) || 120000)
const STOP_FINAL_TIMEOUT_MS = Math.max(10000, Number(process.env.PROMPTX_REAL_STOP_FINAL_TIMEOUT_MS) || 30000)
const STOP_FORCE_AFTER_MS = Math.max(200, Number(process.env.PROMPTX_REAL_STOP_FORCE_AFTER_MS) || 1500)
const PID_EXIT_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTX_REAL_STOP_PID_EXIT_TIMEOUT_MS) || 10000)
const SSE_CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTX_REAL_SSE_CONNECT_TIMEOUT_MS) || 5000)
const VERIFY_SSE = String(process.env.PROMPTX_REAL_VERIFY_SSE || '1') !== '0'
const REQUESTED_ENGINES = String(process.env.PROMPTX_REAL_ENGINES || '').trim()
const DEFAULT_ENGINE_BINS = {
  codex: process.env.CODEX_BIN || 'codex',
  opencode: process.env.OPENCODE_BIN || 'opencode',
}

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

function createSseCollector(baseUrl) {
  const controller = new AbortController()
  const decoder = new TextDecoder()
  const readyDeferred = createDeferred()
  const state = {
    ready: false,
    readyAt: 0,
    messages: [],
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

          state.messages.push({
            id: message.id,
            receivedAt: nowMs(),
            payload: message.payload,
          })

          if (message.payload?.type === 'ready' && !state.ready) {
            state.ready = true
            state.readyAt = nowMs()
            readyDeferred.resolve(state)
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
          readyDeferred.reject(new Error('SSE aborted before ready'))
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

function probeCommandVersion(command) {
  try {
    return execSync(`${command} --version`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: true,
    }).trim().split(/\r?\n/g).find(Boolean) || 'unknown'
  } catch {
    return ''
  }
}

function resolveEngines() {
  if (REQUESTED_ENGINES) {
    return REQUESTED_ENGINES
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  }

  return Object.entries(DEFAULT_ENGINE_BINS)
    .filter(([, command]) => Boolean(probeCommandVersion(command)))
    .map(([engine]) => engine)
}

function createLongTaskWorkspace(rootDir, engine) {
  const workspaceDir = path.join(rootDir, `real-stop-e2e-${engine}`)
  fs.mkdirSync(workspaceDir, { recursive: true })

  const runnerScript = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const pidFile = path.join(process.cwd(), 'long-runner.pid')",
    "const exitFile = path.join(process.cwd(), 'long-runner.exit.json')",
    "fs.writeFileSync(pidFile, String(process.pid))",
    "let count = 0",
    "console.log(`LONG_RUNNER_PID_${process.pid}`)",
    "console.log('LONG_RUNNER_START')",
    "const timer = setInterval(() => {",
    "  count += 1",
    "  console.log(`LONG_RUNNER_TICK_${count}`)",
    "}, 1000)",
    "function cleanup(reason) {",
    "  try {",
    "    fs.writeFileSync(exitFile, JSON.stringify({ pid: process.pid, reason, count, at: new Date().toISOString() }, null, 2))",
    "  } catch {}",
    "  clearInterval(timer)",
    "}",
    "process.on('SIGTERM', () => { cleanup('sigterm'); process.exit(0) })",
    "process.on('SIGINT', () => { cleanup('sigint'); process.exit(0) })",
    "setTimeout(() => { cleanup('completed'); console.log('LONG_RUNNER_DONE'); process.exit(0) }, 120000)",
  ].join('\n')

  fs.writeFileSync(path.join(workspaceDir, 'long-runner.js'), runnerScript)
  fs.writeFileSync(path.join(workspaceDir, 'README.md'), `engine=${engine}\nscenario=real-stop-e2e\n`)

  return {
    dir: workspaceDir,
    pidFile: path.join(workspaceDir, 'long-runner.pid'),
    exitFile: path.join(workspaceDir, 'long-runner.exit.json'),
  }
}

function buildLongRunPrompt(engine = 'codex') {
  if (engine === 'opencode') {
    return [
      'You are running a PromptX stop-path integration test.',
      'You must use the bash tool immediately.',
      'Run exactly this command and nothing else: node long-runner.js',
      'Do not read, summarize, or edit any file before running the command.',
      'Do not send any assistant text before the command exits naturally.',
      'After the command exits naturally, reply with exactly: LONG_RUNNER_DONE_ACK',
    ].join('\n')
  }

  return [
    '你正在执行 PromptX 的真实停止链路集成测试。',
    '不要先读文件，也不要先总结。',
    '你的第一步且唯一工具操作必须是执行：node long-runner.js',
    '启动后等待这个命令持续运行，不要主动停止它。',
    '不要修改任何文件。',
    '只有在命令自然结束后再回复。',
  ].join('\n')
}

async function createTask(baseUrl, engine) {
  return requestJson(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `real-stop-e2e-task-${engine}-${Date.now()}`,
      expiry: 'none',
      visibility: 'private',
    }),
  })
}

async function createSession(baseUrl, engine, cwd) {
  return requestJson(baseUrl, '/api/codex/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: `real-stop-e2e-session-${engine}`,
      cwd,
      engine,
    }),
  })
}

async function createRun(baseUrl, taskSlug, sessionId, prompt) {
  return requestJson(baseUrl, `/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs`, {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      prompt,
    }),
  })
}

function collectRunSseMessages(messages = [], runId = '') {
  return messages.filter((item) => item?.payload?.runId === runId)
}

function hasLongRunnerSignal(events = []) {
  return events.some((item) => {
    const payload = item?.payload || {}
    const text = String(payload?.text || payload?.message || payload?.detail || '')
    const command = String(payload?.event?.item?.command || payload?.event?.command || '')
    return text.includes('LONG_RUNNER_') || command.includes('long-runner.js')
  })
}

function formatEventTail(events = [], limit = 8) {
  return events.slice(-limit).map((item) => ({
    seq: item?.seq,
    eventType: item?.eventType,
    payload: item?.payload || {},
  }))
}

async function waitForRunActive(baseUrl, taskSlug, runId) {
  return waitFor(
    async () => {
      const run = await getRun(baseUrl, taskSlug, runId, { limit: 20, events: 'latest' })
      if (run && ['starting', 'running'].includes(run.status)) {
        return run
      }
      return null
    },
    RUN_START_TIMEOUT_MS,
    `run ${runId} did not become active`
  )
}

async function waitForLongTaskEvidence(baseUrl, runId, pidFile, evidenceTimeoutMs = 15000) {
  return waitFor(
    async () => {
      const pidExists = fs.existsSync(pidFile)
      const events = await getRunEvents(baseUrl, runId, 200)
      if (pidExists || hasLongRunnerSignal(events)) {
        return {
          pidExists,
          events,
        }
      }
      return null
    },
    evidenceTimeoutMs,
    `run ${runId} did not expose long task evidence`
  )
}

async function waitForStoppedRun(baseUrl, taskSlug, runId) {
  return waitFor(
    async () => {
      const run = await getRun(baseUrl, taskSlug, runId, { limit: 20, events: 'latest' })
      if (!run || ['queued', 'starting', 'running', 'stopping'].includes(run.status)) {
        return null
      }
      return run
    },
    STOP_FINAL_TIMEOUT_MS,
    `run ${runId} did not reach terminal status after stop`
  )
}

async function waitForProcessExit(pid) {
  return waitFor(
    async () => (!isProcessAlive(pid) ? true : null),
    PID_EXIT_TIMEOUT_MS,
    `process ${pid} is still alive after stop`
  )
}

async function runStopScenarioForEngine(harness, engine, sseCollector) {
  const workspace = createLongTaskWorkspace(harness.tempRoot, engine)
  const task = await createTask(harness.serverBaseUrl, engine)
  const session = await createSession(harness.serverBaseUrl, engine, workspace.dir)
  const runPayload = await createRun(
    harness.serverBaseUrl,
    task.slug,
    session.id,
    buildLongRunPrompt(engine)
  )
  const runId = runPayload?.run?.id || ''
  assert.ok(runId, `${engine} did not create a run id`)

  const activeRun = await waitForRunActive(
    harness.serverBaseUrl,
    task.slug,
    runId
  )

  let evidence = null
  try {
    evidence = await waitForLongTaskEvidence(
      harness.serverBaseUrl,
      runId,
      workspace.pidFile
    )
  } catch (error) {
    if (engine !== 'opencode') {
      throw error
    }
  }

  let pid = 0
  if (fs.existsSync(workspace.pidFile)) {
    pid = Number(fs.readFileSync(workspace.pidFile, 'utf8').trim()) || 0
    assert.ok(pid > 0, `${engine} long runner pid is invalid`)
    assert.ok(isProcessAlive(pid), `${engine} long runner pid ${pid} is not alive before stop`)
  } else if (engine !== 'opencode') {
    throw new Error(`${engine} long runner pid file was not created`)
  }

  const stopStartedAt = nowMs()
  const stopResponse = await requestJson(
    harness.serverBaseUrl,
    `/api/codex/runs/${encodeURIComponent(runId)}/stop`,
    {
      method: 'POST',
      body: JSON.stringify({
        forceAfterMs: STOP_FORCE_AFTER_MS,
      }),
    }
  )
  const stopAckMs = nowMs() - stopStartedAt
  if (stopResponse?.run?.status !== 'stopping') {
    const stopEvents = await getRunEvents(harness.serverBaseUrl, runId, 200).catch(() => [])
    throw new Error(
      `${engine} stop ack expected stopping but got ${stopResponse?.run?.status || 'unknown'}\n`
      + JSON.stringify({
        runId,
        pid,
        stopResponse,
        pidFileExists: fs.existsSync(workspace.pidFile),
        exitFileExists: fs.existsSync(workspace.exitFile),
        eventTail: formatEventTail(stopEvents),
      }, null, 2)
    )
  }

  const terminalRun = await waitForStoppedRun(harness.serverBaseUrl, task.slug, runId)
  assert.equal(terminalRun.status, 'stopped', `${engine} run should end as stopped`) 

  if (pid > 0) {
    await waitForProcessExit(pid)
    await sleep(300)
  }

  const finalEvents = await getRunEvents(harness.serverBaseUrl, runId, 500)
  assert.ok(finalEvents.some((item) => item.eventType === 'stopped'), `${engine} missing stopped event in persisted events`)
  const evidenceMode = pid > 0 ? 'pid' : (evidence ? 'events' : 'active_only')
  if (engine !== 'opencode' || evidenceMode === 'events') {
    assert.ok(finalEvents.some((item) => String(item?.payload?.text || '').includes('LONG_RUNNER_') || String(item?.payload?.event?.item?.command || '').includes('long-runner.js')), `${engine} missing long-runner evidence in persisted events`)
  }

  if (VERIFY_SSE) {
    const sseMessages = collectRunSseMessages(sseCollector.state.messages, runId)
    assert.ok(sseMessages.some((item) => item.payload?.type === 'runs.changed'), `${engine} missing SSE runs.changed during stop flow`)
    assert.ok(sseMessages.some((item) => item.payload?.type === 'run.event' && item.payload?.event?.eventType === 'stopped'), `${engine} missing SSE stopped event during stop flow`)
  }

  return {
    engine,
    workspaceDir: workspace.dir,
    taskSlug: task.slug,
    sessionId: session.id,
    runId,
      pid,
      stopAckMs,
      startedStatus: activeRun.status,
      finalStatus: terminalRun.status,
      eventCount: finalEvents.length,
      evidenceMode,
      exitFileExists: fs.existsSync(workspace.exitFile),
      sseMessages: VERIFY_SSE ? collectRunSseMessages(sseCollector.state.messages, runId).length : 0,
    }
}

async function main() {
  const engines = resolveEngines()
  assert.ok(engines.length > 0, 'No real CLI engine detected. Set PROMPTX_REAL_ENGINES or install codex/opencode first.')

  const versions = Object.fromEntries(
    engines.map((engine) => [engine, probeCommandVersion(DEFAULT_ENGINE_BINS[engine]) || 'unknown'])
  )

  const harness = await createRunnerSplitHarness({
    useFakeCodexBin: false,
  })

  const sseCollector = VERIFY_SSE ? createSseCollector(harness.serverBaseUrl) : null
  if (sseCollector) {
    await Promise.race([
      sseCollector.ready,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('SSE connect timeout')), SSE_CONNECT_TIMEOUT_MS)
      }),
    ])
  }

  try {
    const results = []
    for (const engine of engines) {
      results.push(await runStopScenarioForEngine(
        harness,
        engine,
        sseCollector || { state: { messages: [] } }
      ))
    }

    const summary = {
      serverBaseUrl: harness.serverBaseUrl,
      runnerBaseUrl: harness.runnerBaseUrl,
      startTimeoutMs: RUN_START_TIMEOUT_MS,
      stopFinalTimeoutMs: STOP_FINAL_TIMEOUT_MS,
      stopForceAfterMs: STOP_FORCE_AFTER_MS,
      verifySse: VERIFY_SSE,
      cliVersions: versions,
      sse: sseCollector
        ? {
            ready: sseCollector.state.ready,
            unexpectedDisconnect: sseCollector.state.unexpectedDisconnect,
            errors: sseCollector.state.errors,
            messageCount: sseCollector.state.messages.length,
          }
        : null,
      engines: results,
    }

    console.log(JSON.stringify(summary, null, 2))

    if (sseCollector) {
      assert.equal(sseCollector.state.errors.length, 0, `SSE errors: ${sseCollector.state.errors.join('; ')}`)
      assert.equal(sseCollector.state.unexpectedDisconnect, false, 'SSE disconnected unexpectedly during real stop test')
    }
  } catch (error) {
    const decorated = new Error([
      error?.message || String(error),
      harness.readRunnerStdout() ? `runner stdout:\n${harness.readRunnerStdout()}` : '',
      harness.readRunnerStderr() ? `runner stderr:\n${harness.readRunnerStderr()}` : '',
      harness.readServerStdout() ? `server stdout:\n${harness.readServerStdout()}` : '',
      harness.readServerStderr() ? `server stderr:\n${harness.readServerStderr()}` : '',
    ].filter(Boolean).join('\n\n'))
    throw decorated
  } finally {
    if (sseCollector) {
      sseCollector.close()
      await sseCollector.finished.catch(() => {})
    }
    await harness.cleanup()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
