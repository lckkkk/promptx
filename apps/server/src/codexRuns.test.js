import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('listTaskCodexRunsWithOptions omits events by default and can include them on demand', async () => {
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

    appendCodexRunEvent('run-1', 1, { type: 'turn.started' })
    appendCodexRunEvent('run-1', 2, { type: 'turn.completed' })

    const summaryRuns = listTaskCodexRunsWithOptions('task-1', { limit: 20 })
    assert.equal(summaryRuns?.length, 1)
    assert.equal(summaryRuns[0].eventCount, 2)
    assert.equal(summaryRuns[0].lastEventSeq, 2)
    assert.equal(summaryRuns[0].eventsIncluded, false)
    assert.deepEqual(summaryRuns[0].events, [])
    assert.deepEqual(summaryRuns[0].promptBlocks, [
      { type: 'text', content: '请看这张图', meta: {} },
      { type: 'image', content: '/uploads/demo.png', meta: {} },
    ])

    const detailedRuns = listTaskCodexRunsWithOptions('task-1', { limit: 20, includeEvents: true })
    assert.equal(detailedRuns?.length, 1)
    assert.equal(detailedRuns[0].eventCount, 2)
    assert.equal(detailedRuns[0].lastEventSeq, 2)
    assert.equal(detailedRuns[0].eventsIncluded, true)
    assert.deepEqual(detailedRuns[0].events.map((item) => item.seq), [1, 2])
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
