import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execSync } from 'node:child_process'
import {
  createRunnerSplitHarness,
  getRun,
  getRunEvents,
  requestJson,
  waitFor,
} from './lib/runnerSplitHarness.mjs'

const RUN_TIMEOUT_MS = Math.max(30000, Number(process.env.PROMPTX_REAL_RUN_TIMEOUT_MS) || 240000)
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

function createWorkspace(rootDir, engine) {
  const workspaceDir = path.join(rootDir, `real-e2e-${engine}`)
  fs.mkdirSync(workspaceDir, { recursive: true })

  const files = {
    'README.md': [
      '# PromptX Real E2E Workspace',
      '',
      `ENGINE=${engine}`,
      'This workspace is used to verify real PromptX full-chain execution.',
      '',
    ].join('\n'),
    'facts.txt': [
      'PROJECT_NAME=PromptX Real E2E Workspace',
      `ENGINE_NAME=${engine}`,
      'TEST_FACT=alpha-42',
      '',
    ].join('\n'),
    'notes/reference.txt': [
      'DO_NOT_EDIT=true',
      'EXPECTED_MARKER=REAL_E2E_OK',
      '',
    ].join('\n'),
  }

  Object.entries(files).forEach(([relativePath, content]) => {
    const filePath = path.join(workspaceDir, relativePath)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content)
  })

  const trackedFiles = Object.keys(files)
  return {
    dir: workspaceDir,
    trackedFiles,
  }
}

function getWorkspaceDigest(workspaceDir, trackedFiles = []) {
  const hash = crypto.createHash('sha256')
  trackedFiles.forEach((relativePath) => {
    const filePath = path.join(workspaceDir, relativePath)
    hash.update(relativePath)
    hash.update('\n')
    hash.update(fs.readFileSync(filePath))
    hash.update('\n')
  })
  return hash.digest('hex')
}

async function getSession(baseUrl, sessionId) {
  const payload = await requestJson(baseUrl, '/api/codex/sessions')
  return (payload.items || []).find((item) => item.id === sessionId) || null
}

function getSessionThreadValue(session = {}) {
  return String(
    session?.engineSessionId
    || session?.engineThreadId
    || session?.codexThreadId
    || ''
  ).trim()
}

function buildFirstPrompt(engine = 'codex') {
  if (engine === 'opencode') {
    return [
      'Read README.md, facts.txt, and notes/reference.txt.',
      'Do not modify any file.',
      'Reply with exactly these 3 lines and nothing else:',
      'RESULT_PROJECT=PromptX Real E2E Workspace',
      'RESULT_FACT=alpha-42',
      'RESULT_DONE=REAL_E2E_OK',
    ].join('\n')
  }

  return [
    '你正在执行 PromptX 的真实全链路集成测试。',
    '要求：',
    '1. 只读操作，不要创建、删除或修改任何文件。',
    '2. 读取当前目录下的 README.md、facts.txt、notes/reference.txt。',
    '3. 最终回复必须严格只有以下三行，不能包含代码块、解释或额外文字：',
    'RESULT_PROJECT=PromptX Real E2E Workspace',
    'RESULT_FACT=alpha-42',
    'RESULT_DONE=REAL_E2E_OK',
  ].join('\n')
}

function buildSecondPrompt(engine = 'codex') {
  if (engine === 'opencode') {
    return [
      'Read facts.txt again in the same session.',
      'Do not modify any file.',
      'Reply with exactly these 2 lines and nothing else:',
      'RESULT_RESUME=alpha-42',
      'RESULT_THREAD=REAL_E2E_RESUME_OK',
    ].join('\n')
  }

  return [
    '继续在同一个 PromptX 项目里做第二轮真实测试。',
    '要求：',
    '1. 仍然只读，不要修改任何文件。',
    '2. 再次读取 facts.txt。',
    '3. 最终回复必须严格只有以下两行，不能包含解释：',
    'RESULT_RESUME=alpha-42',
    'RESULT_THREAD=REAL_E2E_RESUME_OK',
  ].join('\n')
}

function assertFirstResponse(engine = 'codex', responseMessage = '') {
  const text = String(responseMessage || '').trim()
  if (engine === 'opencode') {
    assert.match(text, /PromptX Real E2E Workspace/)
    assert.match(text, /alpha-42/)
    assert.match(text, /REAL_E2E_OK/)
    return
  }

  assert.match(text, /RESULT_PROJECT=PromptX Real E2E Workspace/)
  assert.match(text, /RESULT_FACT=alpha-42/)
  assert.match(text, /RESULT_DONE=REAL_E2E_OK/)
}

function assertSecondResponse(engine = 'codex', responseMessage = '') {
  const text = String(responseMessage || '').trim()
  if (engine === 'opencode') {
    if (/RESULT_RESUME=alpha-42/.test(text) && /RESULT_THREAD=REAL_E2E_RESUME_OK/.test(text)) {
      return
    }
    assert.match(text, /alpha-42/)
    assert.match(text, /facts\.txt|PROJECT_NAME=PromptX Real E2E Workspace|ENGINE_NAME=opencode/)
    return
  }

  assert.match(text, /RESULT_RESUME=alpha-42/)
  assert.match(text, /RESULT_THREAD=REAL_E2E_RESUME_OK/)
}

async function createTask(baseUrl, engine) {
  return requestJson(baseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title: `real-e2e-task-${engine}-${Date.now()}`,
      expiry: 'none',
      visibility: 'private',
    }),
  })
}

async function createSession(baseUrl, engine, cwd) {
  return requestJson(baseUrl, '/api/codex/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title: `real-e2e-session-${engine}`,
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

async function waitForRunTerminal(baseUrl, taskSlug, runId) {
  const run = await waitFor(
    async () => {
      const item = await getRun(baseUrl, taskSlug, runId, { limit: 20, events: 'latest' })
      if (!item || ['queued', 'starting', 'running', 'stopping'].includes(item.status)) {
        return null
      }
      return item
    },
    RUN_TIMEOUT_MS,
    `run ${runId} did not reach terminal status`
  )

  if (run.status !== 'completed') {
    const events = await getRunEvents(baseUrl, runId, 200).catch(() => [])
    const eventTail = events.slice(-5).map((item) => `${item.seq}:${item.eventType}`).join(', ')
    throw new Error(`run ${runId} finished with status=${run.status}, error=${run.errorMessage || 'n/a'}, events=${eventTail}`)
  }

  return run
}

function collectRunSseMessages(messages = [], runId = '') {
  return messages.filter((item) => item?.payload?.runId === runId)
}

async function runScenarioForEngine(harness, engine, sseCollector) {
  const workspace = createWorkspace(harness.tempRoot, engine)
  const beforeDigest = getWorkspaceDigest(workspace.dir, workspace.trackedFiles)
  const task = await createTask(harness.serverBaseUrl, engine)
  const session = await createSession(harness.serverBaseUrl, engine, workspace.dir)

  const firstRunPayload = await createRun(
    harness.serverBaseUrl,
    task.slug,
    session.id,
    buildFirstPrompt(engine)
  )
  const firstRun = await waitForRunTerminal(
    harness.serverBaseUrl,
    task.slug,
    firstRunPayload?.run?.id || ''
  )
  assertFirstResponse(engine, firstRun.responseMessage)

  const sessionAfterFirstRun = await getSession(harness.serverBaseUrl, session.id)
  const firstThreadValue = getSessionThreadValue(sessionAfterFirstRun)
  assert.ok(firstThreadValue, `${engine} session did not persist thread/session id after first run`)

  const secondRunPayload = await createRun(
    harness.serverBaseUrl,
    task.slug,
    session.id,
    buildSecondPrompt(engine)
  )
  const secondRun = await waitForRunTerminal(
    harness.serverBaseUrl,
    task.slug,
    secondRunPayload?.run?.id || ''
  )
  assertSecondResponse(engine, secondRun.responseMessage)

  const sessionAfterSecondRun = await getSession(harness.serverBaseUrl, session.id)
  const secondThreadValue = getSessionThreadValue(sessionAfterSecondRun)
  assert.ok(secondThreadValue, `${engine} session lost thread/session id after second run`)
  assert.equal(secondThreadValue, firstThreadValue, `${engine} session id/thread id changed unexpectedly across resume`)

  const firstRunEvents = await getRunEvents(harness.serverBaseUrl, firstRun.id, 500)
  const secondRunEvents = await getRunEvents(harness.serverBaseUrl, secondRun.id, 500)
  assert.ok(firstRunEvents.length > 0, `${engine} first run has no persisted events`)
  assert.ok(secondRunEvents.length > 0, `${engine} second run has no persisted events`)

  if (VERIFY_SSE) {
    const firstRunSse = collectRunSseMessages(sseCollector.state.messages, firstRun.id)
    const secondRunSse = collectRunSseMessages(sseCollector.state.messages, secondRun.id)
    assert.ok(firstRunSse.some((item) => item.payload?.type === 'runs.changed'), `${engine} first run missing SSE runs.changed`)
    assert.ok(firstRunSse.some((item) => item.payload?.type === 'run.event'), `${engine} first run missing SSE run.event`)
    assert.ok(secondRunSse.some((item) => item.payload?.type === 'runs.changed'), `${engine} second run missing SSE runs.changed`)
    assert.ok(secondRunSse.some((item) => item.payload?.type === 'run.event'), `${engine} second run missing SSE run.event`)
  }

  const afterDigest = getWorkspaceDigest(workspace.dir, workspace.trackedFiles)
  assert.equal(afterDigest, beforeDigest, `${engine} workspace was modified during read-only real test`)

  return {
    engine,
    workspaceDir: workspace.dir,
    taskSlug: task.slug,
    sessionId: session.id,
    threadValue: secondThreadValue,
    firstRun: {
      id: firstRun.id,
      eventCount: firstRunEvents.length,
      responseMessage: firstRun.responseMessage,
    },
    secondRun: {
      id: secondRun.id,
      eventCount: secondRunEvents.length,
      responseMessage: secondRun.responseMessage,
    },
    sse: VERIFY_SSE
      ? {
          firstRunMessages: collectRunSseMessages(sseCollector.state.messages, firstRun.id).length,
          secondRunMessages: collectRunSseMessages(sseCollector.state.messages, secondRun.id).length,
        }
      : null,
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
      try {
        const result = await runScenarioForEngine(
          harness,
          engine,
          sseCollector || { state: { messages: [] } }
        )
        results.push({
          status: 'passed',
          ...result,
        })
      } catch (error) {
        results.push({
          status: 'failed',
          engine,
          error: error?.message || String(error),
        })
      }
    }

    const summary = {
      serverBaseUrl: harness.serverBaseUrl,
      runnerBaseUrl: harness.runnerBaseUrl,
      timeoutMs: RUN_TIMEOUT_MS,
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

    const failures = results.filter((item) => item.status === 'failed')
    if (failures.length) {
      throw new Error(
        failures.map((item) => `${item.engine}: ${item.error}`).join(' | ')
      )
    }

    if (sseCollector) {
      assert.equal(sseCollector.state.errors.length, 0, `SSE errors: ${sseCollector.state.errors.join('; ')}`)
      assert.equal(sseCollector.state.unexpectedDisconnect, false, 'SSE disconnected unexpectedly during real test')
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
