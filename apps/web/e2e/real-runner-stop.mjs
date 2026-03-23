import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  requestJson,
} from '../../../scripts/lib/runnerSplitHarness.mjs'
import {
  ROOT_DIR,
  buildSingleRunSnapshot,
  createBrowserPage,
  createTextBlock,
  createWorkspaceTaskAndSession,
  fetchRuntimeDiagnostics,
  isTerminalStatus,
  logEnv,
  logFailure,
  logFinal,
  logInitial,
  logJson,
  logLine,
  openTaskPage,
  probeEngineVersion,
  sendTaskAndWaitForRun,
  setupManagedEnvironment,
  stopActiveRun,
  waitForLatestRun,
} from './realRunnerShared.mjs'

const EXTERNAL_WEB_BASE_URL = String(process.env.PROMPTX_WEB_BASE_URL || '').trim()
const EXTERNAL_API_BASE_URL = String(process.env.PROMPTX_API_BASE_URL || '').trim()
const ENGINE = String(process.env.PROMPTX_ENGINE || 'codex').trim() || 'codex'
const PROMPT_TEXT = process.env.PROMPTX_PROMPT_TEXT || '请详细整理 2000 年到 2024 年国际局势中的伊朗相关关键事件，按年份分段，尽量完整，并给出结构化总结。'
const TIMEOUT_MS = Math.max(30_000, Number(process.env.PROMPTX_TIMEOUT_MS) || 8 * 60 * 1000)
const RUNNING_TIMEOUT_MS = Math.max(10_000, Number(process.env.PROMPTX_RUNNING_TIMEOUT_MS) || 90_000)
const HEADLESS = !/^(0|false|no)$/i.test(String(process.env.PROMPTX_HEADLESS || 'true').trim())

process.chdir(ROOT_DIR)

async function createTaskAndSession(apiBaseUrl, workspaceRoot) {
  const stamp = `${Date.now()}`
  const title = `真实停止回归-${stamp}`
  return createWorkspaceTaskAndSession(apiBaseUrl, {
    title,
    workspaceRoot,
    workspaceName: 'workspace',
    readme: '# real runner stop repro\n',
    engine: ENGINE,
    blocks: [createTextBlock(PROMPT_TEXT)],
  })
}

async function main() {
  const environment = await setupManagedEnvironment({
    externalWebBaseUrl: EXTERNAL_WEB_BASE_URL,
    externalApiBaseUrl: EXTERNAL_API_BASE_URL,
    tempPrefix: 'promptx-real-stop-',
    useFakeCodexBin: false,
    cwd: process.cwd(),
  })
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-real-stop-'))
  let browser = null
  let taskSlug = ''
  let runId = ''

  try {
    const created = await createTaskAndSession(environment.apiBaseUrl, workspaceRoot)
    taskSlug = created.task.slug

    logEnv({
      apiBaseUrl: environment.apiBaseUrl,
      webBaseUrl: environment.webBaseUrl,
      managedServer: Boolean(environment.harness),
      managedWeb: Boolean(environment.webServer),
      engine: ENGINE,
      cliVersions: {
        [ENGINE]: probeEngineVersion(ENGINE) || 'unknown',
      },
    })

    const initialDiagnostics = await fetchRuntimeDiagnostics(environment.apiBaseUrl)
    logInitial(initialDiagnostics)

    const launched = await createBrowserPage({ headless: HEADLESS, logPrefix: 'BROWSER' })
    browser = launched.browser
    logLine('BROWSER', launched.strategy)
    const { page } = launched

    await openTaskPage(page, environment.webBaseUrl, created.task.slug)

    const activeRun = await sendTaskAndWaitForRun(page, environment.apiBaseUrl, created.task, {
      clickTaskCard: false,
      predicate: (run) => ['queued', 'starting', 'running'].includes(String(run?.status || '')),
      timeoutMs: TIMEOUT_MS,
      message: '发送后没有观察到活动 run',
      logLabel: 'SENT',
    })
    runId = activeRun?.id || ''
    if (!runId) {
      throw new Error('发送后没有观察到活动 run')
    }

    logJson('ACTIVE', {
      runId,
      status: activeRun.status,
    })

    const runningRun = await waitForLatestRun(
      environment.apiBaseUrl,
      created.task.slug,
      (run) => String(run?.status || '') === 'running',
      RUNNING_TIMEOUT_MS,
      '运行态等待超时'
    ).catch(() => activeRun)

    logJson('RUNNING', {
      runId: runningRun?.id || runId,
      status: runningRun?.status || activeRun.status,
    })

    const stopButton = page.getByRole('button', { name: '停止' }).last()
    await stopButton.waitFor({ state: 'visible', timeout: 30_000 })
    await stopButton.click()
    logLine('STOP_CLICKED', created.task.slug)

    const terminalRun = await waitForLatestRun(
      environment.apiBaseUrl,
      created.task.slug,
      (run) => isTerminalStatus(run?.status),
      TIMEOUT_MS,
      '停止后没有观察到终态 run'
    )

    if (!terminalRun?.id) {
      throw new Error('停止后没有观察到终态 run')
    }

    const tasksPayload = await requestJson(environment.apiBaseUrl, '/api/tasks')
    const runtimePayload = await fetchRuntimeDiagnostics(environment.apiBaseUrl)
    const snapshot = buildSingleRunSnapshot(created.task, terminalRun, tasksPayload, runtimePayload)

    logFinal(snapshot)

    if (!['stopped', 'stop_timeout'].includes(String(terminalRun.status || ''))) {
      throw new Error(`停止回归未落到预期终态: ${JSON.stringify(snapshot)}`)
    }
    if (String(terminalRun.errorMessage || '').includes('Runner 已失联')) {
      throw new Error(`停止回归出现 Runner 已失联: ${JSON.stringify(snapshot)}`)
    }
    if (snapshot.taskRunning) {
      throw new Error(`停止后任务仍显示 running: ${JSON.stringify(snapshot)}`)
    }
  } finally {
    await stopActiveRun(environment.apiBaseUrl, taskSlug, runId).catch(() => {})
    await browser?.close().catch(() => {})
    await environment.cleanup().catch(() => {})
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  logFailure(error)
  process.exitCode = 1
})
