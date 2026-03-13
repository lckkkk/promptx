import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

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
  const binPath = path.join(tempDir, 'fake-codex')
const script = `#!/usr/bin/env node
const fs = require('node:fs')

const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output-last-message')
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''
const resumeIndex = args.indexOf('resume')
const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] || '' : ''

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

  if (prompt.includes('stream-tail-case')) {
    process.stdout.write(JSON.stringify({ type: 'thread.started' }) + '\\n')
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
    fs.writeFileSync(outputFile, \`session:\${sessionId}\\nprompt:\${prompt.trim()}\\n\`)
  }

  process.stdout.write(JSON.stringify({ ok: true, sessionId }) + '\\n')
})
`

  fs.writeFileSync(binPath, script, { mode: 0o755 })
  return binPath
}

test('listCodexSessions 按更新时间倒序返回并去重', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-home-'))
  const sessionIndexPath = path.join(tempHome, 'session_index.jsonl')

  fs.writeFileSync(
    sessionIndexPath,
    [
      JSON.stringify({
        id: 'session-1',
        thread_name: 'Alpha',
        updated_at: '2026-03-13T01:00:00.000Z',
      }),
      JSON.stringify({
        id: 'session-2',
        thread_name: '',
        updated_at: '2026-03-13T02:00:00.000Z',
      }),
      JSON.stringify({
        id: 'session-1',
        thread_name: 'Alpha older duplicate',
        updated_at: '2026-03-13T00:00:00.000Z',
      }),
      'not-json',
      '',
    ].join('\n')
  )

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: undefined,
    },
    async () => {
      const { getCodexSessionById, listCodexSessions } = await importFreshCodexModule()
      const sessions = listCodexSessions()

      assert.equal(sessions.length, 2)
      assert.equal(sessions[0].id, 'session-2')
      assert.equal(sessions[0].displayName, 'Session session-')
      assert.equal(sessions[1].id, 'session-1')
      assert.equal(sessions[1].displayName, 'Alpha')
      assert.deepEqual(getCodexSessionById('session-1'), sessions[1])
      assert.equal(getCodexSessionById('missing'), null)
    }
  )
})

test('sendPromptToCodexSession 调用 codex CLI 并返回最后一条消息', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-send-'))
  const fakeBin = createFakeCodexBinary(tempHome)

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: fakeBin,
    },
    async () => {
      const { sendPromptToCodexSession } = await importFreshCodexModule()
      const result = await sendPromptToCodexSession('session-xyz', 'hello from promptx')

      assert.equal(result.sessionId, 'session-xyz')
      assert.match(result.message, /session:session-xyz/)
      assert.match(result.message, /prompt:hello from promptx/)
      assert.match(result.rawStdout, /"ok":true/)
    }
  )
})

test('sendPromptToCodexSession 在 codex CLI 失败时抛出 stderr 最后一行', async () => {
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
        () => sendPromptToCodexSession('session-xyz', 'fail-case'),
        /mocked codex failure/
      )
    }
  )
})

test('listCodexSessions 对重复 session 保留较新的记录', async () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-home-latest-'))
  const sessionIndexPath = path.join(tempHome, 'session_index.jsonl')

  fs.writeFileSync(
    sessionIndexPath,
    [
      JSON.stringify({
        id: 'session-1',
        thread_name: 'Older',
        updated_at: '2026-03-13T01:00:00.000Z',
      }),
      JSON.stringify({
        id: 'session-1',
        thread_name: 'Newer',
        updated_at: '2026-03-13T02:00:00.000Z',
      }),
    ].join('\n')
  )

  await withEnv(
    {
      CODEX_HOME: tempHome,
      CODEX_BIN: undefined,
    },
    async () => {
      const { listCodexSessions } = await importFreshCodexModule()
      const sessions = listCodexSessions()

      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].threadName, 'Newer')
      assert.equal(sessions[0].updatedAt, '2026-03-13T02:00:00.000Z')
    }
  )
})

test('streamPromptToCodexSession 能处理没有换行结尾的最后事件', async () => {
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
      const stream = streamPromptToCodexSession('session-xyz', 'stream-tail-case', {
        onEvent(event) {
          events.push(event)
        },
      })

      const result = await stream.result

      assert.equal(result.sessionId, 'session-xyz')
      assert.equal(result.message, '')
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
