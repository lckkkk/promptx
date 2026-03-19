import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { AGENT_ENGINES, getAgentEngineLabel } from '../../../../packages/shared/src/index.js'

const CLAUDE_CODE_BIN = process.env.CLAUDE_CODE_BIN || 'claude'
const CLAUDE_DEFAULT_ARGS = ['--dangerously-skip-permissions']
const RESOLVED_CLAUDE_CODE_BIN = resolveClaudeCodeBinary()

function resolveClaudeCodeBinary() {
  if (process.platform !== 'win32') {
    return CLAUDE_CODE_BIN
  }

  if (path.extname(CLAUDE_CODE_BIN)) {
    return CLAUDE_CODE_BIN
  }

  if (fs.existsSync(`${CLAUDE_CODE_BIN}.cmd`)) {
    return `${CLAUDE_CODE_BIN}.cmd`
  }

  if (fs.existsSync(`${CLAUDE_CODE_BIN}.bat`)) {
    return `${CLAUDE_CODE_BIN}.bat`
  }

  if (fs.existsSync(CLAUDE_CODE_BIN)) {
    return CLAUDE_CODE_BIN
  }

  try {
    const output = execFileSync('where.exe', [CLAUDE_CODE_BIN], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return CLAUDE_CODE_BIN
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || CLAUDE_CODE_BIN
  } catch {
    return CLAUDE_CODE_BIN
  }
}

function createClaudeSpawn(commandArgs = [], cwd = '') {
  const options = {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }

  const normalizedCwd = String(cwd || '').trim()
  if (normalizedCwd) {
    options.cwd = normalizedCwd
  }

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(RESOLVED_CLAUDE_CODE_BIN)) {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', RESOLVED_CLAUDE_CODE_BIN, ...commandArgs],
      options
    )
  }

  return spawn(RESOLVED_CLAUDE_CODE_BIN, commandArgs, options)
}

function normalizeSpawnError(error) {
  if (error?.code === 'ENOENT') {
    const attempted = RESOLVED_CLAUDE_CODE_BIN === CLAUDE_CODE_BIN
      ? CLAUDE_CODE_BIN
      : `${CLAUDE_CODE_BIN} -> ${RESOLVED_CLAUDE_CODE_BIN}`
    return new Error(
      `找不到 Claude Code CLI（尝试执行：${attempted}）。请先确认终端里可以运行 \`claude --version\`，或设置环境变量 \`CLAUDE_CODE_BIN\`。`
    )
  }

  return error
}

function parseJsonLine(line = '') {
  const text = String(line || '').trim()
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function splitBufferedLines(buffer = '') {
  const text = String(buffer || '')
  if (!text) {
    return { lines: [], rest: '' }
  }

  const normalized = text.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n')
  const rest = parts.pop() || ''
  return {
    lines: parts.map((line) => line.trim()).filter(Boolean),
    rest,
  }
}

function flushBufferedText(buffer = '') {
  const { lines, rest } = splitBufferedLines(buffer)
  const tail = String(rest || '').trim()
  return tail ? [...lines, tail] : lines
}

function collectTextParts(value, parts = []) {
  if (!value) {
    return parts
  }

  if (typeof value === 'string') {
    const text = value.trim()
    if (text) {
      parts.push(text)
    }
    return parts
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectTextParts(item, parts))
    return parts
  }

  if (typeof value !== 'object') {
    return parts
  }

  if (value.type === 'text' && typeof value.text === 'string') {
    return collectTextParts(value.text, parts)
  }

  const candidateKeys = ['text', 'message', 'content', 'result']
  candidateKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectTextParts(value[key], parts)
    }
  })

  return parts
}

export function extractClaudeAssistantText(event = {}) {
  const parts = []
  if (event?.message?.content) {
    collectTextParts(event.message.content, parts)
  } else if (event?.content) {
    collectTextParts(event.content, parts)
  } else if (event?.message) {
    collectTextParts(event.message, parts)
  }
  return parts.join('\n').trim()
}

export function extractClaudeResultText(event = {}) {
  const parts = []
  if (event?.result) {
    collectTextParts(event.result, parts)
  } else if (event?.message?.content) {
    collectTextParts(event.message.content, parts)
  }
  return parts.join('\n').trim()
}

export function extractClaudeSessionId(event = {}) {
  const candidates = [
    event?.session_id,
    event?.sessionId,
    event?.message?.session_id,
    event?.message?.sessionId,
    event?.result?.session_id,
    event?.result?.sessionId,
  ]

  return candidates.map((value) => String(value || '').trim()).find(Boolean) || ''
}

export function normalizeClaudeEvent(event = {}) {
  const eventType = String(event?.type || '').trim().toLowerCase()

  if (eventType === 'assistant') {
    const text = extractClaudeAssistantText(event)
    return text
      ? {
          type: 'item.completed',
          item: {
            type: 'agent_message',
            text,
          },
        }
      : null
  }

  if (eventType === 'tool_use' || eventType === 'tool_use.delta') {
    return {
      type: 'item.started',
      item: {
        type: 'command_execution',
        command: String(event?.name || event?.tool_name || eventType).trim() || 'Claude Code tool',
      },
    }
  }

  if (eventType === 'result') {
    const text = extractClaudeResultText(event)
    return {
      type: 'turn.completed',
      result: text,
    }
  }

  if (eventType === 'error') {
    const message = extractClaudeResultText(event) || extractClaudeAssistantText(event) || String(event?.error || event?.message || '').trim()
    return {
      type: 'error',
      message,
    }
  }

  return {
    type: `claude.${eventType || 'event'}`,
    detail: extractClaudeAssistantText(event) || extractClaudeResultText(event) || '',
  }
}

function createExecArgs(session, prompt) {
  const args = [
    ...CLAUDE_DEFAULT_ARGS,
    '--output-format',
    'stream-json',
    '--verbose',
  ]

  const sessionId = String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  if (sessionId) {
    args.push('--resume', sessionId)
  }

  args.push('-p', String(prompt || ''))
  return args
}

export function streamPromptToClaudeCodeSession(sessionInput, prompt, callbacks = {}) {
  const session = sessionInput && typeof sessionInput === 'object' ? sessionInput : null
  const normalizedPrompt = String(prompt || '').trim()

  if (!session?.id || !session?.cwd) {
    throw new Error('缺少 PromptX 项目。')
  }
  if (!normalizedPrompt) {
    throw new Error('没有可发送的提示词。')
  }

  const onEvent = typeof callbacks.onEvent === 'function' ? callbacks.onEvent : () => {}
  const onThreadStarted = typeof callbacks.onThreadStarted === 'function' ? callbacks.onThreadStarted : () => {}

  const child = createClaudeSpawn(createExecArgs(session, normalizedPrompt), session.cwd)

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let lastStderrLine = ''
  let finalMessage = ''
  let finalSessionId = String(session.engineSessionId || session.engineThreadId || session.codexThreadId || '').trim()

  const rememberSessionId = (sessionId) => {
    const value = String(sessionId || '').trim()
    if (!value || value === finalSessionId) {
      return
    }
    finalSessionId = value
    onThreadStarted(value)
  }

  const emitClaudeJsonLine = (line) => {
    const event = parseJsonLine(line)
    if (!event) {
      onEvent({
        type: 'stdout',
        text: line,
      })
      return
    }

    const sessionId = extractClaudeSessionId(event)
    if (sessionId) {
      rememberSessionId(sessionId)
    }

    const normalizedEvent = normalizeClaudeEvent(event)
    if (normalizedEvent) {
      onEvent({
        type: 'codex',
        event: normalizedEvent,
      })
    }

    if (String(event?.type || '').trim().toLowerCase() === 'result') {
      finalMessage = extractClaudeResultText(event) || finalMessage
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    const { lines, rest } = splitBufferedLines(stdoutBuffer)
    stdoutBuffer = rest
    lines.forEach(emitClaudeJsonLine)
  })

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString()
    const { lines, rest } = splitBufferedLines(stderrBuffer)
    stderrBuffer = rest
    lines.forEach((line) => {
      lastStderrLine = line
      onEvent({
        type: 'stderr',
        text: line,
      })
    })
  })

  const result = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      reject(normalizeSpawnError(error))
    })

    child.on('close', (code) => {
      flushBufferedText(stdoutBuffer).forEach(emitClaudeJsonLine)
      flushBufferedText(stderrBuffer).forEach((line) => {
        lastStderrLine = line
        onEvent({
          type: 'stderr',
          text: line,
        })
      })

      if (code !== 0) {
        const detail = lastStderrLine || 'Claude Code 执行失败。'
        reject(new Error(detail))
        return
      }

      onEvent({
        type: 'completed',
        message: finalMessage,
      })

      resolve({
        sessionId: session.id,
        threadId: finalSessionId,
        message: finalMessage,
      })
    })
  })

  return {
    child,
    result,
    cancel() {
      if (!child.killed) {
        child.kill('SIGTERM')
      }
    },
  }
}

export const claudeCodeRunner = {
  engine: AGENT_ENGINES.CLAUDE_CODE,
  label: getAgentEngineLabel(AGENT_ENGINES.CLAUDE_CODE),
  supportsWorkspaceHistory: false,
  listKnownWorkspaces() {
    return []
  },
  streamSessionPrompt(session, prompt, callbacks = {}) {
    return streamPromptToClaudeCodeSession(session, prompt, callbacks)
  },
}
