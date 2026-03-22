import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('maintenance service prunes stale tmp files and runner check directories', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-maintenance-'))
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
  const service = createMaintenanceService({
    tmpDir,
    cleanupIntervalMs: 60_000,
    reportRetentionMs: 24 * 60 * 60 * 1000,
    tmpFileRetentionMs: 24 * 60 * 60 * 1000,
    reportDirs: [reportDir],
  })

  const diagnosticsBefore = service.getDiagnostics()
  assert.equal(diagnosticsBefore.lastCleanup.startedAt, '')

  const result = service.runCleanup()

  assert.equal(fs.existsSync(staleTmpFile), false)
  assert.equal(fs.existsSync(freshTmpFile), true)
  assert.equal(fs.existsSync(staleReportDir), false)
  assert.equal(fs.existsSync(freshReportDir), true)
  assert.equal(result.removedTmpFiles >= 1, true)

  fs.rmSync(tempDir, { recursive: true, force: true })
})
