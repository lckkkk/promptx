import assert from 'node:assert/strict'
import Fastify from 'fastify'
import test from 'node:test'

import { buildInternalAuthHeaders } from './internalAuth.js'
import {
  registerInternalRunnerRoutes,
  registerRealtimeRoutes,
} from './internalRoutes.js'

test('internal runner routes require auth and notify runs that first enter terminal state', async () => {
  const events = []
  const notified = []
  const app = Fastify()

  registerInternalRunnerRoutes(app, {
    runEventIngestService: {
      ingestEvents(items) {
        events.push(...items)
        return { ok: true, count: items.length }
      },
      ingestStatus(payload) {
        return {
          run: {
            ...payload,
            id: payload.runId,
            completed: true,
          },
          transitionedToTerminal: true,
        }
      },
    },
    taskAutomationService: {
      notifyRun(taskSlug, runId) {
        notified.push({ taskSlug, runId })
        return Promise.resolve()
      },
    },
  })
  await app.ready()

  try {
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/internal/runner-events',
      payload: { items: [] },
    })
    assert.equal(unauthorized.statusCode, 401)

    const eventsResponse = await app.inject({
      method: 'POST',
      url: '/internal/runner-events',
      headers: buildInternalAuthHeaders(),
      payload: {
        items: [{ runId: 'run-1', type: 'stdout' }],
      },
    })
    assert.equal(eventsResponse.statusCode, 200)
    assert.equal(events.length, 1)

    const statusResponse = await app.inject({
      method: 'POST',
      url: '/internal/runner-status',
      headers: buildInternalAuthHeaders(),
      payload: {
        runId: 'run-1',
        taskSlug: 'task-1',
        status: 'completed',
      },
    })
    assert.equal(statusResponse.statusCode, 200)
    assert.deepEqual(notified, [{ taskSlug: 'task-1', runId: 'run-1' }])
  } finally {
    await app.close()
  }
})

test('internal runner routes do not notify the same completed run twice', async () => {
  const notified = []
  const app = Fastify()

  registerInternalRunnerRoutes(app, {
    runEventIngestService: {
      ingestEvents() {
        return { ok: true, count: 0 }
      },
      ingestStatus(payload) {
        const alreadyNotified = notified.some((item) => item.runId === payload.runId)
        return {
          run: {
            ...payload,
            id: payload.runId,
            completed: true,
          },
          transitionedToTerminal: !alreadyNotified,
        }
      },
    },
    taskAutomationService: {
      notifyRun(taskSlug, runId) {
        notified.push({ taskSlug, runId })
        return Promise.resolve()
      },
    },
  })
  await app.ready()

  try {
    const headers = buildInternalAuthHeaders()

    const firstResponse = await app.inject({
      method: 'POST',
      url: '/internal/runner-status',
      headers,
      payload: {
        runId: 'run-dup-1',
        taskSlug: 'task-dup-1',
        status: 'completed',
      },
    })
    assert.equal(firstResponse.statusCode, 200)

    const secondResponse = await app.inject({
      method: 'POST',
      url: '/internal/runner-status',
      headers,
      payload: {
        runId: 'run-dup-1',
        taskSlug: 'task-dup-1',
        status: 'completed',
      },
    })
    assert.equal(secondResponse.statusCode, 200)
    assert.deepEqual(notified, [{ taskSlug: 'task-dup-1', runId: 'run-dup-1' }])
  } finally {
    await app.close()
  }
})

test('internal runner routes accept large runner event payloads', async () => {
  const app = Fastify()
  const largeText = 'x'.repeat(1024 * 1024 + 256)

  registerInternalRunnerRoutes(app, {
    runEventIngestService: {
      ingestEvents(items) {
        return { ok: true, count: items.length }
      },
      ingestStatus() {
        return null
      },
    },
    taskAutomationService: {
      notifyRun() {
        return Promise.resolve()
      },
    },
  })
  await app.ready()

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/runner-events',
      headers: buildInternalAuthHeaders(),
      payload: {
        runnerId: 'runner-large-1',
        items: [
          {
            runId: 'run-large-1',
            seq: 1,
            type: 'stdout',
            ts: new Date().toISOString(),
            payload: {
              type: 'stdout',
              text: largeText,
            },
          },
        ],
      },
    })

    assert.equal(response.statusCode, 200)
  } finally {
    await app.close()
  }
})

test('realtime routes are registered on the app', async () => {
  const app = Fastify()

  registerRealtimeRoutes(app, {
    sseHub: {
      addClient() {
        return () => {}
      },
      write() {},
    },
  })
  await app.ready()

  try {
    const routes = app.printRoutes()
    assert.match(routes, /api\/events\/stream/)
  } finally {
    await app.close()
  }
})
