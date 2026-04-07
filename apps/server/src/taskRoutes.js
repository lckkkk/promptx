import fs from 'node:fs'
import path from 'node:path'
import { normalizeCodexRunEventsMode } from '../../../packages/shared/src/index.js'
import { getApiErrorPayload } from './apiErrors.js'

const MAX_TASK_REORDER_COUNT = 200

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

function createTaskWorkspaceDiffSummaryService(options = {}) {
  const getPromptxCodexSessionById = options.getPromptxCodexSessionById || (() => null)
  const getWorkspaceGitDiffStatusSummaryByCwd = options.getWorkspaceGitDiffStatusSummaryByCwd || (() => null)
  const listTasks = options.listTasks || (() => [])

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

  function listTaskWorkspaceDiffSummaries(limit = 30, userId = 'default') {
    return attachTaskWorkspaceDiffSummaries(listTasks(limit, userId)).map((task) => ({
      slug: String(task?.slug || '').trim(),
      workspaceDiffSummary: task?.workspaceDiffSummary || createEmptyWorkspaceDiffSummary(),
    }))
  }

  return {
    attachTaskWorkspaceDiffSummaries,
    listTaskWorkspaceDiffSummaries,
  }
}

function mapRunDispatchErrorToReply(error, reply) {
  const message = String(error?.message || '')
  const payload = getApiErrorPayload(error, {
    messageKey: 'errors.requestFailed',
    message: message || '请求失败。',
  })

  if (error?.statusCode) {
    const statusCode = error.statusCode >= 500 ? 503 : error.statusCode
    return reply.code(statusCode).send(payload)
  }
  if (message.includes('请选择') || message.includes('没有可发送')) {
    return reply.code(400).send({
      ...payload,
      messageKey: payload.messageKey || (message.includes('请选择') ? 'errors.sessionRequired' : 'errors.noPromptToSend'),
    })
  }
  if (message.includes('没有找到对应的 PromptX 项目') || message.includes('任务不存在')) {
    return reply.code(404).send({
      ...payload,
      messageKey: payload.messageKey || (message.includes('任务不存在') ? 'errors.taskNotFound' : 'errors.sessionNotFound'),
    })
  }
  if (message.includes('当前项目正在执行中')) {
    return reply.code(409).send({
      ...payload,
      messageKey: payload.messageKey || 'errors.currentProjectRunning',
    })
  }

  throw error
}

function registerTaskRoutes(app, options = {}) {
  const {
    broadcastServerEvent = () => {},
    buildTaskExports,
    canEditTask,
    createTask,
    decorateTask,
    decorateTaskList,
    deleteTask,
    deleteTaskCodexRuns,
    getPromptxCodexSessionById,
    getRunningCodexRunByTaskSlug,
    getTaskBySlug,
    getTaskGitDiffReviewInSubprocess,
    listTaskCodexRunsWithOptions,
    listTaskWorkspaceDiffSummaries,
    listTasks = () => [],
    reorderTasks = () => ({ changed: false, items: [] }),
    purgeExpiredContent = () => {},
    removeAssetFiles = () => {},
    runDispatchService,
    updateTask,
    updateTaskCodexSession,
  } = options

  app.get('/api/tasks', async (request) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    return {
      items: decorateTaskList(listTasks(30, userId)),
    }
  })

  app.get('/api/tasks/workspace-diff-summaries', async (request) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    return {
      items: listTaskWorkspaceDiffSummaries(request.query?.limit, userId),
    }
  })

  app.post('/api/tasks', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    let task
    try {
      task = createTask(request.body || {}, userId)
    } catch (error) {
      return reply.code(400).send({
        messageKey: 'errors.taskCreateFailed',
        message: error.message || '任务创建失败。',
      })
    }
    broadcastServerEvent('tasks.changed', {
      taskSlug: task.slug,
      reason: 'created',
    })
    return reply.code(201).send(decorateTask(task))
  })

  app.post('/api/tasks/reorder', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    const rawSlugs = Array.isArray(request.body?.slugs) ? request.body.slugs : []
    const normalizedSlugs = rawSlugs
      .map((slug) => String(slug || '').trim())
      .filter(Boolean)

    if (!normalizedSlugs.length) {
      return reply.code(400).send({
        messageKey: 'errors.taskReorderFailed',
        message: '任务排序数据无效。',
      })
    }

    if (normalizedSlugs.length > MAX_TASK_REORDER_COUNT) {
      return reply.code(400).send({
        messageKey: 'errors.taskReorderFailed',
        message: '一次最多只能排序 200 个任务。',
      })
    }

    let result
    try {
      result = reorderTasks(normalizedSlugs, userId)
    } catch (error) {
      return reply.code(400).send({
        messageKey: 'errors.taskReorderFailed',
        message: error.message || '任务排序失败。',
      })
    }

    if (result?.changed) {
      broadcastServerEvent('tasks.changed', {
        reason: 'reordered',
      })
    }

    return {
      items: decorateTaskList(result?.items || listTasks(30, userId)),
    }
  })

  app.get('/api/tasks/:slug', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    const task = getTaskBySlug(request.params.slug, userId)
    if (!task) {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
    }
    if (task.expired) {
      return reply.code(410).send({ messageKey: 'errors.taskExpired', message: '任务已过期。' })
    }

    return {
      ...decorateTask(task),
      canEdit: canEditTask(request.params.slug, userId),
    }
  })

  app.put('/api/tasks/:slug', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    let result
    try {
      result = updateTask(request.params.slug, request.body || {}, userId)
    } catch (error) {
      return reply.code(400).send({
        messageKey: 'errors.taskUpdateFailed',
        message: error.message || '任务更新失败。',
      })
    }
    if (result.error === 'not_found') {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
    }
    if (result.changed !== false) {
      broadcastServerEvent('tasks.changed', {
        taskSlug: request.params.slug,
        reason: 'updated',
      })
    }
    return decorateTask(result)
  })

  app.delete('/api/tasks/:slug', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    if (getRunningCodexRunByTaskSlug(request.params.slug)) {
      return reply.code(409).send({
        messageKey: 'errors.taskDeleteWhileRunning',
        message: '当前任务正在执行中，请先停止后再删除。',
      })
    }
    const result = deleteTask(request.params.slug, userId)
    if (result.error === 'not_found') {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
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
    const userId = request.user?.username || 'default'
    const task = getTaskBySlug(request.params.slug, userId)
    if (!task || task.expired) {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
    }

    const sessionId = String(request.body?.sessionId || '').trim()
    const taskSessionLocked = Boolean(task.codexSessionId && Number(task.codexRunCount || 0) > 0)
    if (taskSessionLocked && sessionId !== String(task.codexSessionId || '').trim()) {
      return reply.code(409).send({
        messageKey: 'errors.taskSessionLocked',
        message: '该任务已有项目历史，不能再切换项目；如需使用新项目，请新建任务。',
      })
    }

    if (sessionId) {
      const session = getPromptxCodexSessionById(sessionId)
      if (!session) {
        return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
      }
    }

    const updatedTask = updateTaskCodexSession(request.params.slug, sessionId, userId)
    if (!updatedTask) {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
    }

    broadcastServerEvent('tasks.changed', {
      taskSlug: request.params.slug,
      reason: sessionId ? 'session-linked' : 'session-cleared',
    })

    return {
      task: {
        ...decorateTask(updatedTask),
        canEdit: canEditTask(request.params.slug, userId),
      },
    }
  })

  app.get('/api/tasks/:slug/codex-runs', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    const task = getTaskBySlug(request.params.slug, userId)
    if (!task || task.expired) {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
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
    const userId = request.user?.username || 'default'
    const task = getTaskBySlug(request.params.slug, userId)
    if (!task || task.expired) {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
    }

    const scope = String(request.query?.scope || 'workspace').trim()
    if (scope !== 'workspace' && scope !== 'task' && scope !== 'run') {
      return reply.code(400).send({ messageKey: 'errors.invalidDiffScope', message: '无效的 diff 范围。' })
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
        return reply.code(error.statusCode).send(getApiErrorPayload(error, {
          messageKey: 'errors.gitDiffFailed',
          message: String(error?.message || 'git diff 计算失败。'),
        }))
      }
      throw error
    }
  })

  app.get('/api/tasks/:slug/file-content', async (request, reply) => {
    const userId = request.user?.username || 'default'
    const task = getTaskBySlug(request.params.slug, userId)
    if (!task || task.expired) {
      return reply.code(404).send({ message: '任务不存在。' })
    }

    const filePath = String(request.query?.filePath || '').trim()
    if (!filePath) {
      return reply.code(400).send({ message: '请提供 filePath 参数。' })
    }

    const sessionId = String(task.codexSessionId || '').trim()
    if (!sessionId) {
      return reply.code(400).send({ message: '任务未关联项目。' })
    }

    const session = getPromptxCodexSessionById(sessionId)
    if (!session?.cwd) {
      return reply.code(400).send({ message: '项目工作目录不存在。' })
    }

    const repoRoot = path.resolve(session.cwd)
    const absolutePath = path.resolve(repoRoot, filePath)
    if (!absolutePath.startsWith(repoRoot)) {
      return reply.code(403).send({ message: '路径不合法。' })
    }

    if (!fs.existsSync(absolutePath)) {
      return reply.code(404).send({ message: '文件不存在。' })
    }

    const buffer = fs.readFileSync(absolutePath)
    const isBinary = buffer.includes(0)
    if (isBinary) {
      return reply.code(400).send({ message: '二进制文件不支持下载。' })
    }

    const fileName = path.basename(filePath)
    reply.header('Content-Type', 'text/plain; charset=utf-8')
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`)
    return reply.send(buffer)
  })

  app.post('/api/tasks/:slug/codex-runs', async (request, reply) => {
    purgeExpiredContent()
    try {
      const payload = await runDispatchService.startTaskRunForTask({
        taskSlug: request.params.slug,
        sessionId: request.body?.sessionId,
        prompt: request.body?.prompt,
        promptBlocks: request.body?.promptBlocks,
      })
      return reply.code(payload?.runnerDispatchPending ? 202 : 201).send(payload)
    } catch (error) {
      return mapRunDispatchErrorToReply(error, reply)
    }
  })

  app.delete('/api/tasks/:slug/codex-runs', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    const task = getTaskBySlug(request.params.slug, userId)
    if (!task || task.expired) {
      return reply.code(404).send({ messageKey: 'errors.taskNotFound', message: '任务不存在。' })
    }

    const runningRun = getRunningCodexRunByTaskSlug(request.params.slug)
    if (runningRun) {
      return reply.code(409).send({
        messageKey: 'errors.taskClearRunsWhileRunning',
        message: '当前任务正在执行中，请先停止后再清空记录。',
      })
    }

    deleteTaskCodexRuns(request.params.slug)
    broadcastServerEvent('runs.changed', {
      taskSlug: request.params.slug,
    })
    return reply.code(204).send()
  })

  app.get('/api/tasks/:slug/raw', async (request, reply) => {
    purgeExpiredContent()
    const userId = request.user?.username || 'default'
    const task = getTaskBySlug(request.params.slug, userId)
    if (!task || task.expired) {
      return reply.code(404).type('text/plain; charset=utf-8').send('任务不存在。')
    }

    const exports = buildTaskExports(task)
    return reply.type('text/plain; charset=utf-8').send(exports.raw)
  })
}

export {
  createEmptyWorkspaceDiffSummary,
  createTaskWorkspaceDiffSummaryService,
  registerTaskRoutes,
  toWorkspaceDiffSummary,
}
