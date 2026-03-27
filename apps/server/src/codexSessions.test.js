import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('未启动的项目允许切换执行引擎，已启动后不允许', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-sessions-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  const workspaceDir = path.join(tempDir, 'workspace')

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workspaceDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { createPromptxCodexSession, updatePromptxCodexSession } = await import(`./codexSessions.js?test=${Date.now()}`)

    const created = createPromptxCodexSession({
      title: 'Engine Switch Test',
      cwd: workspaceDir,
      engine: 'codex',
    })

    const switched = updatePromptxCodexSession(created.id, {
      engine: 'opencode',
    })

    assert.equal(switched?.engine, 'opencode')

    const started = updatePromptxCodexSession(created.id, {
      codexThreadId: 'thread-1',
      engineThreadId: 'thread-1',
    })

    assert.equal(started?.started, true)

    assert.throws(() => {
      updatePromptxCodexSession(created.id, {
        engine: 'claude-code',
      })
    }, /不能直接切换执行引擎/)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('手动填写会话 ID 后，项目在真正运行前仍允许修改，运行后锁定', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-sessions-manual-'))
  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  const workspaceDirA = path.join(tempDir, 'workspace-a')
  const workspaceDirB = path.join(tempDir, 'workspace-b')

  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(workspaceDirA, { recursive: true })
  fs.mkdirSync(workspaceDirB, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { createPromptxCodexSession, updatePromptxCodexSession } = await import(`./codexSessions.js?test=${Date.now()}`)

    const created = createPromptxCodexSession({
      title: 'Resume Existing Session',
      cwd: workspaceDirA,
      engine: 'codex',
      sessionId: 'thread-manual-1',
    })

    assert.equal(created?.started, false)
    assert.equal(created?.sessionId, 'thread-manual-1')
    assert.equal(created?.engineMeta?.manualSessionBinding, true)

    const updatedBeforeStart = updatePromptxCodexSession(created.id, {
      cwd: workspaceDirB,
      engine: 'claude-code',
      sessionId: 'claude-session-2',
    })

    assert.equal(updatedBeforeStart?.started, false)
    assert.equal(updatedBeforeStart?.cwd, workspaceDirB)
    assert.equal(updatedBeforeStart?.engine, 'claude-code')
    assert.equal(updatedBeforeStart?.sessionId, 'claude-session-2')
    assert.equal(updatedBeforeStart?.engineSessionId, 'claude-session-2')
    assert.equal(updatedBeforeStart?.engineThreadId, 'claude-session-2')

    const started = updatePromptxCodexSession(created.id, {
      engineSessionId: 'claude-session-2',
      engineThreadId: 'claude-session-2',
      clearManualSessionBinding: true,
    })

    assert.equal(started?.started, true)
    assert.equal(started?.engineMeta?.manualSessionBinding, undefined)

    assert.throws(() => {
      updatePromptxCodexSession(created.id, {
        sessionId: 'claude-session-3',
      })
    }, /不能直接修改会话 ID/)

    assert.throws(() => {
      updatePromptxCodexSession(created.id, {
        cwd: workspaceDirA,
      })
    }, /不能直接修改工作目录/)

    assert.throws(() => {
      updatePromptxCodexSession(created.id, {
        engine: 'opencode',
      })
    }, /不能直接切换执行引擎/)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
