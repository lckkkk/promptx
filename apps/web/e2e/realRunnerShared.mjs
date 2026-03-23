import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import {
  requestJson,
  createRunnerSplitHarness,
  getFreePort,
  getRun,
  killProcessTree,
  sleep,
  waitFor,
} from '../../../scripts/lib/runnerSplitHarness.mjs'

export const HOST = '127.0.0.1'
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const DEFAULT_TERMINAL_STATUSES = ['completed', 'stopped', 'error', 'stop_timeout']
const DEFAULT_ACTIVE_STATUSES = ['queued', 'starting', 'running', 'stopping']

export function logLine(label, ...parts) {
  console.log([label, ...parts].filter((item) => item !== undefined && item !== null && item !== '').join(' '))
}

export function logJson(label, payload) {
  logLine(label, JSON.stringify(payload))
}

export function logEnv(payload) {
  logJson('ENV', payload)
}

export function logInitial(runtimePayload) {
  logJson('INITIAL', summarizeInitialDiagnostics(runtimePayload))
}

export function logFinal(payload) {
  logJson('FINAL', payload)
}

export function logFailure(error, label = 'FAIL') {
  console.error(`${label} ${error?.stack || error?.message || String(error)}`)
}

function getDefaultBrowserChannels() {
  if (process.platform === 'win32') {
    return ['msedge', 'chrome']
  }
  return ['chrome', 'msedge']
}

function getPreferredBrowserChannels() {
  const raw = String(process.env.PROMPTX_BROWSER_CHANNELS || '').trim()
  if (!raw) {
    return getDefaultBrowserChannels()
  }

  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

export async function launchBrowser(headless = true) {
  const executablePath = String(process.env.PROMPTX_BROWSER_EXECUTABLE_PATH || '').trim()
  const preferredChannel = String(process.env.PROMPTX_PLAYWRIGHT_CHANNEL || '').trim()
  const attempts = []

  if (executablePath) {
    try {
      const browser = await chromium.launch({ headless, executablePath })
      return { browser, strategy: `executablePath=${executablePath}` }
    } catch (error) {
      attempts.push(`executablePath=${executablePath}: ${error.message || error}`)
    }
  }

  if (preferredChannel) {
    try {
      const browser = await chromium.launch({ headless, channel: preferredChannel })
      return { browser, strategy: `channel=${preferredChannel}` }
    } catch (error) {
      attempts.push(`channel=${preferredChannel}: ${error.message || error}`)
    }
  }

  try {
    const browser = await chromium.launch({ headless })
    return { browser, strategy: 'bundled-chromium' }
  } catch (error) {
    attempts.push(`bundled-chromium: ${error.message || error}`)
  }

  for (const channel of getPreferredBrowserChannels()) {
    if (channel === preferredChannel) {
      continue
    }
    try {
      const browser = await chromium.launch({ headless, channel })
      return { browser, strategy: `channel=${channel}` }
    } catch (error) {
      attempts.push(`channel=${channel}: ${error.message || error}`)
    }
  }

  throw new Error(
    [
      '无法启动 Playwright Chromium 浏览器。',
      '1. 运行 `pnpm --filter @promptx/web exec playwright install chromium`',
      '2. 或设置 `PROMPTX_PLAYWRIGHT_CHANNEL=chrome` / `msedge`',
      '3. 或设置 `PROMPTX_BROWSER_EXECUTABLE_PATH`',
      '',
      '尝试记录：',
      ...attempts.map((item) => `- ${item}`),
    ].join('\n')
  )
}

export async function createBrowserPage(options = {}) {
  const launched = await launchBrowser(options.headless)
  const browser = launched.browser
  const page = await browser.newPage({
    viewport: options.viewport || { width: 1440, height: 1100 },
  })
  const logPrefix = String(options.logPrefix || 'BROWSER').trim() || 'BROWSER'

  page.on('console', (msg) => logLine(`${logPrefix}_${msg.type().toUpperCase()}`, msg.text()))
  page.on('pageerror', (error) => logLine(`${logPrefix}_PAGEERROR`, error.message))

  return {
    browser,
    page,
    strategy: launched.strategy,
  }
}

export function waitForWebReady(baseUrl, timeoutMs = 30_000) {
  return waitFor(async () => {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) {
        return true
      }
    } catch {
      return false
    }
    return false
  }, timeoutMs, `web 启动超时: ${baseUrl}`)
}

export async function startWebServer(apiBaseUrl, options = {}) {
  const host = String(options.host || HOST).trim() || HOST
  const cwd = options.cwd || process.cwd()
  const port = await getFreePort(host)
  const webBaseUrl = `http://${host}:${port}`
  const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const stdout = []
  const stderr = []
  const child = spawn(command, ['--filter', '@promptx/web', 'dev', '--host', host, '--port', String(port)], {
    cwd,
    windowsHide: true,
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      ...(options.env || {}),
      VITE_API_BASE_URL: apiBaseUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    stdout.push(chunk.toString())
    if (stdout.length > 80) {
      stdout.shift()
    }
  })
  child.stderr.on('data', (chunk) => {
    stderr.push(chunk.toString())
    if (stderr.length > 80) {
      stderr.shift()
    }
  })

  try {
    await waitForWebReady(webBaseUrl, options.timeoutMs)
  } catch (error) {
    killProcessTree(child.pid)
    throw new Error([
      error.message || 'web 启动失败',
      stdout.length ? `web stdout:\n${stdout.join('')}` : '',
      stderr.length ? `web stderr:\n${stderr.join('')}` : '',
    ].filter(Boolean).join('\n\n'))
  }

  return {
    baseUrl: webBaseUrl,
    child,
    async cleanup() {
      killProcessTree(child.pid)
      await sleep(300)
    },
  }
}

export async function setupManagedEnvironment(options = {}) {
  const externalWebBaseUrl = String(options.externalWebBaseUrl || '').trim()
  const externalApiBaseUrl = String(options.externalApiBaseUrl || '').trim()
  if (externalWebBaseUrl && !externalApiBaseUrl) {
    throw new Error('设置 `PROMPTX_WEB_BASE_URL` 时，需同时提供 `PROMPTX_API_BASE_URL`。')
  }

  let harness = null
  let webServer = null
  let apiBaseUrl = externalApiBaseUrl
  let webBaseUrl = externalWebBaseUrl

  if (!apiBaseUrl) {
    harness = await createRunnerSplitHarness({
      tempPrefix: options.tempPrefix || 'promptx-real-runner-',
      useFakeCodexBin: options.useFakeCodexBin === false ? false : true,
      ...(options.harnessOptions || {}),
    })
    apiBaseUrl = harness.serverBaseUrl
  }

  if (!webBaseUrl) {
    webServer = await startWebServer(apiBaseUrl, {
      cwd: options.cwd,
      timeoutMs: options.webTimeoutMs,
      env: options.webEnv,
      host: options.host,
    })
    webBaseUrl = webServer.baseUrl
  }

  return {
    apiBaseUrl,
    webBaseUrl,
    harness,
    webServer,
    async cleanup() {
      await webServer?.cleanup().catch(() => {})
      await harness?.cleanup().catch(() => {})
    },
  }
}

export function createWorkspace(rootDir, name, options = {}) {
  const workspaceDir = path.join(rootDir, name)
  fs.mkdirSync(workspaceDir, { recursive: true })

  if (typeof options.readme === 'string') {
    fs.writeFileSync(path.join(workspaceDir, 'README.md'), options.readme)
  }

  const files = options.files && typeof options.files === 'object' ? options.files : {}
  for (const [relativePath, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(workspaceDir, relativePath), content)
  }

  return workspaceDir
}

export async function createTask(apiBaseUrl, options = {}) {
  const title = String(options.title || '').trim()
  if (!title) {
    throw new Error('createTask 需要提供 title')
  }

  return requestJson(apiBaseUrl, '/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      title,
      expiry: options.expiry || 'none',
      visibility: options.visibility || 'private',
    }),
  })
}

export async function createSession(apiBaseUrl, options = {}) {
  const title = String(options.title || '').trim()
  const cwd = String(options.cwd || '').trim()
  const engine = String(options.engine || 'codex').trim() || 'codex'
  if (!title || !cwd) {
    throw new Error('createSession 需要提供 title 和 cwd')
  }

  return requestJson(apiBaseUrl, '/api/codex/sessions', {
    method: 'POST',
    body: JSON.stringify({
      title,
      cwd,
      engine,
    }),
  })
}

export async function bindTaskSessionWithPrompt(apiBaseUrl, options = {}) {
  const task = options.task
  const session = options.session
  if (!task?.slug || !session?.id) {
    throw new Error('bindTaskSessionWithPrompt 需要 task 和 session')
  }

  return requestJson(apiBaseUrl, `/api/tasks/${encodeURIComponent(task.slug)}`, {
    method: 'PUT',
    body: JSON.stringify({
      title: task.title,
      autoTitle: '',
      lastPromptPreview: '',
      todoItems: options.todoItems || [],
      codexSessionId: session.id,
      expiry: options.expiry || 'none',
      visibility: options.visibility || 'private',
      blocks: Array.isArray(options.blocks) ? options.blocks : [],
    }),
  })
}

export async function createTaskAndSession(apiBaseUrl, options = {}) {
  const title = String(options.title || '').trim()
  const cwd = String(options.cwd || '').trim()
  if (!title || !cwd) {
    throw new Error('createTaskAndSession 需要提供 title 和 cwd')
  }

  const task = await createTask(apiBaseUrl, {
    title,
    expiry: options.expiry,
    visibility: options.visibility,
  })
  const session = await createSession(apiBaseUrl, {
    title,
    cwd,
    engine: options.engine,
  })

  await bindTaskSessionWithPrompt(apiBaseUrl, {
    task,
    session,
    blocks: options.blocks,
    todoItems: options.todoItems,
    expiry: options.expiry,
    visibility: options.visibility,
  })

  return { task, session }
}

export function createTextBlock(content) {
  return { type: 'text', content, meta: {} }
}

export async function createWorkspaceTaskAndSession(apiBaseUrl, options = {}) {
  const title = String(options.title || '').trim()
  const workspaceRoot = String(options.workspaceRoot || '').trim()
  const workspaceName = String(options.workspaceName || '').trim()
  if (!title || !workspaceRoot || !workspaceName) {
    throw new Error('createWorkspaceTaskAndSession 需要 title、workspaceRoot 和 workspaceName')
  }

  const cwd = createWorkspace(workspaceRoot, workspaceName, {
    readme: options.readme,
    files: options.files,
  })

  return createTaskAndSession(apiBaseUrl, {
    title,
    cwd,
    engine: options.engine,
    blocks: options.blocks,
    todoItems: options.todoItems,
    expiry: options.expiry,
    visibility: options.visibility,
  })
}

export async function fetchLatestRun(apiBaseUrl, taskSlug) {
  const payload = await requestJson(apiBaseUrl, `/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs?limit=20&events=latest`)
  return payload.items?.[0] || null
}

export async function fetchRuntimeDiagnostics(apiBaseUrl) {
  return requestJson(apiBaseUrl, '/api/diagnostics/runtime')
}

export function getRunnerStats(runtimePayload) {
  return {
    runnerStartedAt: runtimePayload?.runner?.runner?.startedAt,
    recoveryRecovered: runtimePayload?.recovery?.metrics?.totalRecovered,
    runnerActive: runtimePayload?.runner?.runner?.activeRunCount,
    runnerTracked: runtimePayload?.runner?.runner?.trackedRunCount,
    runnerQueued: runtimePayload?.runner?.runner?.queuedRunCount,
  }
}

export function summarizeInitialDiagnostics(runtimePayload) {
  const stats = getRunnerStats(runtimePayload)
  return {
    runnerStartedAt: stats.runnerStartedAt,
    recoveryRecovered: stats.recoveryRecovered,
    active: stats.runnerActive,
    tracked: stats.runnerTracked,
    queued: stats.runnerQueued,
  }
}

export async function fetchRuns(apiBaseUrl, items, runIds) {
  return Promise.all(items.map((item, index) => getRun(
    apiBaseUrl,
    item.task.slug,
    runIds[index],
  )))
}

export function summarizeRuns(items, runs) {
  return runs.map((run, index) => ({
    slug: items[index].task.slug,
    runId: run?.id || '',
    status: run?.status || 'missing',
    errorMessage: run?.errorMessage || '',
    responseLength: String(run?.responseMessage || '').length,
  }))
}

export function buildTaskRunningMap(tasksPayload, items) {
  return Object.fromEntries(items.map((item) => {
    const match = tasksPayload.items.find((task) => task.slug === item.task.slug)
    return [item.task.slug, Boolean(match?.running)]
  }))
}

export function buildSingleRunSnapshot(task, run, tasksPayload, runtimePayload) {
  const runtimeStats = getRunnerStats(runtimePayload)
  const taskRecord = tasksPayload.items.find((item) => item.slug === task.slug)
  return {
    taskSlug: task.slug,
    runId: run?.id || '',
    status: run?.status || '',
    errorMessage: run?.errorMessage || '',
    responseLength: String(run?.responseMessage || '').length,
    taskRunning: Boolean(taskRecord?.running),
    runnerActive: runtimeStats.runnerActive,
    runnerTracked: runtimeStats.runnerTracked,
    runnerQueued: runtimeStats.runnerQueued,
    recoveryRecovered: runtimeStats.recoveryRecovered,
  }
}

export async function clickTaskCard(page, title) {
  const card = page.locator('article.workbench-task-card').filter({ hasText: title }).first()
  await card.waitFor({ state: 'visible', timeout: 30_000 })
  await card.click()
}

export async function clickSend(page) {
  const button = page.getByRole('button', { name: '发送' }).last()
  await button.waitFor({ state: 'visible', timeout: 30_000 })
  await button.click()
}

export async function openTaskPage(page, baseUrl, taskSlug, options = {}) {
  await page.goto(`${baseUrl}/?task=${encodeURIComponent(taskSlug)}`, {
    waitUntil: options.waitUntil || 'domcontentloaded',
    timeout: options.timeoutMs || 30_000,
  })
  await page.waitForTimeout(options.settleMs ?? 2500)
}

export async function sendTaskAndWaitForRun(page, apiBaseUrl, task, options = {}) {
  if (options.clickTaskCard !== false) {
    await clickTaskCard(page, task.title)
    if (options.beforeSendDelayMs ?? 0) {
      await page.waitForTimeout(options.beforeSendDelayMs ?? 0)
    }
  }

  await clickSend(page)
  const run = await waitForLatestRun(
    apiBaseUrl,
    task.slug,
    (latest) => options.predicate ? options.predicate(latest) : Boolean(latest?.id),
    options.timeoutMs || 30_000,
    options.message || `${task.slug} 发送后未找到 run`
  )

  if (options.logLabel) {
    logLine(options.logLabel, task.slug, run?.id || '')
  }
  if (options.afterSendDelayMs ?? 0) {
    await page.waitForTimeout(options.afterSendDelayMs ?? 0)
  }
  return run
}

export function isTerminalStatus(status = '', terminalStatuses = DEFAULT_TERMINAL_STATUSES) {
  return terminalStatuses.includes(String(status || '').trim())
}

export function isActiveStatus(status = '', activeStatuses = DEFAULT_ACTIVE_STATUSES) {
  return activeStatuses.includes(String(status || '').trim())
}

export async function stopRun(apiBaseUrl, runId, options = {}) {
  return requestJson(apiBaseUrl, `/api/codex/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
    body: JSON.stringify({
      reason: options.reason || 'user_requested',
      forceAfterMs: options.forceAfterMs ?? 1500,
    }),
  })
}

export async function waitForLatestRun(apiBaseUrl, taskSlug, predicate, timeoutMs, message) {
  return waitFor(async () => {
    const run = await fetchLatestRun(apiBaseUrl, taskSlug)
    return predicate(run) ? run : null
  }, timeoutMs, message)
}

export async function waitForQueuedRunsShape(apiBaseUrl, items, runIds, options = {}) {
  const activeCount = Number(options.activeCount || 0)
  const minQueued = Number(options.minQueued || 1)

  return waitFor(async () => {
    const runtime = await fetchRuntimeDiagnostics(apiBaseUrl)
    const runs = await fetchRuns(apiBaseUrl, items, runIds)
    const statuses = runs.map((run) => String(run?.status || ''))
    if (
      Number(runtime?.runner?.runner?.activeRunCount || 0) === activeCount
      && Number(runtime?.runner?.runner?.queuedRunCount || 0) >= minQueued
      && statuses.filter((status) => status === 'queued').length >= minQueued
    ) {
      return { runtime, runs, statuses }
    }
    return null
  }, options.timeoutMs, options.message || '等待 queued 并发形态超时')
}

export async function waitForTerminalRuns(apiBaseUrl, items, runIds, options = {}) {
  return waitFor(async () => {
    const runs = await fetchRuns(apiBaseUrl, items, runIds)
    if (runs.every((run) => isTerminalStatus(run?.status, options.terminalStatuses))) {
      return runs
    }
    return null
  }, options.timeoutMs, options.message || '等待 runs 进入终态超时')
}

export async function updateRunnerConfig(apiBaseUrl, options = {}) {
  return requestJson(apiBaseUrl, '/api/system/config', {
    method: 'PUT',
    body: JSON.stringify({
      runner: {
        ...(options.runner || {}),
      },
    }),
  })
}

export async function stopActiveRun(apiBaseUrl, taskSlug, runId, options = {}) {
  const normalizedRunId = String(runId || '').trim()
  if (!normalizedRunId) {
    return null
  }

  try {
    const run = await getRun(apiBaseUrl, taskSlug, normalizedRunId)
    if (!isActiveStatus(run?.status)) {
      return null
    }

    return await stopRun(apiBaseUrl, normalizedRunId, options)
  } catch {
    return null
  }
}

export async function stopActiveRuns(apiBaseUrl, items, runIds, options = {}) {
  const accepted = []

  await Promise.all(items.map(async (item, index) => {
    const response = await stopActiveRun(apiBaseUrl, item?.task?.slug, runIds[index], options)
    if (response?.run?.id) {
      accepted.push(response.run.id)
    }
  }))

  return accepted
}

export async function collectUiCards(page, titles) {
  return page.evaluate((taskTitles) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim()
    const cards = Array.from(document.querySelectorAll('article.workbench-task-card'))
    const result = {}
    for (const title of taskTitles) {
      const card = cards.find((node) => normalize(node.textContent).includes(title))
      result[title] = card ? normalize(card.textContent) : ''
    }
    return result
  }, titles)
}

export function probeCommandVersion(command) {
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

export function resolveEngineCommand(engine, env = process.env) {
  if (engine === 'claude-code') {
    return env.CLAUDE_CODE_BIN || 'claude'
  }
  if (engine === 'opencode') {
    return env.OPENCODE_BIN || 'opencode'
  }
  return env.CODEX_BIN || 'codex'
}

export function probeEngineVersion(engine, env = process.env) {
  return probeCommandVersion(resolveEngineCommand(engine, env))
}
