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
