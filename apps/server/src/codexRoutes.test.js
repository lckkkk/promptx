import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import test from 'node:test'

import {
  createWorkspaceSuggestionService,
  registerCodexRoutes,
} from './codexRoutes.js'

test('workspace suggestion service merges and deduplicates sources', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspaces-'))
  const workspaceRootDir = path.join(tempRoot, 'promptx')
  const siblingA = path.join(tempRoot, 'repo-a')
  const siblingB = path.join(tempRoot, 'repo-b')
  const knownOnly = path.join(tempRoot, 'known-only')

  fs.mkdirSync(workspaceRootDir, { recursive: true })
  fs.mkdirSync(siblingA, { recursive: true })
  fs.mkdirSync(siblingB, { recursive: true })
  fs.mkdirSync(knownOnly, { recursive: true })

  try {
    const service = createWorkspaceSuggestionService({
      listKnownWorkspacesByEngine: () => [siblingA, knownOnly],
      listPromptxCodexSessions: () => [
        { cwd: siblingB },
        { cwd: workspaceRootDir },
      ],
      workspaceParentDir: tempRoot,
      workspaceRootDir,
    })

    const items = service.listWorkspaceSuggestions(10, 'codex')
    assert.deepEqual(items, [
      workspaceRootDir,
      knownOnly,
      siblingA,
      siblingB,
    ])
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('codex routes return stop acceptance and event history', async () => {
  const app = Fastify()
  registerCodexRoutes(app, {
    broadcastServerEvent: () => {},
    clearTaskCodexSessionReferences: () => [],
    createPromptxCodexSession: () => ({ id: 'session-1' }),
    decorateCodexSession: (session) => session,
    decorateCodexSessionList: (items) => items,
    deletePromptxCodexSession: () => null,
    getCodexRunById(runId) {
      if (runId !== 'run-1') {
        return null
      }
      return {
        id: 'run-1',
        status: 'running',
      }
    },
    getPromptxCodexSessionById: () => null,
    getRunningCodexRunBySessionId: () => null,
    isActiveRunStatus: (status) => ['queued', 'starting', 'running', 'stopping'].includes(status),
    listCodexRunEvents: () => [{ seq: 1, type: 'stdout', text: 'hello' }],
    listDirectoryPickerTree: () => ({}),
    listPromptxCodexSessions: () => [],
    listWorkspaceSuggestions: () => [],
    listWorkspaceTree: () => ({}),
    runDispatchService: {
      async requestRunStop() {
        return {
          accepted: true,
          run: {
            id: 'run-1',
            status: 'stopping',
          },
        }
      },
    },
    searchDirectoryPickerEntries: () => ({}),
    searchWorkspaceEntries: () => ({}),
    updatePromptxCodexSession: () => null,
  })
  await app.ready()

  try {
    const stopResponse = await app.inject({
      method: 'POST',
      url: '/api/codex/runs/run-1/stop',
      payload: {
        reason: 'user_requested',
      },
    })
    assert.equal(stopResponse.statusCode, 202)
    assert.equal(stopResponse.json().run.status, 'stopping')

    const eventsResponse = await app.inject({
      method: 'GET',
      url: '/api/codex/runs/run-1/events',
    })
    assert.equal(eventsResponse.statusCode, 200)
    assert.deepEqual(eventsResponse.json(), {
      items: [{ seq: 1, type: 'stdout', text: 'hello' }],
    })
  } finally {
    await app.close()
  }
})

test('codex routes broadcast task updates when deleting a session with references', async () => {
  const broadcasts = []
  const app = Fastify()
  registerCodexRoutes(app, {
    broadcastServerEvent(type, payload) {
      broadcasts.push({ type, payload })
    },
    clearTaskCodexSessionReferences: () => ['task-a', 'task-b'],
    createPromptxCodexSession: () => ({ id: 'session-1' }),
    decorateCodexSession: (session) => session,
    decorateCodexSessionList: (items) => items,
    deletePromptxCodexSession: () => ({ id: 'session-1' }),
    getCodexRunById: () => null,
    getPromptxCodexSessionById: () => null,
    getRunningCodexRunBySessionId: () => null,
    isActiveRunStatus: () => false,
    listCodexRunEvents: () => [],
    listDirectoryPickerTree: () => ({}),
    listPromptxCodexSessions: () => [],
    listWorkspaceSuggestions: () => [],
    listWorkspaceTree: () => ({}),
    runDispatchService: {
      async requestRunStop() {
        return null
      },
    },
    searchDirectoryPickerEntries: () => ({}),
    searchWorkspaceEntries: () => ({}),
    updatePromptxCodexSession: () => null,
  })
  await app.ready()

  try {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/codex/sessions/session-1',
    })

    assert.equal(response.statusCode, 204)
    assert.deepEqual(broadcasts, [
      {
        type: 'sessions.changed',
        payload: { sessionId: 'session-1' },
      },
      {
        type: 'tasks.changed',
        payload: { taskSlug: 'task-a', reason: 'session-cleared' },
      },
      {
        type: 'tasks.changed',
        payload: { taskSlug: 'task-b', reason: 'session-cleared' },
      },
    ])
  } finally {
    await app.close()
  }
})

test('codex routes reset session and clear related run history', async () => {
  const broadcasts = []
  const deletedTaskRuns = []
  const app = Fastify()
  registerCodexRoutes(app, {
    broadcastServerEvent(type, payload) {
      broadcasts.push({ type, payload })
    },
    clearTaskCodexSessionReferences: () => [],
    createPromptxCodexSession: () => ({ id: 'session-1' }),
    decorateCodexSession: (session) => ({ ...session, decorated: true }),
    decorateCodexSessionList: (items) => items,
    deletePromptxCodexSession: () => null,
    deleteTaskCodexRuns(taskSlug) {
      deletedTaskRuns.push(taskSlug)
    },
    getCodexRunById: () => null,
    getPromptxCodexSessionById: () => ({ id: 'session-1' }),
    getRunningCodexRunBySessionId: () => null,
    getRunningCodexRunByTaskSlug: () => null,
    isActiveRunStatus: () => false,
    listCodexRunEvents: () => [],
    listDirectoryPickerTree: () => ({}),
    listPromptxCodexSessions: () => [],
    listTaskSlugsByCodexSessionId: () => ['task-a', 'task-b'],
    listWorkspaceSuggestions: () => [],
    listWorkspaceTree: () => ({}),
    resetPromptxCodexSession: () => ({ id: 'session-1', title: '项目 A' }),
    runDispatchService: {
      async requestRunStop() {
        return null
      },
    },
    searchDirectoryPickerEntries: () => ({}),
    searchWorkspaceEntries: () => ({}),
    updatePromptxCodexSession: () => null,
  })
  await app.ready()

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/sessions/session-1/reset',
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      session: {
        id: 'session-1',
        title: '项目 A',
        decorated: true,
      },
      affectedTaskSlugs: ['task-a', 'task-b'],
    })
    assert.deepEqual(deletedTaskRuns, ['task-a', 'task-b'])
    assert.deepEqual(broadcasts, [
      {
        type: 'sessions.changed',
        payload: { sessionId: 'session-1' },
      },
      {
        type: 'runs.changed',
        payload: { taskSlug: 'task-a' },
      },
      {
        type: 'runs.changed',
        payload: { taskSlug: 'task-b' },
      },
    ])
  } finally {
    await app.close()
  }
})

test('codex routes create directory picker directories', async () => {
  const app = Fastify()
  registerCodexRoutes(app, {
    broadcastServerEvent: () => {},
    clearTaskCodexSessionReferences: () => [],
    createDirectoryPickerDirectory: ({ path: targetPath, name }) => ({
      path: path.join(targetPath, name),
      name,
      type: 'directory',
      hasChildren: false,
    }),
    createPromptxCodexSession: () => ({ id: 'session-1' }),
    decorateCodexSession: (session) => session,
    decorateCodexSessionList: (items) => items,
    deletePromptxCodexSession: () => null,
    getCodexRunById: () => null,
    getPromptxCodexSessionById: () => null,
    getRunningCodexRunBySessionId: () => null,
    isActiveRunStatus: () => false,
    listCodexRunEvents: () => [],
    listDirectoryPickerTree: () => ({}),
    listPromptxCodexSessions: () => [],
    listWorkspaceSuggestions: () => [],
    listWorkspaceTree: () => ({}),
    runDispatchService: {
      async requestRunStop() {
        return null
      },
    },
    searchDirectoryPickerEntries: () => ({}),
    searchWorkspaceEntries: () => ({}),
    updatePromptxCodexSession: () => null,
  })
  await app.ready()

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/codex/directories',
      payload: {
        path: '/tmp',
        name: 'repo-new',
      },
    })

    assert.equal(response.statusCode, 201)
    assert.equal(response.json().item.path, path.join('/tmp', 'repo-new'))
  } finally {
    await app.close()
  }
})
