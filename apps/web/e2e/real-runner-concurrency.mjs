import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  requestJson,
  sleep,
  waitFor,
} from '../../../scripts/lib/runnerSplitHarness.mjs'
import {
  ROOT_DIR,
  buildTaskRunningMap,
  collectUiCards,
  createBrowserPage,
  createTextBlock,
  createWorkspaceTaskAndSession,
  fetchRuntimeDiagnostics,
  fetchRuns,
  getRunnerStats,
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
  summarizeRuns,
  stopActiveRuns,
  updateRunnerConfig,
  waitForQueuedRunsShape,
} from './realRunnerShared.mjs'

const EXTERNAL_WEB_BASE_URL = String(process.env.PROMPTX_WEB_BASE_URL || '').trim()
const EXTERNAL_API_BASE_URL = String(process.env.PROMPTX_API_BASE_URL || '').trim()
const REQUESTED_ENGINES = String(process.env.PROMPTX_REAL_ENGINES || '').trim()
const PROMPT_TEXT = process.env.PROMPTX_PROMPT_TEXT || '伊朗局势目前什么情况？'
const TASK_COUNT = Number(process.env.PROMPTX_TASK_COUNT || 5)
const MAX_CONCURRENT_RUNS = Number(process.env.PROMPTX_MAX_CONCURRENT_RUNS || 3)
const START_TIMEOUT_MS = Math.max(30_000, Number(process.env.PROMPTX_START_TIMEOUT_MS) || 120_000)
const STOP_TIMEOUT_MS = Math.max(10_000, Number(process.env.PROMPTX_STOP_TIMEOUT_MS) || 60_000)
const HEADLESS = !/^(0|false|no)$/i.test(String(process.env.PROMPTX_HEADLESS || 'true').trim())
const SHOULD_SET_RUNNER_CONFIG = String(process.env.PROMPTX_SET_RUNNER_CONFIG || '1') !== '0'
const DEFAULT_ENGINE_BINS = {
  codex: process.env.CODEX_BIN || 'codex',
  'claude-code': process.env.CLAUDE_CODE_BIN || 'claude',
  opencode: process.env.OPENCODE_BIN || 'opencode',
}

process.chdir(ROOT_DIR)

function resolveEngines() {
  if (REQUESTED_ENGINES) {
    return REQUESTED_ENGINES
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  }

  return ['codex']
}

function buildCliVersions(engines) {
  return Object.fromEntries(
    engines.map((engine) => [engine, probeEngineVersion(engine) || 'missing'])
  )
}

function pickEngine(engines, index) {
  return engines[(index - 1) % engines.length] || 'codex'
}

async function createTaskAndSession(apiBaseUrl, workspaceRoot, index, engine) {
  const stamp = `${Date.now()}-${index}`
  const title = `真实并发回归-${engine}-${stamp}`
  return createWorkspaceTaskAndSession(apiBaseUrl, {
    title,
    workspaceRoot,
    workspaceName: `${engine}-workspace-${index}`,
    readme: '# real browser repro\n',
    engine,
    blocks: [createTextBlock(PROMPT_TEXT)],
  })
}

async function ensureRunnerConfig(apiBaseUrl) {
  await updateRunnerConfig(apiBaseUrl, {
    runner: {
      maxConcurrentRuns: MAX_CONCURRENT_RUNS,
    },
  })
}

async function main() {
  const engines = resolveEngines()
  if (!engines.length) {
    throw new Error('至少需要一个真实引擎；可通过 PROMPTX_REAL_ENGINES 指定。')
  }

  const missingEngines = engines.filter((engine) => !probeEngineVersion(engine))
  if (missingEngines.length > 0) {
    throw new Error(`以下真实引擎不可用: ${missingEngines.join(', ')}`)
  }

  const environment = await setupManagedEnvironment({
    externalWebBaseUrl: EXTERNAL_WEB_BASE_URL,
    externalApiBaseUrl: EXTERNAL_API_BASE_URL,
    tempPrefix: 'promptx-real-runner-',
    useFakeCodexBin: false,
    cwd: process.cwd(),
  })
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-real-runner-'))
  const created = []
  const runIds = []
  let browser = null

  try {
    if (environment.harness || SHOULD_SET_RUNNER_CONFIG) {
      await ensureRunnerConfig(environment.apiBaseUrl)
    }

    logEnv({
      apiBaseUrl: environment.apiBaseUrl,
      webBaseUrl: environment.webBaseUrl,
      managedServer: Boolean(environment.harness),
      managedWeb: Boolean(environment.webServer),
      engines,
      cliVersions: buildCliVersions(engines),
      maxConcurrentRuns: MAX_CONCURRENT_RUNS,
      taskCount: TASK_COUNT,
    })

    const initialDiagnostics = await fetchRuntimeDiagnostics(environment.apiBaseUrl)
    logInitial(initialDiagnostics)

    for (let index = 1; index <= TASK_COUNT; index += 1) {
      const engine = pickEngine(engines, index)
      created.push(await createTaskAndSession(environment.apiBaseUrl, workspaceRoot, index, engine))
      await sleep(150)
    }

    const launched = await createBrowserPage({ headless: HEADLESS, logPrefix: 'BROWSER' })
    browser = launched.browser
    logLine('BROWSER', launched.strategy)
    const { page } = launched

    await openTaskPage(page, environment.webBaseUrl, created[0].task.slug)

    for (const item of created) {
      const run = await sendTaskAndWaitForRun(page, environment.apiBaseUrl, item.task, {
        beforeSendDelayMs: 800,
        afterSendDelayMs: 1000,
        logLabel: 'SENT',
      })
      runIds.push(run.id)
    }

    let queuedSnapshot = null
    if (TASK_COUNT > MAX_CONCURRENT_RUNS) {
      const queuedState = await waitForQueuedRunsShape(environment.apiBaseUrl, created, runIds, {
        activeCount: MAX_CONCURRENT_RUNS,
        minQueued: 1,
        timeoutMs: START_TIMEOUT_MS,
        message: `未形成 ${MAX_CONCURRENT_RUNS} running + queued 的并发形态`,
      })
      queuedSnapshot = {
        ...getRunnerStats(queuedState.runtime),
        statuses: queuedState.statuses,
      }
      logJson('QUEUED', queuedSnapshot)
    }

    const stopAccepted = await stopActiveRuns(environment.apiBaseUrl, created, runIds)

    const finalSnapshot = await waitFor(async () => {
      const [tasksPayload, runtimePayload, runs, uiCards] = await Promise.all([
        requestJson(environment.apiBaseUrl, '/api/tasks'),
        fetchRuntimeDiagnostics(environment.apiBaseUrl),
        fetchRuns(environment.apiBaseUrl, created, runIds),
        collectUiCards(page, created.map((item) => item.task.title)),
      ])

      const taskRunning = buildTaskRunningMap(tasksPayload, created)

      const runSummary = summarizeRuns(created, runs)

      const snapshot = {
        ...getRunnerStats(runtimePayload),
        taskRunning,
        runSummary,
        uiCards,
      }

      logJson('SNAPSHOT', snapshot)

      if (runSummary.every((item) => isTerminalStatus(item.status))) {
        return snapshot
      }
      return null
    }, STOP_TIMEOUT_MS, '等待停止后的终态超时')

    const lost = finalSnapshot.runSummary.filter((item) => String(item.errorMessage || '').includes('Runner 已失联'))
    if (lost.length > 0) {
      throw new Error(`出现 Runner 已失联: ${JSON.stringify(lost)}`)
    }

    logFinal({
      queuedSnapshot,
      stopAccepted: stopAccepted.length,
      finalSnapshot,
    })
  } finally {
    await stopActiveRuns(environment.apiBaseUrl, created, runIds).catch(() => {})
    await browser?.close().catch(() => {})
    await environment.cleanup().catch(() => {})
    fs.rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  logFailure(error)
  process.exitCode = 1
})
