import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {
  createRunnerSplitHarness,
  waitFor,
} from '../../../scripts/lib/runnerSplitHarness.mjs'
import {
  HOST,
  ROOT_DIR,
  createBrowserPage,
  createTextBlock,
  createWorkspaceTaskAndSession,
  fetchRuns,
  fetchRuntimeDiagnostics,
  getRunnerStats,
  logFailure,
  logFinal,
  logInitial,
  logJson,
  logLine,
  openTaskPage,
  probeEngineVersion,
  sendTaskAndWaitForRun,
  summarizeRuns,
  stopActiveRuns,
  startWebServer,
  updateRunnerConfig,
  waitForQueuedRunsShape,
  waitForTerminalRuns,
} from './realRunnerShared.mjs'

const DEFAULT_ENGINE_BINS = {
  codex: process.env.CODEX_BIN || 'codex',
  'claude-code': process.env.CLAUDE_CODE_BIN || 'claude',
  opencode: process.env.OPENCODE_BIN || 'opencode',
}
const REQUESTED_ENGINES = String(process.env.PROMPTX_UI_HOT_UPDATE_ENGINES || '').trim()
const START_TIMEOUT_MS = Math.max(60_000, Number(process.env.PROMPTX_UI_HOT_UPDATE_START_TIMEOUT_MS) || 240_000)
const UPDATE_TIMEOUT_MS = Math.max(15_000, Number(process.env.PROMPTX_UI_HOT_UPDATE_UPDATE_TIMEOUT_MS) || 90_000)
const STOP_TIMEOUT_MS = Math.max(10_000, Number(process.env.PROMPTX_UI_HOT_UPDATE_STOP_TIMEOUT_MS) || 60_000)
const HEADLESS = !/^(0|false|no)$/i.test(String(process.env.PROMPTX_HEADLESS || 'true').trim())
const INITIAL_MAX_CONCURRENT_RUNS = Number(process.env.PROMPTX_UI_HOT_UPDATE_INITIAL_MAX_CONCURRENT_RUNS || 5)
const TARGET_MAX_CONCURRENT_RUNS = Number(process.env.PROMPTX_UI_HOT_UPDATE_TARGET_MAX_CONCURRENT_RUNS || 6)
const TASK_COUNT = Math.max(TARGET_MAX_CONCURRENT_RUNS, Number(process.env.PROMPTX_UI_HOT_UPDATE_TASK_COUNT || TARGET_MAX_CONCURRENT_RUNS))

process.chdir(ROOT_DIR)

function resolveEngines() {
  if (REQUESTED_ENGINES) {
    return REQUESTED_ENGINES
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
  }

  return Object.entries(DEFAULT_ENGINE_BINS)
    .filter(([engine]) => Boolean(probeEngineVersion(engine)))
    .map(([engine]) => engine)
}

function createLongTaskWorkspace(rootDir, engine, index) {
  const script = [
    "const fs = require('node:fs')",
    "const path = require('node:path')",
    "const pidFile = path.join(process.cwd(), 'long-runner.pid')",
    "const exitFile = path.join(process.cwd(), 'long-runner.exit.json')",
    "fs.writeFileSync(pidFile, String(process.pid))",
    'let count = 0',
    "console.log(`LONG_RUNNER_PID_${process.pid}`)",
    "console.log('LONG_RUNNER_START')",
    "const timer = setInterval(() => {",
    '  count += 1',
    "  console.log(`LONG_RUNNER_TICK_${count}`)",
    '}, 1000)',
    'function cleanup(reason) {',
    '  try {',
    "    fs.writeFileSync(exitFile, JSON.stringify({ pid: process.pid, reason, count, at: new Date().toISOString() }, null, 2))",
    '  } catch {}',
    '  clearInterval(timer)',
    '}',
    "process.on('SIGTERM', () => { cleanup('sigterm'); process.exit(0) })",
    "process.on('SIGINT', () => { cleanup('sigint'); process.exit(0) })",
    "setTimeout(() => { cleanup('completed'); console.log('LONG_RUNNER_DONE'); process.exit(0) }, 120000)",
  ].join('\n')
  return {
    workspaceName: `${engine}-ui-hot-update-${index}`,
    readme: `engine=${engine}\nscenario=ui-hot-update\nindex=${index}\n`,
    files: {
      'long-runner.js': script,
    },
  }
}

function buildLongRunPrompt(engine = 'codex') {
  if (engine === 'opencode') {
    return [
      'You are running a PromptX browser UI concurrency hot-update integration test.',
      'You must use the bash tool immediately.',
      'Run exactly this command and nothing else: node long-runner.js',
      'Do not read, summarize, or edit any file before running the command.',
      'Do not send any assistant text before the command exits naturally.',
      'After the command exits naturally, reply with exactly: LONG_RUNNER_DONE_ACK',
    ].join('\n')
  }

  if (engine === 'claude-code') {
    return [
      'You are running a PromptX browser UI concurrency hot-update integration test.',
      'Use the Bash tool immediately as your first and only tool action before the command exits.',
      'Run exactly this command and nothing else: node long-runner.js',
      'Do not read, summarize, search, or edit any file before running the command.',
      'After the command starts, keep waiting and do not stop it yourself.',
      'Do not send any assistant text before the command exits naturally.',
      'After the command exits naturally, reply with exactly: LONG_RUNNER_DONE_ACK',
    ].join('\n')
  }

  return [
    '你正在执行 PromptX 的浏览器 UI 并发热更新集成测试。',
    '不要先读文件，也不要先总结。',
    '你的第一步且唯一工具操作必须是执行：node long-runner.js',
    '启动后保持等待，不要主动停止它。',
    '不要修改任何文件。',
    '只有在命令自然结束后再回复。',
  ].join('\n')
}

async function createTaskAndSession(baseUrl, engine, cwd, index) {
  const stamp = `${Date.now()}-${index}`
  const title = `ui-hot-update-${engine}-${stamp}`
  return createWorkspaceTaskAndSession(baseUrl, {
    title,
    workspaceRoot: cwd.root,
    workspaceName: cwd.workspaceName,
    readme: cwd.readme,
    files: cwd.files,
    engine,
    blocks: [createTextBlock(buildLongRunPrompt(engine))],
  })
}

async function runScenario(engine) {
  const harness = await createRunnerSplitHarness({
    tempPrefix: `promptx-ui-hot-update-${engine}-`,
    useFakeCodexBin: false,
  })
  let webServer = null
  let browser = null
  let workspacesRoot = ''
  const created = []
  const runIds = []

  try {
    await updateRunnerConfig(harness.serverBaseUrl, {
      runner: {
        maxConcurrentRuns: INITIAL_MAX_CONCURRENT_RUNS,
      },
    })
    logInitial(await fetchRuntimeDiagnostics(harness.serverBaseUrl))

    webServer = await startWebServer(harness.serverBaseUrl, {
      cwd: process.cwd(),
      host: HOST,
    })
    workspacesRoot = fs.mkdtempSync(path.join(os.tmpdir(), `promptx-ui-hot-update-${engine}-`))
    for (let index = 1; index <= TASK_COUNT; index += 1) {
      const workspace = createLongTaskWorkspace(workspacesRoot, engine, index)
      created.push(await createTaskAndSession(
        harness.serverBaseUrl,
        engine,
        { root: workspacesRoot, ...workspace },
        index,
      ))
    }

    const launched = await createBrowserPage({
      headless: HEADLESS,
      logPrefix: `BROWSER_${engine}`,
    })
    browser = launched.browser
    logLine('BROWSER', engine, launched.strategy)
    const { page } = launched

    await openTaskPage(page, webServer.baseUrl, created[0].task.slug)

    for (const item of created) {
      const run = await sendTaskAndWaitForRun(page, harness.serverBaseUrl, item.task, {
        beforeSendDelayMs: 700,
        afterSendDelayMs: 900,
        logLabel: `SENT ${engine}`,
        message: `${engine} ${item.task.slug} 发送后未找到 run`,
      })
      runIds.push(run.id)
    }

    const queuedSnapshot = await waitForQueuedRunsShape(harness.serverBaseUrl, created, runIds, {
      activeCount: INITIAL_MAX_CONCURRENT_RUNS,
      minQueued: 1,
      timeoutMs: START_TIMEOUT_MS,
      message: `${engine} 未形成 ${INITIAL_MAX_CONCURRENT_RUNS} active + 1 queued`,
    })

    const queuedRunIndex = queuedSnapshot.statuses.findIndex((status) => status === 'queued')
    if (queuedRunIndex < 0) {
      throw new Error(`${engine} 未找到 queued run`)
    }

    await page.getByRole('button', { name: '设置' }).first().click()
    await page.locator('.settings-dialog-panel').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('button', { name: '系统' }).click()

    const maxConcurrentInput = page.locator('section').filter({ hasText: '真实 agent 最大并发数' }).locator('input[type="number"]').first()
    await maxConcurrentInput.waitFor({ state: 'visible', timeout: 30_000 })
    const beforeValue = await maxConcurrentInput.inputValue()
    if (beforeValue !== String(INITIAL_MAX_CONCURRENT_RUNS)) {
      throw new Error(`${engine} UI 中当前并发值不是 ${INITIAL_MAX_CONCURRENT_RUNS}，而是 ${beforeValue}`)
    }

    const hotUpdateStartedAt = Date.now()
    await maxConcurrentInput.fill(String(TARGET_MAX_CONCURRENT_RUNS))
    await page.getByRole('button', { name: '保存系统配置' }).click()
    await page.getByText('系统配置已保存，runner 并发上限已更新。').waitFor({ state: 'visible', timeout: 30_000 })

    const hotUpdateSnapshot = await waitFor(async () => {
      const runtime = await fetchRuntimeDiagnostics(harness.serverBaseUrl)
      const runs = await fetchRuns(harness.serverBaseUrl, created, runIds)
      const targetRun = runs[queuedRunIndex]
      if (
        ['starting', 'running'].includes(String(targetRun?.status || ''))
        && Number(runtime.runner?.runner?.activeRunCount || 0) >= TARGET_MAX_CONCURRENT_RUNS
        && Number(runtime.runner?.runner?.queuedRunCount || 0) === 0
      ) {
        return { runtime, runs }
      }
      return null
    }, UPDATE_TIMEOUT_MS, `${engine} 通过 UI 调大并发后 queued run 没有启动`)

    const afterValue = await maxConcurrentInput.inputValue()
    if (afterValue !== String(TARGET_MAX_CONCURRENT_RUNS)) {
      throw new Error(`${engine} UI 保存后并发值不是 ${TARGET_MAX_CONCURRENT_RUNS}，而是 ${afterValue}`)
    }

    const stopAccepted = await stopActiveRuns(harness.serverBaseUrl, created, runIds)

    const finalRuns = await waitForTerminalRuns(harness.serverBaseUrl, created, runIds, {
      timeoutMs: STOP_TIMEOUT_MS,
      message: `${engine} 停止后未全部进入终态`,
    })

    const finalRuntime = await fetchRuntimeDiagnostics(harness.serverBaseUrl)
    const runtimeBeforeUpdate = getRunnerStats(queuedSnapshot.runtime)
    const runtimeAfterUpdate = getRunnerStats(hotUpdateSnapshot.runtime)
    const finalRuntimeStats = getRunnerStats(finalRuntime)
    const hotUpdateDelayMs = Date.now() - hotUpdateStartedAt

    return {
      engine,
      beforeValue,
      afterValue,
      hotUpdateDelayMs,
      queuedRunId: runIds[queuedRunIndex],
      queuedBeforeUpdate: queuedSnapshot.statuses,
      statusesAfterUpdate: summarizeRuns(created, hotUpdateSnapshot.runs).map((run) => run.status),
      runtimeBeforeUpdate: {
        active: runtimeBeforeUpdate.runnerActive,
        tracked: runtimeBeforeUpdate.runnerTracked,
        queued: runtimeBeforeUpdate.runnerQueued,
      },
      runtimeAfterUpdate: {
        active: runtimeAfterUpdate.runnerActive,
        tracked: runtimeAfterUpdate.runnerTracked,
        queued: runtimeAfterUpdate.runnerQueued,
      },
      finalStatuses: summarizeRuns(created, finalRuns).map((run) => run.status),
      finalRuntime: {
        active: finalRuntimeStats.runnerActive,
        tracked: finalRuntimeStats.runnerTracked,
        queued: finalRuntimeStats.runnerQueued,
      },
      stopAccepted: stopAccepted.length,
    }
  } finally {
    await stopActiveRuns(harness.serverBaseUrl, created, runIds).catch(() => {})
    await browser?.close().catch(() => {})
    await webServer?.cleanup().catch(() => {})
    await harness.cleanup().catch(() => {})
    if (workspacesRoot) {
      fs.rmSync(workspacesRoot, { recursive: true, force: true })
    }
  }
}

async function main() {
  const engines = resolveEngines()
  if (!engines.length) {
    throw new Error('没有发现可用的真实 agent，可通过 PROMPTX_UI_HOT_UPDATE_ENGINES 指定。')
  }

  const results = []
  for (const engine of engines) {
    logLine('START', engine)
    const result = await runScenario(engine)
    results.push(result)
    logJson(`PASS ${engine}`, result)
  }

  logFinal({ results })
}

await main().catch((error) => {
  logFailure(error)
  process.exitCode = 1
})
