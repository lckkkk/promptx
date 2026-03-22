import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('runEventIngest 会写入事件、同步 session 更新并推进 run 状态', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-run-ingest-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const suffix = `test=${Date.now()}`
    const { run } = await import(`./db.js?${suffix}`)
    const { createRunEventIngestService } = await import(`./runEventIngest.js?${suffix}`)
    const { getCodexRunById, listCodexRunEvents } = await import(`./codexRuns.js?${suffix}`)
    const { getPromptxCodexSessionById } = await import(`./codexSessions.js?${suffix}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-1', 'token-1', 'session-1', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at)
       VALUES (?, ?, 'codex', ?, '', '', '', '{}', ?, ?)`,
      ['session-1', 'Session 1', tempDir, now, now]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, 'codex', ?, '[]', 'queued', '', '', ?, ?, NULL, NULL)`,
      ['run-1', 'task-1', 'session-1', 'hello', now, now]
    )

    const broadcasts = []
    const ingest = createRunEventIngestService({
      broadcastServerEvent(type, payload = {}) {
        broadcasts.push({ type, ...payload })
      },
    })

    const eventsResult = ingest.ingestEvents([
      {
        runId: 'run-1',
        seq: 1,
        type: 'session.updated',
        ts: now,
        payload: {
          type: 'session.updated',
          session: {
            id: 'session-1',
            codexThreadId: 'thread-1',
            engineThreadId: 'thread-1',
            updatedAt: now,
          },
        },
      },
      {
        runId: 'run-1',
        seq: 2,
        type: 'stdout',
        ts: now,
        payload: {
          type: 'stdout',
          text: 'hello world',
        },
      },
    ])

    assert.equal(eventsResult.ok, true)
    assert.equal(listCodexRunEvents('run-1')?.length, 2)
    assert.equal(getPromptxCodexSessionById('session-1')?.engineThreadId, 'thread-1')

    const runningRun = ingest.ingestStatus({
      runId: 'run-1',
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
    })
    assert.equal(runningRun?.status, 'running')

    const completedRun = ingest.ingestStatus({
      runId: 'run-1',
      status: 'completed',
      responseMessage: 'done',
      finishedAt: now,
      heartbeatAt: now,
      session: {
        id: 'session-1',
        codexThreadId: 'thread-1',
        engineThreadId: 'thread-1',
        updatedAt: now,
      },
    })

    const storedRun = getCodexRunById('run-1')
    assert.equal(completedRun?.status, 'completed')
    assert.equal(storedRun?.status, 'completed')
    assert.equal(storedRun?.responseMessage, 'done')
    assert.ok(broadcasts.some((item) => item.type === 'run.event' && item.runId === 'run-1'))
    assert.ok(broadcasts.some((item) => item.type === 'runs.changed' && item.runId === 'run-1'))
    assert.ok(broadcasts.some((item) => item.type === 'sessions.changed' && item.sessionId === 'session-1'))

    const lateHeartbeatAt = new Date(Date.now() + 1000).toISOString()
    const staleRun = ingest.ingestStatus({
      runId: 'run-1',
      status: 'running',
      responseMessage: 'should-be-ignored',
      heartbeatAt: lateHeartbeatAt,
      session: {
        id: 'session-1',
        codexThreadId: 'thread-1',
        engineThreadId: 'thread-1',
        updatedAt: lateHeartbeatAt,
      },
    })

    const storedRunAfterLateHeartbeat = getCodexRunById('run-1')
    assert.equal(staleRun?.status, 'completed')
    assert.equal(storedRunAfterLateHeartbeat?.status, 'completed')
    assert.equal(storedRunAfterLateHeartbeat?.responseMessage, 'done')
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
