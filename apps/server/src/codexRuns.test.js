import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('listTaskCodexRunsWithOptions 支持 events=none|latest|all，并兼容旧参数', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-runs-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const {
      appendCodexRunEvent,
      listTaskCodexRunsWithOptions,
    } = await import(`./codexRuns.js?test=${Date.now()}`)

    const now = new Date().toISOString()
    const earlier = new Date(Date.now() - 60_000).toISOString()

    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-1', 'token-1', 'session-1', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-1', 'Repo Session', tempDir, now, now]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'completed', '', '', ?, ?, ?, ?)`,
      ['run-1', 'task-1', 'session-1', 'hello', JSON.stringify([
        { type: 'text', content: '请看这张图', meta: {} },
        { type: 'image', content: '/uploads/demo.png', meta: {} },
      ]), now, now, now, now]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, 'completed', '', '', ?, ?, ?, ?)`,
      ['run-2', 'task-1', 'session-1', 'older', '[]', earlier, earlier, earlier, earlier]
    )

    appendCodexRunEvent('run-1', 1, { type: 'turn.started' })
    appendCodexRunEvent('run-1', 2, { type: 'turn.completed' })
    appendCodexRunEvent('run-2', 1, { type: 'thread.started', thread_id: 'thread-older' })

    const summaryRuns = listTaskCodexRunsWithOptions('task-1', { limit: 20, events: 'none' })
    assert.equal(summaryRuns?.length, 2)
    assert.equal(summaryRuns[0].id, 'run-1')
    assert.equal(summaryRuns[0].eventCount, 2)
    assert.equal(summaryRuns[0].lastEventSeq, 2)
    assert.equal(summaryRuns[0].eventsIncluded, false)
    assert.deepEqual(summaryRuns[0].events, [])
    assert.deepEqual(summaryRuns[0].promptBlocks, [
      { type: 'text', content: '请看这张图', meta: {} },
      { type: 'image', content: '/uploads/demo.png', meta: {} },
    ])
    assert.equal(summaryRuns[1].id, 'run-2')
    assert.equal(summaryRuns[1].eventsIncluded, false)
    assert.deepEqual(summaryRuns[1].events, [])

    const latestRuns = listTaskCodexRunsWithOptions('task-1', { limit: 20, events: 'latest' })
    assert.equal(latestRuns?.length, 2)
    assert.equal(latestRuns[0].eventsIncluded, true)
    assert.deepEqual(latestRuns[0].events.map((item) => item.seq), [1, 2])
    assert.equal(latestRuns[1].eventsIncluded, false)
    assert.deepEqual(latestRuns[1].events, [])

    const detailedRuns = listTaskCodexRunsWithOptions('task-1', { limit: 20, events: 'all' })
    assert.equal(detailedRuns?.length, 2)
    assert.equal(detailedRuns[0].eventsIncluded, true)
    assert.deepEqual(detailedRuns[0].events.map((item) => item.seq), [1, 2])
    assert.equal(detailedRuns[1].eventsIncluded, true)
    assert.deepEqual(detailedRuns[1].events.map((item) => item.seq), [1])

    const legacyAllRuns = listTaskCodexRunsWithOptions('task-1', { limit: 20, includeEvents: true })
    assert.equal(legacyAllRuns?.[0]?.eventsIncluded, true)
    assert.equal(legacyAllRuns?.[1]?.eventsIncluded, true)

    const legacyLatestRuns = listTaskCodexRunsWithOptions('task-1', { limit: 20, includeLatestEvents: true })
    assert.equal(legacyLatestRuns?.[0]?.eventsIncluded, true)
    assert.equal(legacyLatestRuns?.[1]?.eventsIncluded, false)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
