import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('runRecovery 会回收失联的 active run，并按状态落到 error / stop_timeout', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-run-recovery-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const suffix = `test=${Date.now()}`
    const { get, run } = await import(`./db.js?${suffix}`)
    const { createRunRecoveryService } = await import(`./runRecovery.js?${suffix}`)

    const staleAt = new Date(Date.now() - 60_000).toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-1', 'token-1', 'session-1', staleAt, staleAt]
    )
    run(
      `INSERT INTO codex_sessions (id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at)
       VALUES (?, ?, 'codex', ?, '', '', '', '{}', ?, ?)`,
      ['session-1', 'Session 1', tempDir, staleAt, staleAt]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, 'codex', ?, '[]', 'running', '', '', ?, ?, ?, NULL)`,
      ['run-1', 'task-1', 'session-1', 'hello', staleAt, staleAt, staleAt]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, 'codex', ?, '[]', 'stopping', '', '', ?, ?, ?, NULL)`,
      ['run-2', 'task-1', 'session-1', 'hello2', staleAt, staleAt, staleAt]
    )

    const recovered = []
    const recovery = createRunRecoveryService({
      staleThresholdMs: 5000,
      onRecoveredRun(runRecord) {
        recovered.push(runRecord.id)
      },
    })

    const sweptRuns = recovery.sweep()
    assert.equal(sweptRuns.length, 2)
    assert.deepEqual(new Set(recovered), new Set(['run-1', 'run-2']))
    assert.equal(get(`SELECT status FROM codex_runs WHERE id = ?`, ['run-1'])?.status, 'error')
    assert.equal(get(`SELECT status FROM codex_runs WHERE id = ?`, ['run-2'])?.status, 'stop_timeout')

    const diagnostics = recovery.getDiagnostics()
    assert.equal(diagnostics.metrics.totalSweeps, 1)
    assert.equal(diagnostics.metrics.totalRecovered, 2)
    assert.equal(diagnostics.metrics.totalRecoveredToError, 1)
    assert.equal(diagnostics.metrics.totalRecoveredToStopTimeout, 1)
    assert.deepEqual(new Set(diagnostics.metrics.lastRecoveredRunIds), new Set(['run-1', 'run-2']))
    assert.equal(diagnostics.config.staleThresholdMs, 5000)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('runRecovery 在计划内重启宽限期内不会回收 active run', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-run-recovery-grace-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const suffix = `test=${Date.now()}`
    const { get, run } = await import(`./db.js?${suffix}`)
    const { createRunRecoveryService } = await import(`./runRecovery.js?${suffix}`)

    const staleAt = new Date(Date.now() - 60_000).toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-2', 'token-2', 'session-2', staleAt, staleAt]
    )
    run(
      `INSERT INTO codex_sessions (id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at)
       VALUES (?, ?, 'codex', ?, '', '', '', '{}', ?, ?)`,
      ['session-2', 'Session 2', tempDir, staleAt, staleAt]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, 'codex', ?, '[]', 'running', '', '', ?, ?, ?, NULL)`,
      ['run-3', 'task-2', 'session-2', 'hello', staleAt, staleAt, staleAt]
    )

    const recovery = createRunRecoveryService({
      staleThresholdMs: 5000,
      getPlannedRestartRemainingMs() {
        return 60_000
      },
    })

    const sweptRuns = recovery.sweep()
    assert.equal(sweptRuns.length, 0)
    assert.equal(get(`SELECT status FROM codex_runs WHERE id = ?`, ['run-3'])?.status, 'running')
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
