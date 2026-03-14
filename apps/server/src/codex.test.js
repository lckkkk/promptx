import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'

const require = createRequire(import.meta.url)
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
const SQL = await initSqlJs({
  locateFile: () => wasmPath,
})

function withEnv(overrides, fn) {
  const previous = new Map()

  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    if (typeof value === 'undefined') {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (typeof value === 'undefined') {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    })
}

async function importFreshCodexModule() {
  return import(`./codex.js?test=${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

function createFakeCodexBinary(tempDir) {
  const scriptPath = path.join(tempDir, process.platform === 'win32' ? 'fake-codex.js' : 'fake-codex')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')

const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output-last-message')
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''
const resumeIndex = args.indexOf('resume')
const resumeTarget = resumeIndex >= 0 ? args[resumeIndex + 1] || '' : ''
const threadId = resumeTarget || 'thread-new-123'

let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  prompt += chunk
})
process.stdin.on('end', () => {
  if (prompt.includes('fail-case')) {
    process.stderr.write('mocked codex failure\\n')
    process.exit(2)
    return
  }

  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')

  if (prompt.includes('stream-tail-case')) {
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'stream tail message',
      },
    }))
    return
  }

  if (outputFile) {
    fs.writeFileSync(outputFile, \`thread:\${threadId}\\nprompt:\${prompt.trim()}\\ncwd:\${process.cwd()}\\n\`)
  }

  process.stdout.write(JSON.stringify({
    type: 'item.completed',
    item: {
      type: 'agent_message',
      text: 'ok',
    },
  }) + '\\n')
})
`

  fs.writeFileSync(scriptPath, script, { mode: 0o755 })

  if (process.platform !== 'win32') {
    return scriptPath
  }

  const cmdPath = path.join(tempDir, 'fake-codex.cmd')
  fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n')
  return cmdPath
}

function createWindowsCodexCommand(tempDir) {
  const scriptPath = path.join(tempDir, 'fake-codex.js')
  const cmdPath = path.join(tempDir, 'codex.cmd')
  const script = `const fs = require('node:fs')
const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output-last-message')
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''
let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  prompt += chunk
})
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-win' }) + '\\n')
  if (outputFile) {
    fs.writeFileSync(outputFile, \`prompt:\${prompt.trim()}\\n\`)
  }
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }) + '\\n')
})
`

  fs.writeFileSync(scriptPath, script)
  fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0fake-codex.js" %*\r\n')
  return cmdPath
}

function writeThreadsDb(tempHome, rows = []) {
  const dbPath = path.join(tempHome, 'state_5.sqlite')
  const db = new SQL.Database()

  try {
    db.run(`
      CREATE TABLE threads (
        id TEXT NOT NULL,
        cwd TEXT,
        title TEXT,
        updated_at INTEGER
      );
    `)

    const statement = db.prepare('INSERT INTO threads (id, cwd, title, updated_at) VALUES (?, ?, ?, ?)')

    try {
      for (const row of rows) {
        statement.run([
          row.id,
          row.cwd || '',
          row.title || '',
          Number(row.updated_at || 0),
        ])
      }
    } finally {
      statement.free()
    }

    fs.writeFileSync(dbPath, Buffer.from(db.export()))
  } finally {
    db.close()
  }
}

test('listKnownCodexWorkspaces dedupes cwd values', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-home-'))
  writeThreadsDb(tempHome, [
    { id: 'thread-1', cwd: 'D:\\code\\yuyang-web', title: 'A', updated_at: 10 },
    { id: 'thread-2', cwd: 'D:\\code\\promptx', title: 'B', updated_at: 9 },
    { id: 'thread-3', cwd: 'D:\\code\\yuyang-web', title: 'C', updated_at: 8 },
  ])

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: undefined,
    },
    async () => {
      const { listKnownCodexWorkspaces } = await importFreshCodexModule()
      assert.deepEqual(listKnownCodexWorkspaces(), ['D:\\code\\yuyang-web', 'D:\\code\\promptx'])
    }
  )
})

test('sendPromptToCodexSession creates a new thread on first send', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-send-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { sendPromptToCodexSession } = await importFreshCodexModule()
      const result = await sendPromptToCodexSession(
        { id: 'session-xyz', cwd: 'D:\\code\\promptx', codexThreadId: '' },
        'hello from promptx'
      )

      assert.equal(result.sessionId, 'session-xyz')
      assert.equal(result.threadId, 'thread-new-123')
      assert.match(result.message, /thread:thread-new-123/)
      assert.match(result.message, /cwd:D:\\code\\promptx/)
    }
  )
})

test('sendPromptToCodexSession resumes an existing thread when provided', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-resume-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { sendPromptToCodexSession } = await importFreshCodexModule()
      const result = await sendPromptToCodexSession(
        { id: 'session-xyz', cwd: 'D:\\code\\yuyang-web', codexThreadId: 'thread-old-456' },
        'hello again'
      )

      assert.equal(result.threadId, 'thread-old-456')
      assert.match(result.message, /thread:thread-old-456/)
      assert.match(result.message, /cwd:D:\\code\\yuyang-web/)
    }
  )
})

test('sendPromptToCodexSession surfaces stderr failures', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-fail-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { sendPromptToCodexSession } = await importFreshCodexModule()

      await assert.rejects(
        () => sendPromptToCodexSession({ id: 'session-xyz', cwd: 'D:\\code\\promptx' }, 'fail-case'),
        /mocked codex failure/
      )
    }
  )
})

test('streamPromptToCodexSession handles a tail event without newline', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-stream-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { streamPromptToCodexSession } = await importFreshCodexModule()
      const events = []
      const seenThreadIds = []
      const stream = streamPromptToCodexSession(
        { id: 'session-xyz', cwd: 'D:\\code\\promptx' },
        'stream-tail-case',
        {
          onEvent(event) {
            events.push(event)
          },
          onThreadStarted(threadId) {
            seenThreadIds.push(threadId)
          },
        }
      )

      const result = await stream.result

      assert.equal(result.sessionId, 'session-xyz')
      assert.equal(result.message, '')
      assert.equal(result.threadId, 'thread-new-123')
      assert.deepEqual(seenThreadIds, ['thread-new-123'])
      assert.deepEqual(
        events.filter((event) => event.type === 'codex').map((event) => event.event.type),
        ['thread.started', 'item.completed']
      )
      assert.equal(
        events.find((event) => event.type === 'codex' && event.event.type === 'item.completed')?.event?.item?.text,
        'stream tail message'
      )
      assert.equal(events.at(-1)?.type, 'completed')
    }
  )
})

test('Windows resolves codex.cmd when CODEX_BIN is omitted', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only validation')
    return
  }

  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-win-'))
  createWindowsCodexCommand(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: undefined,
      PATH: `${tempHome};${process.env.PATH || ''}`,
    },
    async () => {
      const { sendPromptToCodexSession } = await importFreshCodexModule()
      const result = await sendPromptToCodexSession(
        { id: 'session-win', cwd: 'D:\\code\\promptx' },
        'hello from windows'
      )

      assert.equal(result.sessionId, 'session-win')
      assert.equal(result.threadId, 'thread-win')
      assert.match(result.message, /prompt:hello from windows/)
    }
  )
})
