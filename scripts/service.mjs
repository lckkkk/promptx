import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { resolvePromptxPaths } from '../apps/server/src/appPaths.js'

const DEFAULT_SERVER_PORT = 9301
const DEFAULT_RUNNER_PORT = 9303
const DEFAULT_HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 250
const PLANNED_RESTART_GRACE_MS = Math.max(15_000, Number(process.env.PROMPTX_PLANNED_RESTART_GRACE_MS) || 45_000)

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webDistDir = path.join(rootDir, 'apps', 'web', 'dist')
const webIndexPath = path.join(webDistDir, 'index.html')
const serverEntryPath = path.join(rootDir, 'apps', 'server', 'src', 'index.js')
const runnerEntryPath = path.join(rootDir, 'apps', 'runner', 'src', 'index.js')

function ensureRuntimeDir() {
  const { promptxHomeDir } = resolvePromptxPaths()
  const runtimeDir = path.join(promptxHomeDir, 'run')
  fs.mkdirSync(runtimeDir, { recursive: true })
  return runtimeDir
}

function getRuntimePaths() {
  const runtimeDir = ensureRuntimeDir()
  return {
    runtimeDir,
    stateFile: path.join(runtimeDir, 'service.json'),
    plannedRestartFile: path.join(runtimeDir, 'planned-restart.json'),
    serverLogFile: path.join(runtimeDir, 'server.log'),
    runnerLogFile: path.join(runtimeDir, 'runner.log'),
  }
}

function writePlannedRestartMarker() {
  const { plannedRestartFile } = getRuntimePaths()
  const payload = {
    reason: 'planned-restart',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + PLANNED_RESTART_GRACE_MS).toISOString(),
  }
  fs.writeFileSync(plannedRestartFile, JSON.stringify(payload, null, 2))
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function removeRuntimeFiles() {
  const { stateFile } = getRuntimePaths()
  fs.rmSync(stateFile, { force: true })
}

function getServiceState() {
  const { stateFile, serverLogFile, runnerLogFile } = getRuntimePaths()
  const state = readJsonFile(stateFile) || {}
  const serverPid = Number(state?.server?.pid || 0)
  const runnerPid = Number(state?.runner?.pid || 0)
  const serverRunning = isProcessAlive(serverPid)
  const runnerRunning = isProcessAlive(runnerPid)

  if (!serverRunning && !runnerRunning) {
    removeRuntimeFiles()
    return {
      running: false,
      server: null,
      runner: null,
      serverLogFile,
      runnerLogFile,
    }
  }

  return {
    running: serverRunning || runnerRunning,
    server: serverRunning ? state.server : null,
    runner: runnerRunning ? state.runner : null,
    serverLogFile,
    runnerLogFile,
  }
}

function getBaseUrl(host, port) {
  return `http://${host}:${port}`
}

async function waitForHealth(baseUrl, pid, label) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  const healthUrl = `${baseUrl}/health`

  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      throw new Error(`${label} 进程启动后很快退出。`)
    }

    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        return
      }
    } catch {
      // Ignore until timeout.
    }

    await delay(POLL_INTERVAL_MS)
  }

  throw new Error(`等待 ${label} 启动超时。`)
}

async function checkHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`)
    return response.ok
  } catch {
    return false
  }
}

function tailLog(filePath, maxLines = 30) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/)
    return lines.slice(-maxLines).join('\n').trim()
  } catch {
    return ''
  }
}

function spawnDetached(entryPath, env, logFile) {
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [entryPath], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      ...env,
    },
  })
  fs.closeSync(logFd)
  child.unref()
  return child
}

async function stopPid(pid) {
  if (!isProcessAlive(pid)) {
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error
    }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return
    }
    await delay(POLL_INTERVAL_MS)
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Ignore when process already exited.
  }
}

async function startService() {
  if (!fs.existsSync(webIndexPath)) {
    throw new Error('没有找到前端构建产物，请先运行 `pnpm build`。')
  }

  const existing = getServiceState()
  if (existing.running) {
    if (existing.server && existing.runner) {
      console.log(`[promptx] Server 已在运行：${getBaseUrl(existing.server.host, existing.server.port)}（PID ${existing.server.pid}）`)
      console.log(`[promptx] Runner 已在运行：${getBaseUrl(existing.runner.host, existing.runner.port)}（PID ${existing.runner.pid}）`)
      return
    }

    console.log('[promptx] 检测到服务处于半启动状态，先执行一次清理重启。')
    await stopService()
  }

  const { stateFile, serverLogFile, runnerLogFile } = getRuntimePaths()
  const host = String(process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
  const serverPort = Math.max(1, Number(process.env.PORT || process.env.PROMPTX_SERVER_PORT) || DEFAULT_SERVER_PORT)
  const runnerPort = Math.max(1, Number(process.env.RUNNER_PORT || process.env.PROMPTX_RUNNER_PORT) || DEFAULT_RUNNER_PORT)
  const serverBaseUrl = getBaseUrl(host, serverPort)
  const runnerBaseUrl = getBaseUrl(host, runnerPort)
  const startedAt = new Date().toISOString()

  if (await checkHealth(serverBaseUrl)) {
    throw new Error(`检测到 ${serverBaseUrl} 已有服务在运行，请先释放端口或改用其他端口。`)
  }
  if (await checkHealth(runnerBaseUrl)) {
    throw new Error(`检测到 ${runnerBaseUrl} 已有 runner 在运行，请先释放端口或改用其他端口。`)
  }

  const runner = spawnDetached(runnerEntryPath, {
    HOST: host,
    RUNNER_PORT: String(runnerPort),
    PROMPTX_RUNNER_PORT: String(runnerPort),
    PROMPTX_SERVER_PORT: String(serverPort),
    PROMPTX_SERVER_BASE_URL: serverBaseUrl,
  }, runnerLogFile)

  try {
    await waitForHealth(runnerBaseUrl, runner.pid, 'runner')
  } catch (error) {
    await stopPid(runner.pid).catch(() => {})
    removeRuntimeFiles()
    const recentLog = tailLog(runnerLogFile)
    throw new Error([
      error.message || 'runner 启动失败。',
      recentLog ? `最近 runner 日志：\n${recentLog}` : '',
    ].filter(Boolean).join('\n\n'))
  }

  const server = spawnDetached(serverEntryPath, {
    HOST: host,
    PORT: String(serverPort),
    PROMPTX_SERVER_PORT: String(serverPort),
    PROMPTX_RUNNER_PORT: String(runnerPort),
    PROMPTX_RUNNER_BASE_URL: runnerBaseUrl,
  }, serverLogFile)

  try {
    await waitForHealth(serverBaseUrl, server.pid, 'server')
    await delay(300)
    fs.writeFileSync(stateFile, JSON.stringify({
      startedAt,
      server: {
        pid: server.pid,
        host,
        port: serverPort,
      },
      runner: {
        pid: runner.pid,
        host,
        port: runnerPort,
      },
      serverLogFile,
      runnerLogFile,
    }, null, 2))
  } catch (error) {
    await stopPid(server.pid).catch(() => {})
    await stopPid(runner.pid).catch(() => {})
    removeRuntimeFiles()
    const serverLog = tailLog(serverLogFile)
    const runnerLog = tailLog(runnerLogFile)
    throw new Error([
      error.message || 'server 启动失败。',
      serverLog ? `最近 server 日志：\n${serverLog}` : '',
      runnerLog ? `最近 runner 日志：\n${runnerLog}` : '',
    ].filter(Boolean).join('\n\n'))
  }

  console.log(`[promptx] Server 已后台启动：${serverBaseUrl}`)
  console.log(`[promptx] Runner 已后台启动：${runnerBaseUrl}`)
  console.log(`[promptx] Server 日志：${serverLogFile}`)
  console.log(`[promptx] Runner 日志：${runnerLogFile}`)
}

async function stopService() {
  const current = getServiceState()
  if (!current.running) {
    console.log('[promptx] 当前没有运行中的服务。')
    return
  }

  await Promise.all([
    current.server?.pid ? stopPid(current.server.pid) : Promise.resolve(),
    current.runner?.pid ? stopPid(current.runner.pid) : Promise.resolve(),
  ])

  removeRuntimeFiles()
  console.log('[promptx] Server 和 runner 已停止。')
}

async function restartService() {
  writePlannedRestartMarker()
  await stopService()
  await startService()
}

function printStatus() {
  const current = getServiceState()
  if (!current.running) {
    console.log('[promptx] 服务未运行。')
    return
  }

  if (current.server) {
    console.log(`[promptx] Server：${getBaseUrl(current.server.host, current.server.port)}（PID ${current.server.pid}）`)
    console.log(`[promptx] Server 日志：${current.serverLogFile}`)
  } else {
    console.log('[promptx] Server：未运行')
  }

  if (current.runner) {
    console.log(`[promptx] Runner：${getBaseUrl(current.runner.host, current.runner.port)}（PID ${current.runner.pid}）`)
    console.log(`[promptx] Runner 日志：${current.runnerLogFile}`)
  } else {
    console.log('[promptx] Runner：未运行')
  }
}

async function main() {
  const command = String(process.argv[2] || 'status').trim()

  if (command === 'start') {
    await startService()
    return
  }

  if (command === 'stop') {
    await stopService()
    return
  }

  if (command === 'status') {
    printStatus()
    return
  }

  if (command === 'restart') {
    await restartService()
    return
  }

  throw new Error(`不支持的命令：${command}`)
}

main().catch((error) => {
  console.error(`[promptx] ${error.message || error}`)
  process.exitCode = 1
})
