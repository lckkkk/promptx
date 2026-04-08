import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

function git(cwd, args = []) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

test('git diff review returns task and run scoped file changes for git workspaces', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-'))
  const repoDir = path.join(tempDir, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'promptx@example.com'])
  git(repoDir, ['config', 'user.name', 'PromptX'])

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n')
  git(repoDir, ['add', 'tracked.txt'])
  git(repoDir, ['commit', '-m', 'init'])
  const branchName = git(repoDir, ['symbolic-ref', '--short', 'HEAD'])

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const {
      __getGitDiffCacheMetricsForTest,
      __resetGitDiffCachesForTest,
      captureRunGitBaseline,
      captureRunGitFinalSnapshot,
      captureTaskGitBaseline,
      getGitDiffCacheDebugSnapshot,
      getTaskGitDiffReview,
      getWorkspaceGitDiffReviewByCwd,
      getWorkspaceGitDiffStatusSummaryByCwd,
    } = await import(`./gitDiff.js?test=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-1', 'token-1', 'session-1', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-1', 'Repo Session', repoDir, now, now]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, '', 'running', '', '', ?, ?, ?, NULL)`,
      ['run-1', 'task-1', 'session-1', now, now, now]
    )

    captureTaskGitBaseline('task-1', repoDir)
    captureRunGitBaseline('run-1', repoDir)

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello\n')
    captureRunGitFinalSnapshot('run-1', repoDir)

    const workspaceDiff = getTaskGitDiffReview('task-1', { scope: 'workspace' })
    const workspaceDiffByCwd = getWorkspaceGitDiffReviewByCwd(repoDir)
    const workspaceStatusSummary = getWorkspaceGitDiffStatusSummaryByCwd(repoDir)
    const taskDiffFast = getTaskGitDiffReview('task-1', { scope: 'task', includeStats: false })
    const taskDiffSummaryOnly = getTaskGitDiffReview('task-1', {
      scope: 'task',
      includeFiles: false,
      includeStats: true,
    })
    const taskDiff = getTaskGitDiffReview('task-1', { scope: 'task' })
    const taskTrackedDetail = getTaskGitDiffReview('task-1', { scope: 'task', filePath: 'tracked.txt' })
    const taskNewFileDetail = getTaskGitDiffReview('task-1', { scope: 'task', filePath: 'new-file.txt' })
    const runDiff = getTaskGitDiffReview('task-1', { scope: 'run', runId: 'run-1' })

    assert.equal(workspaceDiff.supported, true)
    assert.equal(workspaceDiff.branch, branchName)
    assert.deepEqual(workspaceDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(workspaceDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
    assert.deepEqual(workspaceDiffByCwd.summary, workspaceDiff.summary)
    assert.deepEqual(workspaceDiffByCwd.files.map((file) => `${file.status}:${file.path}`), workspaceDiff.files.map((file) => `${file.status}:${file.path}`))
    assert.equal(workspaceStatusSummary.supported, true)
    assert.equal(workspaceStatusSummary.branch, branchName)
    assert.deepEqual(workspaceStatusSummary.summary, {
      fileCount: 2,
      additions: 0,
      deletions: 0,
      statsComplete: false,
    })
    assert.deepEqual(workspaceStatusSummary.files, [])

    assert.equal(taskDiff.supported, true)
    assert.equal(taskDiff.branch, branchName)
    assert.equal(taskDiff.summary.fileCount, 2)
    assert.deepEqual(taskDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(taskDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
    assert.equal(taskDiff.baseline?.branch, branchName)
    assert.equal(taskDiff.baseline?.headShort, taskDiff.baseline?.headOid.slice(0, 7))
    assert.deepEqual(taskDiff.warnings, [])
    assert.equal(taskDiff.files.find((file) => file.path === 'tracked.txt')?.patchLoaded, false)
    assert.equal(taskDiffFast.summary.statsComplete, false)
    assert.equal(taskDiffFast.summary.fileCount, 2)
    assert.equal(taskDiffFast.files.find((file) => file.path === 'tracked.txt')?.statsLoaded, false)
    assert.equal(taskDiffFast.files.find((file) => file.path === 'tracked.txt')?.additions, null)
    assert.deepEqual(taskDiffSummaryOnly.files, [])
    assert.equal(taskDiffSummaryOnly.summary.statsComplete, true)
    assert.deepEqual(taskDiffSummaryOnly.summary, {
      fileCount: 2,
      additions: 2,
      deletions: 1,
      statsComplete: true,
    })
    assert.deepEqual(taskTrackedDetail.files.map((file) => file.path), ['tracked.txt'])
    assert.match(taskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /--- a\/tracked\.txt/)
    assert.match(taskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /\+\+\+ b\/tracked\.txt/)
    assert.deepEqual(taskNewFileDetail.files.map((file) => file.path), ['new-file.txt'])
    assert.match(taskNewFileDetail.files.find((file) => file.path === 'new-file.txt')?.patch || '', /hello/)
    assert.deepEqual(
      taskDiff.files.find((file) => file.path === 'tracked.txt')
        ? {
            additions: taskDiff.files.find((file) => file.path === 'tracked.txt').additions,
            deletions: taskDiff.files.find((file) => file.path === 'tracked.txt').deletions,
          }
        : null,
      { additions: 1, deletions: 1 }
    )

    __resetGitDiffCachesForTest()
    getTaskGitDiffReview('task-1', { scope: 'task' })
    const firstCacheMetrics = __getGitDiffCacheMetricsForTest()
    getTaskGitDiffReview('task-1', { scope: 'task' })
    const secondCacheMetrics = __getGitDiffCacheMetricsForTest()
    const cacheSnapshot = getGitDiffCacheDebugSnapshot()
    assert.equal(firstCacheMetrics.reviewHits, 0)
    assert.equal(secondCacheMetrics.reviewHits, 1)
    assert.equal(cacheSnapshot.reviewCacheSize >= 1, true)
    assert.equal(cacheSnapshot.fileCacheSize >= 1, true)

    assert.equal(runDiff.supported, true)
    assert.equal(runDiff.branch, branchName)
    assert.equal(runDiff.summary.fileCount, 2)
    assert.deepEqual(runDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(runDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after-later\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello later\n')
    fs.writeFileSync(path.join(repoDir, 'later-file.txt'), 'later\n')
    const stableRunDiff = getTaskGitDiffReview('task-1', { scope: 'run', runId: 'run-1' })
    assert.deepEqual(stableRunDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(stableRunDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello\n')
    fs.rmSync(path.join(repoDir, 'later-file.txt'), { force: true })

    git(repoDir, ['add', 'tracked.txt', 'new-file.txt'])
    git(repoDir, ['commit', '-m', 'persist tracked and new file changes'])

    const committedWorkspaceDiff = getTaskGitDiffReview('task-1', { scope: 'workspace' })
    const committedTaskDiff = getTaskGitDiffReview('task-1', { scope: 'task' })
    const committedTaskTrackedDetail = getTaskGitDiffReview('task-1', { scope: 'task', filePath: 'tracked.txt' })
    assert.equal(committedWorkspaceDiff.supported, true)
    assert.deepEqual(committedWorkspaceDiff.summary, { fileCount: 0, additions: 0, deletions: 0, statsComplete: true })
    assert.deepEqual(committedWorkspaceDiff.files, [])
    assert.equal(committedTaskDiff.supported, true)
    assert.deepEqual(committedTaskDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(committedTaskDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
    assert.equal(committedTaskDiff.files.find((file) => file.path === 'tracked.txt')?.patchLoaded, false)
    assert.deepEqual(committedTaskTrackedDetail.files.map((file) => file.path), ['tracked.txt'])
    assert.match(committedTaskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /--- a\/tracked\.txt/)
    assert.match(committedTaskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /\+\+\+ b\/tracked\.txt/)
    assert.match(committedTaskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /after/)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('run scoped diff stays pinned to each round snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-rounds-'))
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
    const { run } = await import('./db.js')
    const {
      captureRunGitBaseline,
      captureRunGitFinalSnapshot,
      getTaskGitDiffReview,
    } = await import(`./gitDiff.js?rounds=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-rounds', 'token-rounds', 'session-rounds', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-rounds', 'Repo Session', repoDir, now, now]
    )

    ;['run-round-1', 'run-round-2', 'run-round-3'].forEach((runId) => {
      run(
        `INSERT INTO codex_runs (id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, '', 'completed', '', '', ?, ?, ?, ?)`,
        [runId, 'task-rounds', 'session-rounds', now, now, now, now]
      )
    })

    captureRunGitBaseline('run-round-1', repoDir)
    captureRunGitFinalSnapshot('run-round-1', repoDir)

    captureRunGitBaseline('run-round-2', repoDir)
    captureRunGitFinalSnapshot('run-round-2', repoDir)

    captureRunGitBaseline('run-round-3', repoDir)
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'round-3\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello\n')
    captureRunGitFinalSnapshot('run-round-3', repoDir)

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'later-round\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello later\n')
    fs.writeFileSync(path.join(repoDir, 'later-file.txt'), 'later\n')

    const run1Diff = getTaskGitDiffReview('task-rounds', { scope: 'run', runId: 'run-round-1' })
    const run2Diff = getTaskGitDiffReview('task-rounds', { scope: 'run', runId: 'run-round-2' })
    const run3Diff = getTaskGitDiffReview('task-rounds', { scope: 'run', runId: 'run-round-3' })

    assert.equal(run1Diff.supported, true)
    assert.deepEqual(run1Diff.summary, { fileCount: 0, additions: 0, deletions: 0, statsComplete: true })
    assert.deepEqual(run1Diff.files, [])

    assert.equal(run2Diff.supported, true)
    assert.deepEqual(run2Diff.summary, { fileCount: 0, additions: 0, deletions: 0, statsComplete: true })
    assert.deepEqual(run2Diff.files, [])

    assert.equal(run3Diff.supported, true)
    assert.deepEqual(run3Diff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(run3Diff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('workspace scoped diff uses task cwd instead of collapsing to a single repo root', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-workspace-'))
  const workspaceDir = path.join(tempDir, 'workspace')
  const appDir = path.join(workspaceDir, 'app')
  const adminDir = path.join(workspaceDir, 'admin')
  fs.mkdirSync(appDir, { recursive: true })
  fs.mkdirSync(adminDir, { recursive: true })

  ;[appDir, adminDir].forEach((repoDir) => {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.email', 'promptx@example.com'])
    git(repoDir, ['config', 'user.name', 'PromptX'])
  })

  fs.writeFileSync(path.join(appDir, 'app.txt'), 'app base\n')
  git(appDir, ['add', 'app.txt'])
  git(appDir, ['commit', '-m', 'init app'])

  fs.writeFileSync(path.join(adminDir, 'admin.txt'), 'admin base\n')
  git(adminDir, ['add', 'admin.txt'])
  git(adminDir, ['commit', '-m', 'init admin'])

  fs.writeFileSync(path.join(appDir, 'app.txt'), 'app changed\n')
  fs.writeFileSync(path.join(adminDir, 'admin.txt'), 'admin changed\n')

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const { getTaskGitDiffReview } = await import(`./gitDiff.js?workspace=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-workspace', 'token-workspace', 'session-workspace', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-workspace', 'Workspace Session', workspaceDir, now, now]
    )

    const workspaceDiff = getTaskGitDiffReview('task-workspace', { scope: 'workspace' })

    assert.equal(workspaceDiff.supported, true)
    assert.deepEqual(
      workspaceDiff.files.map((file) => `${file.repoLabel}:${file.status}:${file.path}`),
      ['admin:M:admin.txt', 'app:M:app.txt']
    )
    assert.deepEqual(workspaceDiff.summary, {
      fileCount: 2,
      additions: 2,
      deletions: 2,
      statsComplete: true,
    })
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('workspace diff review aggregates nested git repositories under the workspace cwd', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-multi-repo-'))
  const workspaceDir = path.join(tempDir, 'workspace')
  const appDir = path.join(workspaceDir, 'app')
  const adminDir = path.join(workspaceDir, 'admin')
  fs.mkdirSync(appDir, { recursive: true })
  fs.mkdirSync(adminDir, { recursive: true })

  ;[appDir, adminDir].forEach((repoDir) => {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.email', 'promptx@example.com'])
    git(repoDir, ['config', 'user.name', 'PromptX'])
  })

  fs.writeFileSync(path.join(appDir, 'src.txt'), 'base app\n')
  git(appDir, ['add', 'src.txt'])
  git(appDir, ['commit', '-m', 'init app'])

  fs.writeFileSync(path.join(adminDir, 'src.txt'), 'base admin\n')
  git(adminDir, ['add', 'src.txt'])
  git(adminDir, ['commit', '-m', 'init admin'])

  fs.writeFileSync(path.join(appDir, 'src.txt'), 'changed app\n')
  fs.writeFileSync(path.join(adminDir, 'src.txt'), 'changed admin\n')
  fs.writeFileSync(path.join(adminDir, 'extra.txt'), 'new admin\n')

  const { getWorkspaceGitDiffReviewByCwd, getWorkspaceGitDiffStatusSummaryByCwd } = await import(`./gitDiff.js?multiRepo=${Date.now()}`)
  const workspaceDiff = getWorkspaceGitDiffReviewByCwd(workspaceDir)
  const workspaceStatusSummary = getWorkspaceGitDiffStatusSummaryByCwd(workspaceDir)
  const adminFileDetail = getWorkspaceGitDiffReviewByCwd(workspaceDir, {
    filePath: 'src.txt',
    repoRoot: adminDir,
  })

  assert.equal(workspaceDiff.supported, true)
  assert.equal(workspaceDiff.repoCount, 2)
  assert.deepEqual(workspaceDiff.summary, {
    fileCount: 3,
    additions: 3,
    deletions: 2,
    statsComplete: true,
  })
  assert.deepEqual(
    workspaceDiff.files.map((file) => `${file.repoLabel}:${file.status}:${file.path}`),
    ['admin:A:extra.txt', 'admin:M:src.txt', 'app:M:src.txt']
  )
  assert.equal(
    workspaceDiff.files.find((file) => file.repoLabel === 'admin' && file.path === 'src.txt')?.id,
    `${fs.realpathSync.native(adminDir)}::src.txt`
  )

  assert.equal(workspaceStatusSummary.supported, true)
  assert.equal(workspaceStatusSummary.repoCount, 2)
  assert.deepEqual(workspaceStatusSummary.summary, {
    fileCount: 3,
    additions: 0,
    deletions: 0,
    statsComplete: false,
  })

  assert.equal(adminFileDetail.supported, true)
  assert.equal(adminFileDetail.repoCount, 1)
  assert.deepEqual(adminFileDetail.files.map((file) => `${file.repoLabel}:${file.path}`), ['admin:src.txt'])
  assert.match(adminFileDetail.files[0]?.patch || '', /changed admin/)
})

test('task and run diff review support workspace cwd with multiple nested git repositories', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-workspace-baseline-'))
  const workspaceDir = path.join(tempDir, 'workspace')
  const appDir = path.join(workspaceDir, 'app')
  const adminDir = path.join(workspaceDir, 'admin')
  fs.mkdirSync(appDir, { recursive: true })
  fs.mkdirSync(adminDir, { recursive: true })

  ;[appDir, adminDir].forEach((repoDir) => {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.email', 'promptx@example.com'])
    git(repoDir, ['config', 'user.name', 'PromptX'])
  })

  fs.writeFileSync(path.join(appDir, 'src.txt'), 'base app\n')
  git(appDir, ['add', 'src.txt'])
  git(appDir, ['commit', '-m', 'init app'])

  fs.writeFileSync(path.join(adminDir, 'src.txt'), 'base admin\n')
  git(adminDir, ['add', 'src.txt'])
  git(adminDir, ['commit', '-m', 'init admin'])

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const {
      captureRunGitBaseline,
      captureRunGitFinalSnapshot,
      captureTaskGitBaseline,
      getTaskGitDiffReview,
    } = await import(`./gitDiff.js?workspaceBaseline=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-workspace-baseline', 'token-workspace-baseline', 'session-workspace-baseline', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-workspace-baseline', 'Workspace Baseline Session', workspaceDir, now, now]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, '', 'completed', '', '', ?, ?, ?, ?)`,
      ['run-workspace-baseline', 'task-workspace-baseline', 'session-workspace-baseline', now, now, now, now]
    )

    captureTaskGitBaseline('task-workspace-baseline', workspaceDir)
    captureRunGitBaseline('run-workspace-baseline', workspaceDir)

    fs.writeFileSync(path.join(appDir, 'src.txt'), 'changed app\n')
    fs.writeFileSync(path.join(adminDir, 'src.txt'), 'changed admin\n')
    fs.writeFileSync(path.join(adminDir, 'extra.txt'), 'new admin\n')

    captureRunGitFinalSnapshot('run-workspace-baseline', workspaceDir)

    const taskDiff = getTaskGitDiffReview('task-workspace-baseline', { scope: 'task' })
    const runDiff = getTaskGitDiffReview('task-workspace-baseline', {
      scope: 'run',
      runId: 'run-workspace-baseline',
    })

    assert.equal(taskDiff.supported, true)
    assert.deepEqual(
      taskDiff.files.map((file) => `${file.repoLabel}:${file.status}:${file.path}`),
      ['admin:A:extra.txt', 'admin:M:src.txt', 'app:M:src.txt']
    )

    assert.equal(runDiff.supported, true)
    assert.deepEqual(
      runDiff.files.map((file) => `${file.repoLabel}:${file.status}:${file.path}`),
      ['admin:A:extra.txt', 'admin:M:src.txt', 'app:M:src.txt']
    )
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('task and run diff review fall back to workspace diff for legacy invalid single-repo baselines', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-legacy-fallback-'))
  const workspaceDir = path.join(tempDir, 'workspace')
  const appDir = path.join(workspaceDir, 'app')
  const adminDir = path.join(workspaceDir, 'admin')
  fs.mkdirSync(appDir, { recursive: true })
  fs.mkdirSync(adminDir, { recursive: true })

  ;[appDir, adminDir].forEach((repoDir) => {
    git(repoDir, ['init'])
    git(repoDir, ['config', 'user.email', 'promptx@example.com'])
    git(repoDir, ['config', 'user.name', 'PromptX'])
  })

  fs.writeFileSync(path.join(appDir, 'src.txt'), 'base app\n')
  git(appDir, ['add', 'src.txt'])
  git(appDir, ['commit', '-m', 'init app'])

  fs.writeFileSync(path.join(adminDir, 'src.txt'), 'base admin\n')
  git(adminDir, ['add', 'src.txt'])
  git(adminDir, ['commit', '-m', 'init admin'])

  fs.writeFileSync(path.join(appDir, 'src.txt'), 'changed app\n')
  fs.writeFileSync(path.join(adminDir, 'src.txt'), 'changed admin\n')

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const { getTaskGitDiffReview } = await import(`./gitDiff.js?legacyFallback=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-legacy-fallback', 'token-legacy-fallback', 'session-legacy-fallback', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-legacy-fallback', 'Legacy Workspace Session', workspaceDir, now, now]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, '', 'completed', '', '', ?, ?, ?, ?)`,
      ['run-legacy-fallback', 'task-legacy-fallback', 'session-legacy-fallback', now, now, now, now]
    )
    run(
      `INSERT INTO task_git_baselines (task_slug, repo_root, head_oid, branch_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['task-legacy-fallback', workspaceDir, 'legacy-head', 'main', now, now]
    )
    run(
      `INSERT INTO run_git_baselines (run_id, repo_root, head_oid, branch_label, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      ['run-legacy-fallback', workspaceDir, 'legacy-head', 'main', now]
    )

    const taskDiff = getTaskGitDiffReview('task-legacy-fallback', { scope: 'task' })
    const runDiff = getTaskGitDiffReview('task-legacy-fallback', {
      scope: 'run',
      runId: 'run-legacy-fallback',
    })

    assert.equal(taskDiff.supported, true)
    assert.match(taskDiff.warnings[0] || '', /旧版单仓库代码变更基线已失效/)
    assert.deepEqual(
      taskDiff.files.map((file) => `${file.repoLabel}:${file.status}:${file.path}`),
      ['admin:M:src.txt', 'app:M:src.txt']
    )

    assert.equal(runDiff.supported, true)
    assert.match(runDiff.warnings[0] || '', /旧版单仓库代码变更基线已失效/)
    assert.deepEqual(
      runDiff.files.map((file) => `${file.repoLabel}:${file.status}:${file.path}`),
      ['admin:M:src.txt', 'app:M:src.txt']
    )
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
