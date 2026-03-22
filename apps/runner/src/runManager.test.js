import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRunManager } from './runManager.js'

function createFakeServerClient() {
  return {
    events: [],
    statuses: [],
    async postEvents(items = []) {
      this.events.push(...items)
      return { ok: true }
    },
    async postStatus(payload = {}) {
      this.statuses.push(payload)
      return { ok: true }
    },
  }
}

test('runManager.getRun 对不存在的 run 返回 null', () => {
  const runManager = createRunManager({
    serverClient: createFakeServerClient(),
    resolveRunner() {
      throw new Error('should not resolve runner')
    },
  })

  assert.equal(runManager.getRun('missing-run'), null)
})

test('runManager 可以驱动一个最小 fake runner 完成执行并推送状态和事件', async () => {
  const serverClient = createFakeServerClient()
  const runManager = createRunManager({
    serverClient,
    resolveRunner() {
      return {
        streamSessionPrompt(session, prompt, callbacks = {}) {
          callbacks.onEvent?.({ type: 'stdout', text: `${session.id}:${prompt}` })
          callbacks.onThreadStarted?.('thread-test-1')
          return {
            child: {
              pid: 4321,
              exitCode: 0,
              signalCode: null,
            },
            result: Promise.resolve({
              sessionId: session.id,
              threadId: 'thread-test-1',
              message: 'done',
            }),
            cancel() {},
          }
        },
      }
    },
  })

  const snapshot = await runManager.startRun({
    runId: 'run-1',
    taskSlug: 'task-1',
    sessionId: 'session-1',
    title: 'Session 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello',
  })

  assert.equal(snapshot.runId, 'run-1')
  assert.ok(['starting', 'running'].includes(snapshot.status))

  await delay(20)

  const statuses = serverClient.statuses.map((item) => item.status)
  assert.ok(statuses.includes('starting'))
  assert.ok(statuses.includes('running'))
  assert.ok(statuses.includes('completed'))

  const eventTypes = serverClient.events.map((item) => item.payload?.type || item.type)
  assert.ok(eventTypes.includes('session'))
  assert.ok(eventTypes.includes('stdout'))
  assert.ok(eventTypes.includes('session.updated'))
  assert.equal(runManager.getRun('run-1'), null)
})


test('runManager.getDiagnostics 返回活跃 run 和统计信息', async () => {
  const runManager = createRunManager({
    serverClient: createFakeServerClient(),
    resolveRunner() {
      return {
        streamSessionPrompt(session) {
          return {
            child: {
              pid: 5678,
              exitCode: null,
              signalCode: null,
            },
            result: delay(40).then(() => ({
              sessionId: session.id,
              threadId: 'thread-diag-1',
              message: 'done',
            })),
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-diag-1',
    taskSlug: 'task-diag-1',
    sessionId: 'session-diag-1',
    title: 'Session Diag 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello',
  })

  const diagnosticsWhileRunning = runManager.getDiagnostics()
  assert.equal(diagnosticsWhileRunning.activeRunCount, 1)
  assert.equal(diagnosticsWhileRunning.metrics.totalStarted, 1)
  assert.equal(diagnosticsWhileRunning.activeRuns[0]?.runId, 'run-diag-1')
  assert.equal(diagnosticsWhileRunning.activeRuns[0]?.cwd, process.cwd())

  await delay(70)

  const diagnosticsAfterComplete = runManager.getDiagnostics()
  assert.equal(diagnosticsAfterComplete.activeRunCount, 0)
  assert.equal(diagnosticsAfterComplete.metrics.totalCompleted, 1)
})
