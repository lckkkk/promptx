import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('listTasks uses stable sort order instead of updated-at order', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const { createTask, listTasks, updateTask } = repository

    const olderTask = createTask({
      title: 'older',
      visibility: 'private',
      expiry: 'none',
    })

    await new Promise((resolve) => setTimeout(resolve, 10))

    const newerTask = createTask({
      title: 'newer',
      visibility: 'private',
      expiry: 'none',
    })

    updateTask(olderTask.slug, {
      title: 'older updated',
      visibility: 'private',
      expiry: 'none',
      blocks: [{ type: 'text', content: 'changed' }],
    })

    const items = listTasks()
    assert.deepEqual(
      items.map((item) => item.slug),
      [newerTask.slug, olderTask.slug]
    )
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('reorderTasks persists manual task ordering', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const { createTask, listTasks, reorderTasks } = repository

    const first = createTask({ title: 'first', visibility: 'private', expiry: 'none' })
    const second = createTask({ title: 'second', visibility: 'private', expiry: 'none' })
    const third = createTask({ title: 'third', visibility: 'private', expiry: 'none' })

    const initialItems = listTasks()
    assert.deepEqual(initialItems.slice(0, 3).map((item) => item.slug), [third.slug, second.slug, first.slug])

    const result = reorderTasks([second.slug, third.slug, first.slug])
    assert.equal(result.changed, true)
    assert.deepEqual(result.items.slice(0, 3).map((item) => item.slug), [second.slug, third.slug, first.slug])
    assert.deepEqual(listTasks().slice(0, 3).map((item) => item.slug), [second.slug, third.slug, first.slug])
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('updateTask skips touching updatedAt when payload is unchanged', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const { createTask, getTaskBySlug, updateTask } = repository

    const task = createTask({
      title: 'same task',
      autoTitle: 'same auto',
      lastPromptPreview: 'same preview',
      visibility: 'private',
      expiry: 'none',
      codexSessionId: 'session-a',
      todoItems: [
        {
          id: 'todo-1',
          createdAt: '2026-03-26T00:00:00.000Z',
          blocks: [{ type: 'text', content: 'todo text' }],
        },
      ],
      blocks: [
        { type: 'text', content: 'hello' },
      ],
    })

    const before = getTaskBySlug(task.slug)
    await new Promise((resolve) => setTimeout(resolve, 10))

    const result = updateTask(task.slug, {
      title: before.title,
      autoTitle: before.autoTitle,
      lastPromptPreview: before.lastPromptPreview,
      visibility: before.visibility,
      expiry: before.expiry,
      codexSessionId: before.codexSessionId,
      todoItems: before.todoItems,
      blocks: before.blocks,
    })

    const after = getTaskBySlug(task.slug)
    assert.equal(result.changed, false)
    assert.equal(after.updatedAt, before.updatedAt)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('notification profiles can be reused by tasks and cannot be deleted while referenced', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const {
      createNotificationProfile,
      createTask,
      deleteNotificationProfile,
      getTaskBySlug,
      updateNotificationProfile,
    } = repository

    const profile = createNotificationProfile({
      name: '研发群',
      channelType: 'dingtalk',
      webhookUrl: 'https://example.com/hook',
      triggerOn: 'completed',
      locale: 'zh-CN',
      messageMode: 'summary',
    })

    const task = createTask({
      title: 'task with notification',
      visibility: 'private',
      expiry: 'none',
      notification: {
        enabled: true,
        profileId: profile.id,
      },
    })

    const loadedTask = getTaskBySlug(task.slug)
    assert.equal(loadedTask.notification.profileId, profile.id)
    assert.equal(loadedTask.notification.profileName, '研发群')
    assert.equal(loadedTask.notification.webhookUrl, 'https://example.com/hook')

    updateNotificationProfile(profile.id, {
      name: '研发群',
      channelType: 'dingtalk',
      webhookUrl: 'https://example.com/hook-updated',
      triggerOn: 'completed',
      locale: 'zh-CN',
      messageMode: 'summary',
    })

    const updatedTask = getTaskBySlug(task.slug)
    assert.equal(updatedTask.notification.webhookUrl, 'https://example.com/hook-updated')

    const deleteResult = deleteNotificationProfile(profile.id)
    assert.equal(deleteResult.error, 'in_use')
    assert.equal(deleteResult.usageCount, 1)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('createTask applies default notification profile from system config and clears it when profile is deleted', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const systemConfig = await import(`./systemConfig.js?test=${Date.now()}`)
    const {
      createNotificationProfile,
      createTask,
      deleteNotificationProfile,
      getTaskBySlug,
    } = repository
    const {
      readStoredSystemConfig,
      writeStoredSystemConfig,
    } = systemConfig

    const defaultProfile = createNotificationProfile({
      name: '默认通知',
      channelType: 'dingtalk',
      webhookUrl: 'https://example.com/default-hook',
      triggerOn: 'completed',
      locale: 'zh-CN',
      messageMode: 'summary',
    })

    writeStoredSystemConfig({
      notification: {
        defaultProfileId: defaultProfile.id,
      },
    })

    const task = createTask({
      title: 'task with default notification profile',
      visibility: 'private',
      expiry: 'none',
    })

    const loadedTask = getTaskBySlug(task.slug)
    assert.equal(loadedTask.notification.enabled, true)
    assert.equal(loadedTask.notification.profileId, defaultProfile.id)
    assert.equal(loadedTask.notification.profileName, '默认通知')

    const removableProfile = createNotificationProfile({
      name: '临时通知',
      channelType: 'webhook',
      webhookUrl: 'https://example.com/tmp-hook',
      triggerOn: 'success',
      locale: 'zh-CN',
      messageMode: 'summary',
    })

    writeStoredSystemConfig({
      notification: {
        defaultProfileId: removableProfile.id,
      },
    })

    const deleteResult = deleteNotificationProfile(removableProfile.id)
    assert.deepEqual(deleteResult, { ok: true })
    assert.equal(readStoredSystemConfig().notification.defaultProfileId, null)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('createTask ignores global default notification profile when it belongs to another user', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const systemConfig = await import(`./systemConfig.js?test=${Date.now()}`)
    const {
      createNotificationProfile,
      createTask,
      getTaskBySlug,
    } = repository
    const {
      writeStoredSystemConfig,
    } = systemConfig

    const otherUserProfile = createNotificationProfile({
      name: '其他用户默认通知',
      channelType: 'dingtalk',
      webhookUrl: 'https://example.com/other-user-hook',
      triggerOn: 'completed',
      locale: 'zh-CN',
      messageMode: 'summary',
    }, 'lc')

    writeStoredSystemConfig({
      notification: {
        defaultProfileId: otherUserProfile.id,
      },
    })

    const task = createTask({
      title: 'new user first task',
      visibility: 'private',
      expiry: 'none',
    }, 'new-user')

    const loadedTask = getTaskBySlug(task.slug, 'new-user')
    assert.equal(loadedTask.notification.enabled, false)
    assert.equal(loadedTask.notification.profileId, null)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('listTasks marks task unread when newer terminal run exists after read state', { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const codexSessions = await import(`./codexSessions.js?test=${Date.now()}`)
    const codexRuns = await import(`./codexRuns.js?test=${Date.now()}`)
    const { createTask, listTasks, markTaskRead } = repository
    const { createPromptxCodexSession } = codexSessions
    const { createCodexRun, updateCodexRun } = codexRuns
    const session = createPromptxCodexSession({
      title: 'Unread Session',
      cwd: tempDir,
    }, 'lc')

    const task = createTask({
      title: 'unread task',
      visibility: 'private',
      expiry: 'none',
      codexSessionId: session.id,
    }, 'lc')

    const firstFinishedAt = '2026-04-08T10:00:00.000Z'
    const firstRun = createCodexRun({
      taskSlug: task.slug,
      sessionId: session.id,
      prompt: 'first run',
      status: 'running',
    })
    updateCodexRun(firstRun.id, {
      status: 'completed',
      startedAt: firstFinishedAt,
      finishedAt: firstFinishedAt,
      updatedAt: firstFinishedAt,
    })

    markTaskRead(task.slug, 'lc')

    const secondFinishedAt = '2026-04-08T10:05:00.000Z'
    const secondRun = createCodexRun({
      taskSlug: task.slug,
      sessionId: session.id,
      prompt: 'second run',
      status: 'running',
    })
    updateCodexRun(secondRun.id, {
      status: 'completed',
      startedAt: secondFinishedAt,
      finishedAt: secondFinishedAt,
      updatedAt: secondFinishedAt,
    })

    const items = listTasks(30, 'lc')
    assert.equal(items[0].unread, true)
    assert.equal(items[0].latestCompletedRunFinishedAt, secondFinishedAt)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('listTasks marks task unread when terminal run exists and no read state is stored yet', { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const codexSessions = await import(`./codexSessions.js?test=${Date.now()}`)
    const codexRuns = await import(`./codexRuns.js?test=${Date.now()}`)
    const { createTask, listTasks } = repository
    const { createPromptxCodexSession } = codexSessions
    const { createCodexRun, updateCodexRun } = codexRuns
    const session = createPromptxCodexSession({
      title: 'First Unread Session',
      cwd: tempDir,
    }, 'lc')

    const task = createTask({
      title: 'first unread task',
      visibility: 'private',
      expiry: 'none',
      codexSessionId: session.id,
    }, 'lc')

    const finishedAt = '2026-04-08T09:11:18.789Z'
    const runRecord = createCodexRun({
      taskSlug: task.slug,
      sessionId: session.id,
      prompt: 'first run',
      status: 'running',
    })
    updateCodexRun(runRecord.id, {
      status: 'completed',
      startedAt: finishedAt,
      finishedAt,
      updatedAt: finishedAt,
    })

    const items = listTasks(30, 'lc')
    assert.equal(items[0].latestCompletedRunFinishedAt, finishedAt)
    assert.equal(items[0].unread, true)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('markTaskRead clears unread for the current user', { concurrency: false }, async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-repository-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')

  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const repository = await import(`./repository.js?test=${Date.now()}`)
    const db = await import(`./db.js?test=${Date.now()}`)
    const codexSessions = await import(`./codexSessions.js?test=${Date.now()}`)
    const codexRuns = await import(`./codexRuns.js?test=${Date.now()}`)
    const { createTask, listTasks, markTaskRead } = repository
    const { createPromptxCodexSession } = codexSessions
    const { createCodexRun, updateCodexRun } = codexRuns
    const session = createPromptxCodexSession({
      title: 'Shared Session',
      cwd: tempDir,
    }, 'lc')

    const task = createTask({
      title: 'shared task',
      visibility: 'private',
      expiry: 'none',
      codexSessionId: session.id,
    }, 'lc')

    const runRecord = createCodexRun({
      taskSlug: task.slug,
      sessionId: session.id,
      prompt: 'shared run',
      status: 'running',
    })
    updateCodexRun(runRecord.id, {
      status: 'completed',
      startedAt: '2026-04-08T10:10:00.000Z',
      finishedAt: '2026-04-08T10:10:00.000Z',
      updatedAt: '2026-04-08T10:10:00.000Z',
    })

    markTaskRead(task.slug, 'lc')

    const lcTask = listTasks(30, 'lc')[0]
    assert.equal(lcTask.unread, false)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
