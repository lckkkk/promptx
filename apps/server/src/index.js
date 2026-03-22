import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { Jimp } from 'jimp'
import { nanoid } from 'nanoid'
import {
  EXPIRY_OPTIONS,
  VISIBILITY_OPTIONS,
  normalizeCodexRunEventsMode,
} from '../../../packages/shared/src/index.js'
import {
  buildTaskExports,
  canEditTask,
  clearTaskCodexSessionReferences,
  createTask,
  deleteTask,
  getTaskBySlug,
  listAutomationEnabledTasks,
  listTasks,
  purgeExpiredTasks,
  updateTaskAutomationRuntime,
  updateTaskCodexSession,
  updateTaskNotificationDelivery,
  updateTask,
} from './repository.js'
import {
  getWorkspaceGitDiffStatusSummaryByCwd,
} from './gitDiff.js'
import {
  getGitDiffWorkerDiagnostics,
  getTaskGitDiffReviewInSubprocess,
} from './gitDiffClient.js'
import {
  createPromptxCodexSession,
  deletePromptxCodexSession,
  getPromptxCodexSessionById,
  listPromptxCodexSessions,
  updatePromptxCodexSession,
} from './codexSessions.js'
import {
  createCodexRun,
  deleteTaskCodexRuns,
  getCodexRunById,
  getRunningCodexRunBySessionId,
  getRunningCodexRunByTaskSlug,
  isActiveRunStatus,
  listCodexRunEvents,
  listRunningCodexSessionIds,
  listRunningCodexTaskSlugs,
  listTaskCodexRunsWithOptions,
  updateCodexRunFromRunnerStatus,
} from './codexRuns.js'
import { listAvailableAgentEngines, listKnownWorkspacesByEngine } from './agents/index.js'
import { importPdfBlocks } from './pdf.js'
import { createTempFilePath, normalizeUploadFileName } from './upload.js'
import {
  listDirectoryPickerTree,
  listWorkspaceTree,
  searchDirectoryPickerEntries,
  searchWorkspaceEntries,
} from './workspaceFiles.js'
import { ensurePromptxStorageReady, serverRootDir } from './appPaths.js'
import { createRelayClient } from './relayClient.js'
import { getRelayConfigForClient, isRelayConfigManagedByEnv, writeStoredRelayConfig } from './relayConfig.js'
import { createSseHub } from './sseHub.js'
import { createTaskAutomationService } from './taskAutomation.js'
import { createRunnerClient } from './runnerClient.js'
import { assertInternalRequest } from './internalAuth.js'
import { createRunEventIngestService } from './runEventIngest.js'
import { createRunRecoveryService } from './runRecovery.js'
import { createMaintenanceService } from './maintenance.js'

const app = Fastify({ logger: true })
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
const { tmpDir, uploadsDir } = ensurePromptxStorageReady()
const workspaceRootDir = path.resolve(serverRootDir, '..', '..')
const workspaceParentDir = path.dirname(workspaceRootDir)
const webDistDir = path.resolve(serverRootDir, '..', 'web', 'dist')
const webIndexFile = path.join(webDistDir, 'index.html')
const hasBuiltWebApp = fs.existsSync(webIndexFile)
const packageJsonPath = path.resolve(workspaceRootDir, 'package.json')

function readPromptxVersion() {
  try {
    const payload = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    return String(payload.version || '').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const promptxVersion = readPromptxVersion()
const relayConfig = getRelayConfigForClient()
const relayClient = createRelayClient({
  logger: app.log,
  appVersion: promptxVersion,
  localBaseUrl: process.env.PROMPTX_RELAY_LOCAL_BASE_URL || `http://127.0.0.1:${port}`,
  ...relayConfig,
})
const runnerClient = createRunnerClient()

let lastExpiredPurgeAt = 0
const sseHub = createSseHub()
const localServerBaseUrl = process.env.PROMPTX_RELAY_LOCAL_BASE_URL || `http://127.0.0.1:${port}`
const publicServerBaseUrl = String(
  process.env.PROMPTX_PUBLIC_URL
  || relayConfig?.relayUrl
  || localServerBaseUrl
).trim().replace(/\/+$/, '')

function broadcastServerEvent(type, payload = {}) {
  sseHub.broadcast(type, payload)
}

const runEventIngestService = createRunEventIngestService({
  broadcastServerEvent,
})

function updateTaskAutomationRuntimeWithBroadcast(taskSlug, patch = {}) {
  const task = updateTaskAutomationRuntime(taskSlug, patch)
  if (task) {
    broadcastServerEvent('tasks.changed', {
      taskSlug,
      reason: 'automation-updated',
    })
  }
  return task
}

function updateTaskNotificationDeliveryWithBroadcast(taskSlug, patch = {}) {
  const task = updateTaskNotificationDelivery(taskSlug, patch)
  if (task) {
    broadcastServerEvent('tasks.changed', {
      taskSlug,
      reason: 'notification-updated',
    })
  }
  return task
}

function getRunningSessionIdSet() {
  return new Set(listRunningCodexSessionIds())
}

function decorateCodexSession(session, runningSessionIds = getRunningSessionIdSet()) {
  if (!session) {
    return null
  }

  return {
    ...session,
    running: runningSessionIds.has(session.id),
  }
}

function decorateCodexSessionList(items = []) {
  const runningSessionIds = getRunningSessionIdSet()
  return items.map((item) => decorateCodexSession(item, runningSessionIds))
}

function getRunningTaskSlugSet() {
  return new Set(listRunningCodexTaskSlugs())
}

function decorateTask(task, runningTaskSlugs = getRunningTaskSlugSet()) {
  if (!task) {
    return null
  }

  return {
    ...task,
    running: runningTaskSlugs.has(task.slug),
  }
}

function decorateTaskList(items = []) {
  const runningTaskSlugs = getRunningTaskSlugSet()
  return items.map((item) => decorateTask(item, runningTaskSlugs))
}

function createEmptyWorkspaceDiffSummary() {
  return {
    supported: false,
    fileCount: 0,
    additions: 0,
    deletions: 0,
    statsComplete: false,
  }
}

function toWorkspaceDiffSummary(payload = null) {
  if (!payload?.supported) {
    return createEmptyWorkspaceDiffSummary()
  }

  return {
    supported: true,
    fileCount: Math.max(0, Number(payload.summary?.fileCount) || 0),
    additions: Math.max(0, Number(payload.summary?.additions) || 0),
    deletions: Math.max(0, Number(payload.summary?.deletions) || 0),
    statsComplete: Boolean(payload.summary?.statsComplete),
  }
}

function attachTaskWorkspaceDiffSummaries(items = []) {
  const summaryByWorkspaceKey = new Map()
  const emptySummary = createEmptyWorkspaceDiffSummary()

  return items.map((task) => {
    const sessionId = String(task?.codexSessionId || '').trim()
    if (!sessionId) {
      return {
        ...task,
        workspaceDiffSummary: emptySummary,
      }
    }

    const session = getPromptxCodexSessionById(sessionId)
    const workspaceKey = String(session?.cwd || sessionId).trim()
    if (!summaryByWorkspaceKey.has(workspaceKey)) {
      const payload = session?.cwd ? getWorkspaceGitDiffStatusSummaryByCwd(session.cwd) : null
      summaryByWorkspaceKey.set(workspaceKey, toWorkspaceDiffSummary(payload))
    }

    return {
      ...task,
      workspaceDiffSummary: summaryByWorkspaceKey.get(workspaceKey) || emptySummary,
    }
  })
}

function listTaskWorkspaceDiffSummaries(limit = 30) {
  return attachTaskWorkspaceDiffSummaries(listTasks(limit)).map((task) => ({
    slug: String(task?.slug || '').trim(),
    workspaceDiffSummary: task?.workspaceDiffSummary || createEmptyWorkspaceDiffSummary(),
  }))
}

function buildTaskDetailUrl(taskSlug = '', options = {}) {
  const normalizedSlug = String(taskSlug || '').trim()
  if (!normalizedSlug) {
    return publicServerBaseUrl || localServerBaseUrl
  }

  if (options.raw) {
    return `${localServerBaseUrl}/api/tasks/${normalizedSlug}/raw`
  }

  return `${publicServerBaseUrl || localServerBaseUrl}/?task=${encodeURIComponent(normalizedSlug)}`
}

async function startTaskRunForTask({ taskSlug = '', sessionId = '', prompt = '', promptBlocks = [] } = {}) {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  const normalizedSessionId = String(sessionId || '').trim()
  const normalizedPrompt = String(prompt || '').trim()

  if (!normalizedTaskSlug) {
    throw new Error('任务不存在。')
  }
  if (!normalizedSessionId) {
    throw new Error('请先选择一个 PromptX 项目。')
  }
  if (!normalizedPrompt) {
    throw new Error('没有可发送的提示词。')
  }

  const task = getTaskBySlug(normalizedTaskSlug)
  if (!task || task.expired) {
    throw new Error('任务不存在。')
  }

  const session = getPromptxCodexSessionById(normalizedSessionId)
  if (!session) {
    throw new Error('没有找到对应的 PromptX 项目。')
  }

  const runningRunOnSession = getRunningCodexRunBySessionId(normalizedSessionId)
  if (runningRunOnSession) {
    throw new Error('当前项目正在执行中，请等待完成后再发送。')
  }

  const runRecord = createCodexRun({
    taskSlug: normalizedTaskSlug,
    sessionId: normalizedSessionId,
    prompt: normalizedPrompt,
    promptBlocks: Array.isArray(promptBlocks) ? promptBlocks : [],
    status: 'queued',
  })

  updateTaskCodexSession(normalizedTaskSlug, normalizedSessionId)

  try {
    await runnerClient.startRun({
      runId: runRecord.id,
      taskSlug: normalizedTaskSlug,
      sessionId: normalizedSessionId,
      engine: session.engine,
      prompt: normalizedPrompt,
      promptBlocks: Array.isArray(promptBlocks) ? promptBlocks : [],
      cwd: session.cwd,
      title: session.title,
      codexThreadId: session.codexThreadId,
      engineSessionId: session.engineSessionId,
      engineThreadId: session.engineThreadId,
      engineMeta: session.engineMeta,
      sessionCreatedAt: session.createdAt,
      sessionUpdatedAt: session.updatedAt,
    })
    updateCodexRunFromRunnerStatus(runRecord.id, {
      status: 'starting',
      startedAt: new Date().toISOString(),
    })
  } catch (error) {
    const failedRun = updateCodexRunFromRunnerStatus(runRecord.id, {
      status: 'error',
      errorMessage: error.message || 'Runner 启动失败。',
      finishedAt: new Date().toISOString(),
    })
    broadcastServerEvent('runs.changed', {
      taskSlug: normalizedTaskSlug,
      runId: failedRun?.id || runRecord.id,
    })
    throw error
  }

  broadcastServerEvent('tasks.changed', {
    taskSlug: normalizedTaskSlug,
    reason: 'session-linked',
  })
  broadcastServerEvent('runs.changed', {
    taskSlug: normalizedTaskSlug,
    runId: runRecord.id,
  })
  broadcastServerEvent('sessions.changed', {
    sessionId: normalizedSessionId,
  })

  return {
    run: getCodexRunById(runRecord.id),
    session: decorateCodexSession(getPromptxCodexSessionById(normalizedSessionId)),
  }
}

const taskAutomationService = createTaskAutomationService({
  logger: app.log,
  getRunningCodexRunByTaskSlug,
  listAutomationEnabledTasks,
  updateTaskAutomationRuntime: updateTaskAutomationRuntimeWithBroadcast,
  updateTaskNotificationDelivery: updateTaskNotificationDeliveryWithBroadcast,
  createTaskRun: async (payload) => startTaskRunForTask(payload),
  getTaskBySlug,
  getRunById: getCodexRunById,
  detailUrlBuilder: buildTaskDetailUrl,
})

const runRecoveryService = createRunRecoveryService({
  logger: app.log,
  broadcastServerEvent,
  onRecoveredRun(run) {
    taskAutomationService.notifyRun(run.taskSlug, run.id).catch(() => {})
  },
})
const maintenanceService = createMaintenanceService({
  logger: app.log,
  tmpDir,
})

async function fetchRunnerDiagnostics() {
  try {
    const payload = await runnerClient.getDiagnostics()
    return {
      ok: true,
      baseUrl: runnerClient.baseUrl,
      runner: payload.runner || null,
    }
  } catch (error) {
    return {
      ok: false,
      baseUrl: runnerClient.baseUrl,
      message: String(error?.message || error || '无法读取 runner diagnostics'),
    }
  }
}

function buildServerAccessUrls(hostname, currentPort) {
  const normalizedHost = String(hostname || '').trim()

  if (!normalizedHost || normalizedHost === '0.0.0.0' || normalizedHost === '::' || normalizedHost === '127.0.0.1') {
    return [`本机: http://127.0.0.1:${currentPort}`]
  }

  if (normalizedHost === 'localhost') {
    return [`本机: http://localhost:${currentPort}`]
  }

  return [`访问地址: http://${normalizedHost}:${currentPort}`]
}

function resolveUploadPath(assetPath = '') {
  const normalized = String(assetPath || '').replace(/^\/+/, '')
  if (!normalized.startsWith('uploads/')) {
    return null
  }

  const absolutePath = path.resolve(process.cwd(), normalized)
  return absolutePath.startsWith(`${uploadsDir}${path.sep}`) ? absolutePath : null
}

function removeAssetFiles(assetPaths = []) {
  const uniquePaths = [...new Set(assetPaths)]
  uniquePaths.forEach((assetPath) => {
    const targetPath = resolveUploadPath(assetPath)
    if (targetPath) {
      fs.rmSync(targetPath, { force: true })
    }
  })
}

function purgeExpiredContent(force = false) {
  const now = Date.now()
  if (!force && now - lastExpiredPurgeAt < 60 * 1000) {
    return
  }

  lastExpiredPurgeAt = now
  const result = purgeExpiredTasks(new Date(now).toISOString())
  if (result.removedAssets.length) {
    removeAssetFiles(result.removedAssets)
  }
}

function listSiblingWorkspaceDirs(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return []
  }

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(baseDir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function listWorkspaceSuggestions(limit = 24, engine = 'codex') {
  const seen = new Set()
  const suggestions = []

  const addPath = (targetPath) => {
    const value = String(targetPath || '').trim()
    if (!value || seen.has(value) || !fs.existsSync(value)) {
      return
    }

    try {
      if (!fs.statSync(value).isDirectory()) {
        return
      }
    } catch {
      return
    }

    seen.add(value)
    suggestions.push(value)
  }

  addPath(workspaceRootDir)
  listSiblingWorkspaceDirs(workspaceParentDir).forEach(addPath)
  listPromptxCodexSessions(limit).forEach((session) => addPath(session.cwd))
  listKnownWorkspacesByEngine(engine, limit * 2).forEach(addPath)

  return suggestions.slice(0, Math.max(1, Number(limit) || 24))
}

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
})

await app.register(multipart, {
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
  },
})

app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (request, body, done) => {
    done(null, {})
  }
)

await app.register(fastifyStatic, {
  root: uploadsDir,
  prefix: '/uploads/',
})

if (hasBuiltWebApp) {
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
    index: false,
  })
}

app.get('/health', async () => ({ ok: true }))

app.post('/internal/runner-events', async (request, reply) => {
  try {
    assertInternalRequest(request.headers)
    return runEventIngestService.ingestEvents(request.body?.items || [])
  } catch (error) {
    return reply.code(error.statusCode || 400).send({
      message: error.message || 'Runner 事件写入失败。',
    })
  }
})

app.post('/internal/runner-status', async (request, reply) => {
  try {
    assertInternalRequest(request.headers)
    const run = runEventIngestService.ingestStatus(request.body || {})
    if (!run) {
      return reply.code(404).send({ message: '没有找到对应的运行记录。' })
    }

    if (run.completed) {
      taskAutomationService.notifyRun(run.taskSlug, run.id).catch(() => {})
    }

    return {
      ok: true,
      run,
    }
  } catch (error) {
    return reply.code(error.statusCode || 400).send({
      message: error.message || 'Runner 状态写入失败。',
    })
  }
})

app.get('/api/meta', async () => ({
  version: promptxVersion,
  expiryOptions: EXPIRY_OPTIONS,
  visibilityOptions: VISIBILITY_OPTIONS,
  agentEngineOptions: listAvailableAgentEngines(),
}))

app.get('/api/relay/status', async () => ({
  relay: relayClient.getStatus(),
}))

app.get('/api/diagnostics/git-diff-worker', async () => ({
  gitDiffWorker: getGitDiffWorkerDiagnostics(),
}))

app.get('/api/diagnostics/runtime', async () => ({
  runner: await fetchRunnerDiagnostics(),
  gitDiffWorker: getGitDiffWorkerDiagnostics(),
  recovery: runRecoveryService.getDiagnostics(),
  maintenance: maintenanceService.getDiagnostics(),
}))

app.post('/api/diagnostics/maintenance/run', async () => ({
  maintenance: maintenanceService.runCleanup(),
}))

app.get('/api/relay/config', async () => ({
  config: {
    ...getRelayConfigForClient(),
  },
  managedByEnv: isRelayConfigManagedByEnv(),
  relay: relayClient.getStatus(),
}))

app.put('/api/relay/config', async (request) => {
  const savedConfig = writeStoredRelayConfig(request.body || {})
  relayClient.updateConfig({
    ...savedConfig,
    localBaseUrl: process.env.PROMPTX_RELAY_LOCAL_BASE_URL || `http://127.0.0.1:${port}`,
  })

  return {
    config: getRelayConfigForClient(),
    managedByEnv: isRelayConfigManagedByEnv(),
    relay: relayClient.getStatus(),
  }
})

app.get('/api/events/stream', async (request, reply) => {
  reply.hijack()
  const requestOrigin = request.headers.origin
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(requestOrigin ? {
      'Access-Control-Allow-Origin': requestOrigin,
      Vary: 'Origin',
    } : {}),
  })
  reply.raw.socket?.setNoDelay?.(true)
  reply.raw.flushHeaders?.()

  const removeClient = sseHub.addClient(reply.raw)
  sseHub.write(reply.raw, {
    type: 'ready',
    sentAt: new Date().toISOString(),
  })

  const handleClose = () => {
    removeClient()
  }

  reply.raw.on('close', handleClose)
})

app.get('/api/tasks', async () => {
  purgeExpiredContent()
  return {
    items: decorateTaskList(listTasks()),
  }
})

app.get('/api/tasks/workspace-diff-summaries', async (request) => {
  purgeExpiredContent()
  return {
    items: listTaskWorkspaceDiffSummaries(request.query?.limit),
  }
})

app.post('/api/tasks', async (request, reply) => {
  purgeExpiredContent()
  let task
  try {
    task = createTask(request.body || {})
  } catch (error) {
    return reply.code(400).send({ message: error.message || '任务创建失败。' })
  }
  broadcastServerEvent('tasks.changed', {
    taskSlug: task.slug,
    reason: 'created',
  })
  return reply.code(201).send(decorateTask(task))
})

app.get('/api/tasks/:slug', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task) {
    return reply.code(404).send({ message: '任务不存在。' })
  }
  if (task.expired) {
    return reply.code(410).send({ message: '任务已过期。' })
  }

  return {
    ...decorateTask(task),
    canEdit: canEditTask(request.params.slug),
  }
})

app.put('/api/tasks/:slug', async (request, reply) => {
  purgeExpiredContent()
  let result
  try {
    result = updateTask(request.params.slug, request.body || {})
  } catch (error) {
    return reply.code(400).send({ message: error.message || '任务更新失败。' })
  }
  if (result.error === 'not_found') {
    return reply.code(404).send({ message: '任务不存在。' })
  }
  broadcastServerEvent('tasks.changed', {
    taskSlug: request.params.slug,
    reason: 'updated',
  })
  return decorateTask(result)
})

app.delete('/api/tasks/:slug', async (request, reply) => {
  purgeExpiredContent()
  if (getRunningCodexRunByTaskSlug(request.params.slug)) {
    return reply.code(409).send({ message: '当前任务正在执行中，请先停止后再删除。' })
  }
  const result = deleteTask(request.params.slug)
  if (result.error === 'not_found') {
    return reply.code(404).send({ message: '任务不存在。' })
  }
  removeAssetFiles(result.removedAssets)
  broadcastServerEvent('tasks.changed', {
    taskSlug: request.params.slug,
    reason: 'deleted',
  })
  return reply.code(204).send()
})

app.post('/api/tasks/:slug/codex-session', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  const sessionId = String(request.body?.sessionId || '').trim()
  const taskSessionLocked = Boolean(task.codexSessionId && Number(task.codexRunCount || 0) > 0)
  if (taskSessionLocked && sessionId !== String(task.codexSessionId || '').trim()) {
    return reply.code(409).send({
      message: '该任务已有项目历史，不能再切换项目；如需使用新项目，请新建任务。',
    })
  }

  if (sessionId) {
    const session = getPromptxCodexSessionById(sessionId)
    if (!session) {
      return reply.code(404).send({ message: '没有找到对应的 PromptX 项目。' })
    }
  }

  const updatedTask = updateTaskCodexSession(request.params.slug, sessionId)
  if (!updatedTask) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  broadcastServerEvent('tasks.changed', {
    taskSlug: request.params.slug,
    reason: sessionId ? 'session-linked' : 'session-cleared',
  })

  return {
    task: {
      ...decorateTask(updatedTask),
      canEdit: canEditTask(request.params.slug),
    },
  }
})

app.get('/api/tasks/:slug/codex-runs', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  const includeEvents = String(request.query?.includeEvents || '').trim() === 'true'
  const includeLatestEvents = String(request.query?.includeLatestEvents || '').trim() === 'true'
  const events = normalizeCodexRunEventsMode(request.query?.events, {
    includeEvents,
    includeLatestEvents,
  })

  return {
    items: listTaskCodexRunsWithOptions(request.params.slug, {
      limit: request.query?.limit,
      events,
    }),
  }
})

app.get('/api/tasks/:slug/git-diff', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  const scope = String(request.query?.scope || 'workspace').trim()
  if (scope !== 'workspace' && scope !== 'task' && scope !== 'run') {
    return reply.code(400).send({ message: '无效的 diff 范围。' })
  }

  try {
    return await getTaskGitDiffReviewInSubprocess(request.params.slug, {
      scope,
      runId: request.query?.runId,
      filePath: request.query?.filePath,
      includeFiles: String(request.query?.includeFiles || '').trim() !== 'false',
      includeStats: String(request.query?.includeStats || '').trim() !== 'false',
    })
  } catch (error) {
    if (error?.statusCode) {
      return reply.code(error.statusCode).send({
        message: String(error?.message || 'git diff 计算失败。'),
      })
    }
    throw error
  }
})

app.post('/api/tasks/:slug/codex-runs', async (request, reply) => {
  purgeExpiredContent()
  try {
    const payload = await startTaskRunForTask({
      taskSlug: request.params.slug,
      sessionId: request.body?.sessionId,
      prompt: request.body?.prompt,
      promptBlocks: request.body?.promptBlocks,
    })
    return reply.code(201).send(payload)
  } catch (error) {
    const message = String(error?.message || '')
    if (error?.statusCode) {
      const statusCode = error.statusCode >= 500 ? 503 : error.statusCode
      return reply.code(statusCode).send({ message })
    }
    if (message.includes('请先选择') || message.includes('没有可发送')) {
      return reply.code(400).send({ message })
    }
    if (message.includes('没有找到对应的 PromptX 项目') || message.includes('任务不存在')) {
      return reply.code(404).send({ message })
    }
    if (message.includes('当前项目正在执行中')) {
      return reply.code(409).send({ message })
    }
    throw error
  }
})

app.delete('/api/tasks/:slug/codex-runs', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  const runningRun = getRunningCodexRunByTaskSlug(request.params.slug)
  if (runningRun) {
    return reply.code(409).send({ message: '当前任务正在执行中，请先停止后再清空记录。' })
  }

  deleteTaskCodexRuns(request.params.slug)
  broadcastServerEvent('runs.changed', {
    taskSlug: request.params.slug,
  })
  return reply.code(204).send()
})

app.post('/api/uploads', async (request, reply) => {
  const part = await request.file()
  if (!part) {
    return reply.code(400).send({ message: '没有收到上传文件。' })
  }
  if (!String(part.mimetype || '').startsWith('image/')) {
    return reply.code(400).send({ message: '只支持上传图片文件。' })
  }

  const tempPath = createTempFilePath(tmpDir, part.filename)
  let outputPath = ''
  let completed = false

  try {
    await pipeline(part.file, fs.createWriteStream(tempPath))

    const image = await Jimp.read(tempPath)
    image.scaleToFit({ w: 1600, h: 1600 })

    const outputName = `${nanoid(16)}.jpg`
    outputPath = path.join(uploadsDir, outputName)
    const outputBuffer = await image.getBuffer('image/jpeg', { quality: 82 })
    fs.writeFileSync(outputPath, outputBuffer)

    const stats = fs.statSync(outputPath)
    completed = true
    return reply.code(201).send({
      url: `/uploads/${outputName}`,
      width: image.bitmap.width,
      height: image.bitmap.height,
      mimeType: 'image/jpeg',
      size: stats.size,
    })
  } finally {
    fs.rmSync(tempPath, { force: true })
    if (outputPath && !completed) {
      fs.rmSync(outputPath, { force: true })
    }
  }
})

app.post('/api/imports/pdf', async (request, reply) => {
  const part = await request.file()
  if (!part) {
    return reply.code(400).send({ message: '没有收到 PDF 文件。' })
  }

  const fileName = normalizeUploadFileName(part.filename, 'task.pdf')
  const mimetype = String(part.mimetype || '').toLowerCase()
  if (mimetype !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
    return reply.code(400).send({ message: '只支持导入 PDF 文件。' })
  }

  const tempPath = createTempFilePath(tmpDir, fileName, '.pdf')
  let createdAssets = []

  try {
    await pipeline(part.file, fs.createWriteStream(tempPath))
    const buffer = fs.readFileSync(tempPath)
    const imported = await importPdfBlocks(buffer, {
      uploadsDir,
    })
    createdAssets = imported.createdAssets || []

    if (!imported.blocks.length) {
      removeAssetFiles(createdAssets)
      return reply.code(422).send({ message: '没有从 PDF 中提取到可导入的文本或图片。' })
    }

    return reply.code(201).send({
      fileName,
      pageCount: imported.pageCount,
      blocks: imported.blocks,
    })
  } catch (error) {
    removeAssetFiles(error.createdAssets || createdAssets)
    throw error
  } finally {
    fs.rmSync(tempPath, { force: true })
  }
})

app.get('/api/codex/sessions', async () => ({
  items: decorateCodexSessionList(listPromptxCodexSessions()),
}))

app.get('/api/codex/workspaces', async (request) => ({
  items: listWorkspaceSuggestions(24, request.query?.engine),
}))

app.get('/api/codex/directories/tree', async (request) => (
  listDirectoryPickerTree({
    path: request.query?.path,
    limit: request.query?.limit,
  })
))

app.get('/api/codex/directories/search', async (request) => (
  searchDirectoryPickerEntries({
    path: request.query?.path,
    query: request.query?.q,
    limit: request.query?.limit,
  })
))

app.get('/api/codex/sessions/:sessionId/files/tree', async (request, reply) => {
  const session = getPromptxCodexSessionById(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 项目。' })
  }

  const payload = listWorkspaceTree(session.cwd, {
    path: request.query?.path,
    limit: request.query?.limit,
  })

  return payload
})

app.get('/api/codex/sessions/:sessionId/files/search', async (request, reply) => {
  const session = getPromptxCodexSessionById(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 项目。' })
  }

  const payload = searchWorkspaceEntries(session.cwd, {
    query: request.query?.q,
    limit: request.query?.limit,
  })

  return payload
})

app.post('/api/codex/sessions', async (request, reply) => {
  const session = createPromptxCodexSession(request.body || {})
  broadcastServerEvent('sessions.changed', {
    sessionId: session.id,
  })
  return reply.code(201).send(decorateCodexSession(session))
})

app.patch('/api/codex/sessions/:sessionId', async (request, reply) => {
  const session = updatePromptxCodexSession(request.params.sessionId, request.body || {})
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 项目。' })
  }

  broadcastServerEvent('sessions.changed', {
    sessionId: session.id,
  })
  return decorateCodexSession(session)
})

app.delete('/api/codex/sessions/:sessionId', async (request, reply) => {
  if (getRunningCodexRunBySessionId(request.params.sessionId)) {
    return reply.code(409).send({ message: '当前项目正在执行中，请先停止后再删除。' })
  }
  const affectedTaskSlugs = clearTaskCodexSessionReferences(request.params.sessionId)
  const session = deletePromptxCodexSession(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 项目。' })
  }

  broadcastServerEvent('sessions.changed', {
    sessionId: request.params.sessionId,
  })
  if (affectedTaskSlugs.length) {
    affectedTaskSlugs.forEach((taskSlug) => {
      broadcastServerEvent('tasks.changed', {
        taskSlug,
        reason: 'session-cleared',
      })
    })
  } else {
    broadcastServerEvent('tasks.changed', {
      reason: 'session-cleared',
    })
  }
  return reply.code(204).send()
})

app.post('/api/codex/runs/:runId/stop', async (request, reply) => {
  const runRecord = getCodexRunById(request.params.runId)
  if (!runRecord) {
    return reply.code(404).send({ message: '没有找到对应的执行记录。' })
  }

  if (!isActiveRunStatus(runRecord.status) || runRecord.status === 'stopping') {
    return { run: runRecord }
  }

  const stoppingRun = updateCodexRunFromRunnerStatus(request.params.runId, {
    status: 'stopping',
  })

  broadcastServerEvent('runs.changed', {
    taskSlug: stoppingRun?.taskSlug,
    runId: request.params.runId,
  })
  broadcastServerEvent('sessions.changed', {
    sessionId: stoppingRun?.sessionId,
  })

  runnerClient.stopRun(request.params.runId, {
    reason: String(request.body?.reason || 'user_requested').trim() || 'user_requested',
    forceAfterMs: request.body?.forceAfterMs,
  }).catch((error) => {
    app.log.error(error)
    const erroredRun = updateCodexRunFromRunnerStatus(request.params.runId, {
      status: 'error',
      errorMessage: error.message || 'Runner 停止请求失败。',
      finishedAt: new Date().toISOString(),
    })
    broadcastServerEvent('runs.changed', {
      taskSlug: erroredRun?.taskSlug || stoppingRun?.taskSlug,
      runId: request.params.runId,
    })
  })

  return reply.code(202).send({
    run: getCodexRunById(request.params.runId),
  })
})

app.get('/api/codex/runs/:runId/events', async (request, reply) => {
  const runRecord = getCodexRunById(request.params.runId)
  if (!runRecord) {
    return reply.code(404).send({ message: '没有找到对应的执行记录。' })
  }

  return {
    items: listCodexRunEvents(request.params.runId, {
      afterSeq: request.query?.afterSeq,
      limit: request.query?.limit,
    }) || [],
  }
})

app.get('/api/codex/runs/:runId/stream', async (request, reply) => {
  const runRecord = getCodexRunById(request.params.runId)
  if (!runRecord) {
    return reply.code(404).send({ message: '没有找到对应的执行记录。' })
  }

  reply.hijack()
  const requestOrigin = request.headers.origin
  reply.raw.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(requestOrigin ? {
      'Access-Control-Allow-Origin': requestOrigin,
      Vary: 'Origin',
    } : {}),
  })
  reply.raw.socket?.setNoDelay?.(true)
  reply.raw.flushHeaders?.()

  const writeMessage = (payload) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      return false
    }

    try {
      reply.raw.write(`${JSON.stringify(payload)}\n`)
      return true
    } catch {
      return false
    }
  }

  let lastSentSeq = Math.max(0, Number(request.query?.afterSeq) || 0)
  let pollTimer = null

  const closeStream = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end()
    }
  }

  const flushRunState = () => {
    const latestRun = getCodexRunById(request.params.runId)
    if (!latestRun) {
      closeStream()
      return
    }

    writeMessage({
      type: 'run',
      run: latestRun,
    })

    const batchLimit = 500
    const nextEvents = listCodexRunEvents(request.params.runId, {
      afterSeq: lastSentSeq,
      limit: batchLimit,
    }) || []

    nextEvents.forEach((event) => {
      lastSentSeq = Math.max(lastSentSeq, Number(event.seq) || 0)
      writeMessage({
        type: 'event',
        event,
      })
    })

    if (!isActiveRunStatus(latestRun.status) && nextEvents.length < batchLimit) {
      closeStream()
    }
  }

  flushRunState()
  if (!reply.raw.destroyed && !reply.raw.writableEnded && isActiveRunStatus(getCodexRunById(request.params.runId)?.status)) {
    pollTimer = setInterval(flushRunState, 350)
    pollTimer.unref?.()
  }

  reply.raw.on('close', closeStream)
})

app.get('/api/tasks/:slug/raw', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).type('text/plain; charset=utf-8').send('任务不存在。')
  }

  const exports = buildTaskExports(task)
  return reply.type('text/plain; charset=utf-8').send(exports.raw)
})

if (hasBuiltWebApp) {
  app.get('/', async (request, reply) => reply.sendFile('index.html', webDistDir))
  app.get('/*', async (request, reply) => {
    const requestPath = String(request.raw.url || '').split('?')[0]
    if (requestPath.startsWith('/api/') || requestPath.startsWith('/uploads/')) {
      return reply.code(404).send({ message: '资源不存在。' })
    }
    return reply.sendFile('index.html', webDistDir)
  })
}

app.setErrorHandler((error, request, reply) => {
  request.log.error(error)
  const message = error.statusCode === 413 ? '文件太大了。' : error.message || '发生了意外错误。'
  reply.code(error.statusCode || 500).send({ message })
})

purgeExpiredContent(true)

app.listen({ port, host }).then(() => {
  app.log.info(`server running at http://${host}:${port}`)
  buildServerAccessUrls(host, port).forEach((message) => {
    app.log.info(message)
  })
  runRecoveryService.start()
  taskAutomationService.start()
  maintenanceService.start()
  relayClient.start()
})

