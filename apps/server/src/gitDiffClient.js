import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_STDERR_LENGTH = 4000

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const workerEntryPath = path.join(currentDir, 'gitDiffWorker.js')

let workerProcess = null
let workerStdoutBuffer = ''
let workerStderrBuffer = ''
let nextRequestId = 1
const pendingRequests = new Map()
const workerMetrics = {
  startedAt: new Date().toISOString(),
  spawnCount: 0,
  restartCount: 0,
  totalRequests: 0,
  completedRequests: 0,
  failedRequests: 0,
  timeoutRequests: 0,
  lastWorkerSpawnedAt: '',
  lastWorkerExitAt: '',
  lastWorkerExitCode: null,
  lastWorkerExitSignal: '',
  lastWorkerExitReason: '',
  lastRequest: null,
}

function createTimeoutError(timeoutMs) {
  const error = new Error(`git diff 计算超时（>${timeoutMs}ms）。`)
  error.code = 'GIT_DIFF_TIMEOUT'
  error.statusCode = 504
  return error
}

function createWorkerError(message = '') {
  const error = new Error(message || 'git diff 计算失败。')
  error.code = 'GIT_DIFF_FAILED'
  error.statusCode = 500
  return error
}

function resetWorkerBuffers() {
  workerStdoutBuffer = ''
  workerStderrBuffer = ''
}

function createLastRequestSnapshot(request = {}, patch = {}) {
  return {
    requestId: String(request.requestId || patch.requestId || '').trim(),
    taskSlug: String(request.taskSlug || patch.taskSlug || '').trim(),
    scope: String(request.scope || patch.scope || '').trim(),
    filePath: String(request.filePath || patch.filePath || '').trim(),
    startedAt: String(request.startedAt || patch.startedAt || '').trim(),
    finishedAt: String(patch.finishedAt || '').trim(),
    durationMs: Math.max(0, Number(patch.durationMs) || 0),
    status: String(patch.status || '').trim(),
    timeout: Boolean(patch.timeout),
    errorMessage: String(patch.errorMessage || '').trim(),
  }
}

function markLastRequest(request = {}, patch = {}) {
  workerMetrics.lastRequest = createLastRequestSnapshot(request, patch)
}

function appendWorkerStderr(chunk) {
  workerStderrBuffer = `${workerStderrBuffer}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')}`
  if (workerStderrBuffer.length > MAX_STDERR_LENGTH) {
    workerStderrBuffer = workerStderrBuffer.slice(-MAX_STDERR_LENGTH)
  }
}

function settlePendingRequest(requestId, handler) {
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return
  }

  pendingRequests.delete(requestId)
  clearTimeout(pending.timer)
  handler(pending)
}

function rejectAllPendingRequests(error) {
  for (const [requestId, pending] of pendingRequests.entries()) {
    pendingRequests.delete(requestId)
    clearTimeout(pending.timer)
    pending.reject(error)
  }
}

function detachWorkerListeners(child) {
  child.stdout?.removeAllListeners()
  child.stderr?.removeAllListeners()
  child.removeAllListeners()
}

function handleWorkerLine(line) {
  let payload
  try {
    payload = JSON.parse(line)
  } catch {
    rejectAllPendingRequests(
      createWorkerError(`git diff worker returned invalid JSON: ${line.slice(0, 200)}`)
    )
    stopGitDiffWorker()
    return
  }

  const requestId = String(payload?.requestId || '').trim()
  if (!requestId) {
    rejectAllPendingRequests(
      createWorkerError(String(payload?.error?.message || '').trim() || 'git diff worker returned a response without requestId.')
    )
    stopGitDiffWorker()
    return
  }

  settlePendingRequest(requestId, ({ resolve, reject }) => {
    if (!payload?.ok) {
      reject(createWorkerError(String(payload?.error?.message || '').trim() || workerStderrBuffer.trim()))
      return
    }
    resolve(payload.result)
  })
}

function handleWorkerStdout(chunk) {
  workerStdoutBuffer = `${workerStdoutBuffer}${Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '')}`

  let newlineIndex = workerStdoutBuffer.indexOf('\n')
  while (newlineIndex !== -1) {
    const line = workerStdoutBuffer.slice(0, newlineIndex).trim()
    workerStdoutBuffer = workerStdoutBuffer.slice(newlineIndex + 1)
    if (line) {
      handleWorkerLine(line)
    }
    newlineIndex = workerStdoutBuffer.indexOf('\n')
  }
}

function ensureGitDiffWorker() {
  if (workerProcess && !workerProcess.killed && workerProcess.exitCode === null) {
    return workerProcess
  }

  resetWorkerBuffers()
  if (workerMetrics.spawnCount > 0) {
    workerMetrics.restartCount += 1
  }
  const child = spawn(process.execPath, [workerEntryPath], {
    cwd: currentDir,
    env: {
      ...process.env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  workerMetrics.spawnCount += 1
  workerMetrics.lastWorkerSpawnedAt = new Date().toISOString()

  child.stdout?.on('data', handleWorkerStdout)
  child.stderr?.on('data', appendWorkerStderr)
  child.on('error', (error) => {
    workerMetrics.lastWorkerExitAt = new Date().toISOString()
    workerMetrics.lastWorkerExitCode = null
    workerMetrics.lastWorkerExitSignal = ''
    workerMetrics.lastWorkerExitReason = String(error?.message || error || 'worker error')
    rejectAllPendingRequests(createWorkerError(String(error?.message || error)))
    if (workerProcess === child) {
      workerProcess = null
    }
    detachWorkerListeners(child)
  })
  child.on('close', (code, signal) => {
    const tail = workerStderrBuffer.trim()
    workerMetrics.lastWorkerExitAt = new Date().toISOString()
    workerMetrics.lastWorkerExitCode = typeof code === 'number' ? code : null
    workerMetrics.lastWorkerExitSignal = String(signal || '').trim()
    workerMetrics.lastWorkerExitReason = tail || (signal ? `signal:${signal}` : `code:${code}`)
    rejectAllPendingRequests(
      tail
        ? createWorkerError(`git diff worker exited unexpectedly: ${tail}`)
        : createWorkerError('git diff worker exited unexpectedly.')
    )
    if (workerProcess === child) {
      workerProcess = null
    }
    detachWorkerListeners(child)
    resetWorkerBuffers()
  })

  workerProcess = child
  return child
}

export function stopGitDiffWorker() {
  if (!workerProcess) {
    return
  }

  const child = workerProcess
  workerProcess = null
  rejectAllPendingRequests(createWorkerError('git diff worker stopped.'))
  detachWorkerListeners(child)
  resetWorkerBuffers()

  if (child.exitCode === null && !child.killed) {
    child.kill()
  }
}

export function getTaskGitDiffReviewInSubprocess(taskSlug = '', options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS)
  const requestId = String(nextRequestId++)
  const requestMeta = {
    requestId,
    taskSlug: String(taskSlug || '').trim(),
    scope: String(options.scope || '').trim(),
    filePath: String(options.filePath || '').trim(),
    startedAt: new Date().toISOString(),
  }
  const child = ensureGitDiffWorker()
  workerMetrics.totalRequests += 1

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId)
      workerMetrics.timeoutRequests += 1
      workerMetrics.failedRequests += 1
      markLastRequest(requestMeta, {
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(requestMeta.startedAt),
        status: 'timeout',
        timeout: true,
        errorMessage: `git diff request timed out after ${timeoutMs}ms`,
      })
      stopGitDiffWorker()
      reject(createTimeoutError(timeoutMs))
    }, timeoutMs)

    pendingRequests.set(requestId, {
      resolve: (value) => {
        workerMetrics.completedRequests += 1
        markLastRequest(requestMeta, {
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(requestMeta.startedAt),
          status: 'completed',
        })
        resolve(value)
      },
      reject: (error) => {
        workerMetrics.failedRequests += 1
        markLastRequest(requestMeta, {
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(requestMeta.startedAt),
          status: error?.code === 'GIT_DIFF_TIMEOUT' ? 'timeout' : 'failed',
          timeout: error?.code === 'GIT_DIFF_TIMEOUT',
          errorMessage: String(error?.message || error || 'git diff request failed'),
        })
        reject(error)
      },
      timer,
    })

    try {
      child.stdin?.write(`${JSON.stringify({
        requestId,
        action: 'getTaskGitDiffReview',
        taskSlug: String(taskSlug || '').trim(),
        options,
      })}\n`)
    } catch (error) {
      settlePendingRequest(requestId, ({ reject: rejectPending }) => {
        rejectPending(createWorkerError(String(error?.message || error)))
      })
      stopGitDiffWorker()
    }
  })
}

export function __getGitDiffWorkerPidForTest() {
  return Number(workerProcess?.pid || 0)
}

export function getGitDiffWorkerDiagnostics() {
  return {
    worker: {
      pid: Number(workerProcess?.pid || 0),
      running: Boolean(workerProcess && !workerProcess.killed && workerProcess.exitCode === null),
      pendingRequests: pendingRequests.size,
      stderrTail: workerStderrBuffer.trim(),
    },
    metrics: {
      ...workerMetrics,
      lastWorkerExitSignal: String(workerMetrics.lastWorkerExitSignal || ''),
      lastWorkerExitReason: String(workerMetrics.lastWorkerExitReason || ''),
      lastRequest: workerMetrics.lastRequest ? { ...workerMetrics.lastRequest } : null,
    },
  }
}

process.once('exit', () => {
  stopGitDiffWorker()
})
