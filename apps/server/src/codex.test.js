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

  if (prompt.includes('disconnect-case')) {
    process.stdout.write(JSON.stringify({
      type: 'error',
      message: 'Reconnecting... 1/5 (stream disconnected before completion: error sending request for url (https://api.codexzh.com/v1/responses))',
    }) + '\\n')
    process.stdout.write(JSON.stringify({
      type: 'turn.failed',
      error: {
        message: 'stream disconnected before completion: error sending request for url (https://api.codexzh.com/v1/responses)',
      },
    }) + '\\n')
    process.stderr.write('Warning: no last agent message; wrote empty content to tmp-file\\n')
    process.exit(1)
    return
  }

  if (prompt.includes('mojibake-case')) {
    const garbled = '鑾峰彇娴嬭瘯鏁版嵁'
    if (outputFile) {
      fs.writeFileSync(outputFile, garbled)
    }
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'Get-Content demo.txt',
        aggregated_output: garbled,
        exit_code: 0,
        status: 'completed',
      },
    }) + '\\n')
    return
  }

  if (prompt.includes('args-case')) {
    if (outputFile) {
      fs.writeFileSync(outputFile, JSON.stringify(args))
    }
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')
    process.stdout.write(JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'args-ok',
      },
    }) + '\\n')
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

function getSessionCwd() {
  return process.cwd()
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
        { id: 'session-xyz', cwd: getSessionCwd() },
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
        events.filter((event) => event.type === 'agent_event').map((event) => event.event.type),
        ['thread.started', 'item.completed']
      )
      assert.equal(
        events.find((event) => event.type === 'agent_event' && event.event.type === 'item.completed')?.event?.item?.text,
        'stream tail message'
      )
      assert.equal(events.at(-1)?.type, 'completed')
    }
  )
})

test('streamPromptToCodexSession emits starting status for new sessions and resuming status for existing threads', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-status-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { streamPromptToCodexSession } = await importFreshCodexModule()

      const startingEvents = []
      const startingStream = streamPromptToCodexSession(
        { id: 'session-new', cwd: getSessionCwd(), codexThreadId: '' },
        'hello start',
        {
          onEvent(event) {
            startingEvents.push(event)
          },
        }
      )
      await startingStream.result

      const resumingEvents = []
      const resumingStream = streamPromptToCodexSession(
        { id: 'session-old', cwd: getSessionCwd(), codexThreadId: 'thread-existing-1' },
        'hello resume',
        {
          onEvent(event) {
            resumingEvents.push(event)
          },
        }
      )
      await resumingStream.result

      assert.deepEqual(
        startingEvents.find((event) => event.type === 'status'),
        {
          type: 'status',
          stage: 'starting',
          message: '已创建 PromptX 项目，正在启动第一轮执行。',
        }
      )

      assert.deepEqual(
        resumingEvents.find((event) => event.type === 'status'),
        {
          type: 'status',
          stage: 'resuming',
          message: '已连接 PromptX 项目，正在继续这轮执行。',
        }
      )
    }
  )
})

test('streamPromptToCodexSession includes full-access and repo-check bypass args by default', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-args-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { streamPromptToCodexSession } = await importFreshCodexModule()
      const stream = streamPromptToCodexSession(
        { id: 'session-args', cwd: getSessionCwd(), codexThreadId: '' },
        'args-case'
      )

      const result = await stream.result
      const args = JSON.parse(result.message)

      assert.deepEqual(
        args.slice(0, 5),
        ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-C', getSessionCwd()]
      )
      assert.equal(args.at(-2), '--output-last-message')
    }
  )
})

test('streamPromptToCodexSession surfaces stderr failures', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-fail-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { streamPromptToCodexSession } = await importFreshCodexModule()
      const stream = streamPromptToCodexSession(
        { id: 'session-xyz', cwd: getSessionCwd() },
        'fail-case'
      )

      await assert.rejects(() => stream.result, /mocked codex failure/)
    }
  )
})

test('streamPromptToCodexSession prefers structured codex errors over trailing stderr warnings', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-disconnect-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { streamPromptToCodexSession } = await importFreshCodexModule()
      const stream = streamPromptToCodexSession(
        { id: 'session-xyz', cwd: getSessionCwd() },
        'disconnect-case'
      )

      await assert.rejects(
        () => stream.result,
        /stream disconnected before completion: error sending request/
      )
    }
  )
})

test('streamPromptToCodexSession repairs garbled command output', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-mojibake-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { streamPromptToCodexSession } = await importFreshCodexModule()
      const events = []
      const stream = streamPromptToCodexSession(
        { id: 'session-xyz', cwd: getSessionCwd() },
        'mojibake-case',
        {
          onEvent(event) {
            events.push(event)
          },
        }
      )

      const streamResult = await stream.result

      assert.equal(streamResult.message, '获取测试数据')
      assert.equal(
        events.find((event) => event.type === 'agent_event' && event.event.type === 'item.completed')?.event?.item?.aggregated_output,
        '获取测试数据'
      )
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
      const { streamPromptToCodexSession } = await importFreshCodexModule()
      const stream = streamPromptToCodexSession(
        { id: 'session-win', cwd: 'D:\\code\\promptx' },
        'hello from windows'
      )
      const result = await stream.result

      assert.equal(result.sessionId, 'session-win')
      assert.equal(result.threadId, 'thread-win')
      assert.match(result.message, /prompt:hello from windows/)
    }
  )
})
