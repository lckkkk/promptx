import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test, { after } from 'node:test'

const sharedTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-maintenance-suite-'))
const sharedDataDir = path.join(sharedTempDir, 'data')
const originalDataDir = process.env.PROMPTX_DATA_DIR
fs.mkdirSync(sharedDataDir, { recursive: true })
process.env.PROMPTX_DATA_DIR = sharedDataDir

let closeDatabaseForTesting = () => {}

after(() => {
  closeDatabaseForTesting()
  if (typeof originalDataDir === 'string') {
    process.env.PROMPTX_DATA_DIR = originalDataDir
  } else {
    delete process.env.PROMPTX_DATA_DIR
  }
  fs.rmSync(sharedTempDir, { recursive: true, force: true })
})

test('maintenance service prunes stale tmp files and runner check directories', async () => {
  const tempDir = path.join(sharedTempDir, 'fs-cleanup')
  const tmpDir = path.join(tempDir, 'tmp')
  const reportDir = path.join(tempDir, 'reports', 'runner-checks')
  fs.mkdirSync(tmpDir, { recursive: true })
  fs.mkdirSync(reportDir, { recursive: true })

  const staleTmpFile = path.join(tmpDir, 'stale.tmp')
  const freshTmpFile = path.join(tmpDir, 'fresh.tmp')
  const staleReportDir = path.join(reportDir, 'old-report')
  const freshReportDir = path.join(reportDir, 'new-report')

  fs.writeFileSync(staleTmpFile, 'stale')
  fs.writeFileSync(freshTmpFile, 'fresh')
  fs.mkdirSync(staleReportDir, { recursive: true })
  fs.mkdirSync(freshReportDir, { recursive: true })

  const staleTime = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
  fs.utimesSync(staleTmpFile, staleTime, staleTime)
  fs.utimesSync(staleReportDir, staleTime, staleTime)

  const { createMaintenanceService } = await import(`./maintenance.js?test=${Date.now()}`)
  const plainDbModule = await import('./db.js')
  closeDatabaseForTesting = plainDbModule.closeDatabaseForTesting
  const service = createMaintenanceService({
    tmpDir,
    cleanupIntervalMs: 60_000,
    reportRetentionMs: 24 * 60 * 60 * 1000,
    tmpFileRetentionMs: 24 * 60 * 60 * 1000,
    reportDirs: [reportDir],
    runEventRetentionMs: 365 * 24 * 60 * 60 * 1000,
  })

  const diagnosticsBefore = service.getDiagnostics()
  assert.equal(diagnosticsBefore.lastCleanup.startedAt, '')

  const result = service.runCleanup()

  assert.equal(fs.existsSync(staleTmpFile), false)
  assert.equal(fs.existsSync(freshTmpFile), true)
  assert.equal(fs.existsSync(staleReportDir), false)
  assert.equal(fs.existsSync(freshReportDir), true)
  assert.equal(result.removedTmpFiles >= 1, true)
})

test('maintenance service prunes stale run events and runs sqlite maintenance', async () => {
  const dbModule = await import('./db.js')
  const { run } = dbModule
  const { listCodexRunEvents } = await import('./codexRuns.js')
  const { createMaintenanceService } = await import(`./maintenance.js?test-db=${Date.now()}`)

  const staleFinishedAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  const recentFinishedAt = new Date().toISOString()

  run(
    `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
     VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
    ['task-maint-1', 'token-1', 'session-maint-1', staleFinishedAt, staleFinishedAt]
  )
  run(
    `INSERT INTO codex_sessions (id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at)
     VALUES (?, ?, 'codex', ?, '', '', '', '{}', ?, ?)`,
    ['session-maint-1', 'Session Maint 1', sharedTempDir, staleFinishedAt, staleFinishedAt]
  )
  run(
    `INSERT INTO codex_runs (id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, 'codex', ?, '[]', 'completed', '', '', ?, ?, ?, ?)`,
    ['run-stale', 'task-maint-1', 'session-maint-1', 'old', staleFinishedAt, staleFinishedAt, staleFinishedAt, staleFinishedAt]
  )
  run(
    `INSERT INTO codex_runs (id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, 'codex', ?, '[]', 'completed', '', '', ?, ?, ?, ?)`,
    ['run-capped', 'task-maint-1', 'session-maint-1', 'new', recentFinishedAt, recentFinishedAt, recentFinishedAt, recentFinishedAt]
  )
  run(
    `INSERT INTO codex_runs (id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
     VALUES (?, ?, ?, 'codex', ?, '[]', 'running', '', '', ?, ?, ?, NULL)`,
    ['run-active', 'task-maint-1', 'session-maint-1', 'active', recentFinishedAt, recentFinishedAt, recentFinishedAt]
  )

  for (let seq = 1; seq <= 3; seq += 1) {
    run(
      `INSERT INTO codex_run_events (run_id, seq, event_type, payload_json, created_at)
       VALUES (?, ?, 'event', '{}', ?)`,
      ['run-stale', seq, staleFinishedAt]
    )
  }
  for (let seq = 1; seq <= 5; seq += 1) {
    run(
      `INSERT INTO codex_run_events (run_id, seq, event_type, payload_json, created_at)
       VALUES (?, ?, 'event', '{}', ?)`,
      ['run-capped', seq, recentFinishedAt]
    )
  }
  for (let seq = 1; seq <= 5; seq += 1) {
    run(
      `INSERT INTO codex_run_events (run_id, seq, event_type, payload_json, created_at)
       VALUES (?, ?, 'event', '{}', ?)`,
      ['run-active', seq, recentFinishedAt]
    )
  }

  const service = createMaintenanceService({
    tmpDir: path.join(sharedTempDir, 'tmp-db-cleanup'),
    cleanupIntervalMs: 60_000,
    runEventRetentionMs: 24 * 60 * 60 * 1000,
    maxRunEventsPerRun: 2,
    dbVacuumIntervalMs: 60_000,
  })

  const result = service.runCleanup({ forceDbVacuum: true })

  assert.equal(result.runEvents.removedByRetention, 3)
  assert.equal(result.runEvents.removedByCount, 3)
  assert.equal(result.runEvents.removedTotal, 6)
  assert.equal(result.dbMaintenance.vacuumed, true)
  assert.equal(listCodexRunEvents('run-stale')?.length, 0)
  assert.deepEqual(
    (listCodexRunEvents('run-capped') || []).map((item) => item.seq),
    [4, 5]
  )
  assert.equal(listCodexRunEvents('run-active')?.length, 5)

  const diagnostics = service.getDiagnostics()
  assert.equal(diagnostics.runEventRetentionMs, 24 * 60 * 60 * 1000)
  assert.equal(diagnostics.maxRunEventsPerRun, 2)
  assert.equal(diagnostics.lastCleanup.runEvents.removedTotal, 6)
  assert.equal(diagnostics.lastCleanup.dbMaintenance.vacuumed, true)
  assert.ok(diagnostics.db.dbPath.endsWith('promptx.sqlite'))
})
