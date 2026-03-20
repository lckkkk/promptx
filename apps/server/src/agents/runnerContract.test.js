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

async function importFreshRunnerModules() {
  const suffix = `test=${Date.now()}-${Math.random().toString(16).slice(2)}`
  const [{ streamPromptToCodexSession }, { streamPromptToClaudeCodeSession }] = await Promise.all([
    import(`../codex.js?${suffix}`),
    import(`./claudeCodeRunner.js?${suffix}`),
  ])

  return { streamPromptToCodexSession, streamPromptToClaudeCodeSession }
}

function createFakeCodexBinary(tempDir) {
  const scriptPath = path.join(tempDir, process.platform === 'win32' ? 'fake-codex.js' : 'fake-codex')
  const script = `#!/usr/bin/env node
const fs = require('node:fs')

const args = process.argv.slice(2)
const outputIndex = args.indexOf('--output-last-message')
const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : ''
const threadId = 'thread-contract-1'

let prompt = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  prompt += chunk
})
process.stdin.on('end', () => {
  if (outputFile) {
    fs.writeFileSync(outputFile, '最终回复')
  }

  process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'reasoning', text: '先分析' } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'Bash: pwd', status: 'in_progress' } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'Bash: pwd', status: 'completed', exit_code: 0, aggregated_output: '/tmp/demo' } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已完成修改' } }) + '\\n')
  process.stdout.write(JSON.stringify({ type: 'turn.completed', result: '最终回复' }) + '\\n')
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

function createFakeClaudeBinary(tempDir) {
  const scriptPath = path.join(tempDir, process.platform === 'win32' ? 'fake-claude.js' : 'fake-claude')
  const script = `#!/usr/bin/env node
const args = process.argv.slice(2)
const promptIndex = args.indexOf('-p')
const prompt = promptIndex >= 0 ? args[promptIndex + 1] || '' : ''
const resumeIndex = args.indexOf('--resume')
const threadId = resumeIndex >= 0 ? args[resumeIndex + 1] || 'thread-contract-1' : 'thread-contract-1'

if (!prompt) {
  process.stderr.write('missing prompt\\n')
  process.exit(1)
  return
}

process.stdout.write(JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: threadId,
}) + '\\n')

process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'thinking', thinking: '先分析' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'pwd' } },
    ],
  },
}) + '\\n')

process.stdout.write(JSON.stringify({
  type: 'user',
  message: {
    content: [
      { type: 'tool_result', tool_use_id: 'tool-1', content: '/tmp/demo', is_error: false },
    ],
  },
}) + '\\n')

process.stdout.write(JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'text', text: '已完成修改' },
    ],
  },
}) + '\\n')

process.stdout.write(JSON.stringify({
  type: 'result',
  result: '最终回复',
}) + '\\n')
`

  fs.writeFileSync(scriptPath, script, { mode: 0o755 })

  if (process.platform !== 'win32') {
    return scriptPath
  }

  const cmdPath = path.join(tempDir, 'fake-claude.cmd')
  fs.writeFileSync(cmdPath, '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n')
  return cmdPath
}

function simplifyEvent(event = {}) {
  if (event.type === 'status') {
    return {
      type: 'status',
      stage: event.stage,
      message: event.message,
    }
  }

  if (event.type === 'completed') {
    return {
      type: 'completed',
      message: event.message,
    }
  }

  if (event.type !== 'agent_event') {
    return { type: event.type }
  }

  return {
    type: 'agent_event',
    event: event.event,
  }
}

async function collectRunnerContractEvents(streamSessionPrompt) {
  const events = []
  const stream = streamSessionPrompt(
    { id: 'session-1', cwd: process.cwd() },
    'runner-contract-case',
    {
      onEvent(event) {
        events.push(simplifyEvent(event))
      },
    }
  )

  const result = await stream.result
  return {
    events,
    result,
  }
}

test('Codex 与 Claude runner 会产出同结构事件', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-runner-contract-'))
  const fakeCodexBin = createFakeCodexBinary(tempDir)
  const fakeClaudeBin = createFakeClaudeBinary(tempDir)

  await withEnv(
    {
      CODEX_BIN: fakeCodexBin,
      CLAUDE_CODE_BIN: fakeClaudeBin,
    },
    async () => {
      const {
        streamPromptToCodexSession,
        streamPromptToClaudeCodeSession,
      } = await importFreshRunnerModules()

      const [codexResult, claudeResult] = await Promise.all([
        collectRunnerContractEvents(streamPromptToCodexSession),
        collectRunnerContractEvents(streamPromptToClaudeCodeSession),
      ])

      assert.deepEqual(codexResult.events, claudeResult.events)
      assert.deepEqual(codexResult.result, {
        sessionId: 'session-1',
        threadId: 'thread-contract-1',
        message: '最终回复',
      })
      assert.deepEqual(claudeResult.result, {
        sessionId: 'session-1',
        threadId: 'thread-contract-1',
        message: '最终回复',
      })
    }
  )
})
