import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

function git(cwd, args = []) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

test('git diff subprocess client returns the same task diff payload', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-client-'))
  const repoDir = path.join(tempDir, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'promptx@example.com'])
  git(repoDir, ['config', 'user.name', 'PromptX'])

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n')
  git(repoDir, ['add', 'tracked.txt'])
  git(repoDir, ['commit', '-m', 'init'])

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import(`./db.js?test=${Date.now()}`)
    const {
      captureTaskGitBaseline,
      getTaskGitDiffReview,
    } = await import(`./gitDiff.js?test=${Date.now()}`)
    const {
      __getGitDiffWorkerPidForTest,
      getGitDiffWorkerDiagnostics,
      getTaskGitDiffReviewInSubprocess,
      stopGitDiffWorker,
    } = await import(`./gitDiffClient.js?test=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-client', 'token-client', 'session-client', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-client', 'Repo Session', repoDir, now, now]
    )

    captureTaskGitBaseline('task-client', repoDir)

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello\n')

    const directPayload = getTaskGitDiffReview('task-client', { scope: 'task' })
    const workerPayload = await getTaskGitDiffReviewInSubprocess('task-client', { scope: 'task' })
    const firstWorkerPid = __getGitDiffWorkerPidForTest()
    const secondWorkerPayload = await getTaskGitDiffReviewInSubprocess('task-client', { scope: 'task', includeFiles: false, includeStats: true })
    const secondWorkerPid = __getGitDiffWorkerPidForTest()
    const diagnostics = getGitDiffWorkerDiagnostics()

    assert.deepEqual(workerPayload.summary, directPayload.summary)
    assert.deepEqual(
      workerPayload.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
      directPayload.files.map((file) => ({
        path: file.path,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      }))
    )
    assert.equal(firstWorkerPid > 0, true)
    assert.equal(secondWorkerPid, firstWorkerPid)
    assert.deepEqual(secondWorkerPayload.summary, {
      fileCount: 2,
      additions: 2,
      deletions: 1,
      statsComplete: true,
    })
    assert.equal(diagnostics.worker.running, true)
    assert.equal(diagnostics.worker.pid, firstWorkerPid)
    assert.equal(diagnostics.metrics.totalRequests >= 2, true)
    assert.equal(diagnostics.metrics.completedRequests >= 2, true)
    assert.equal(diagnostics.metrics.lastRequest?.status, 'completed')
    assert.equal(diagnostics.metrics.lastRequest?.scope, 'task')

    stopGitDiffWorker()
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'undefined') {
      delete process.env.PROMPTX_DATA_DIR
    } else {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore sqlite handle cleanup timing in test process.
    }
  }
})
