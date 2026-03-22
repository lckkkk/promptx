import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  AGENT_ENGINES,
  AGENT_RUN_ITEM_TYPES,
  createAgentEventEnvelopeEvent,
  createCompletedEnvelopeEvent,
  createErrorEvent,
  createItemCompletedEvent,
  createItemStartedEvent,
  createStatusEnvelopeEvent,
  createStderrEnvelopeEvent,
  createStdoutEnvelopeEvent,
  createThreadStartedEvent,
  createTurnCompletedEvent,
  getAgentEngineLabel,
} from '../../../../packages/shared/src/index.js'
import { createManagedSpawnOptions, forceStopChildProcess } from '../processControl.js'

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
  const options = createManagedSpawnOptions({
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

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

export function createClaudeNormalizationState() {
  return {
    toolUses: new Map(),
  }
}

function getClaudeMessageContentBlocks(event = {}) {
  const content = event?.message?.content ?? event?.content
  return Array.isArray(content) ? content : []
}

function stringifyClaudeToolInput(input = {}) {
  if (!input || typeof input !== 'object') {
    return ''
  }

  const command = String(input.command || '').trim()
  if (command) {
    return command
  }

  const singleValueKeys = ['file_path', 'path', 'pattern', 'query', 'url', 'description']
  for (const key of singleValueKeys) {
    const value = String(input[key] || '').trim()
    if (value) {
      return value
    }
  }

  try {
    const compact = JSON.stringify(input)
    return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`
  } catch {
    return ''
  }
}

function buildClaudeToolCommand(name = '', input = {}) {
  const toolName = String(name || 'Claude Code tool').trim() || 'Claude Code tool'
  const inputSummary = stringifyClaudeToolInput(input)
  return inputSummary ? `${toolName}: ${inputSummary}` : toolName
}

function createClaudeToolUseEvent(block = {}, state = createClaudeNormalizationState()) {
  const toolUseId = String(block?.id || '').trim()
  const name = String(block?.name || block?.tool_name || 'Claude Code tool').trim() || 'Claude Code tool'
  const input = block?.input && typeof block.input === 'object' ? block.input : {}
  const command = buildClaudeToolCommand(name, input)

  if (toolUseId) {
    state.toolUses.set(toolUseId, {
      name,
      command,
    })
  }

  return {
    ...createItemStartedEvent({
      type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
      command,
      status: 'in_progress',
    }),
  }
}

function createClaudeToolResultEvent(block = {}, state = createClaudeNormalizationState()) {
  const toolUseId = String(block?.tool_use_id || block?.toolUseId || '').trim()
  const remembered = toolUseId ? state.toolUses.get(toolUseId) : null
  const output = String(block?.content || block?.result || '').trim()
  const isError = Boolean(block?.is_error)

  if (toolUseId) {
    state.toolUses.delete(toolUseId)
  }

  return {
    ...createItemCompletedEvent({
      type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
      command: remembered?.command || remembered?.name || 'Claude Code tool',
      status: isError ? 'failed' : 'completed',
      exit_code: isError ? 1 : 0,
      aggregated_output: output,
    }),
  }
}

export function normalizeClaudeEvents(event = {}, state = createClaudeNormalizationState()) {
  const eventType = String(event?.type || '').trim().toLowerCase()
  const normalizedEvents = []

  if (eventType === 'system' && String(event?.subtype || '').trim().toLowerCase() === 'init') {
    return [createThreadStartedEvent(extractClaudeSessionId(event))]
  }

  if (eventType === 'assistant') {
    const blocks = getClaudeMessageContentBlocks(event)

    blocks.forEach((block) => {
      const blockType = String(block?.type || '').trim().toLowerCase()
      if (blockType === 'thinking') {
        const text = String(block?.thinking || block?.text || '').trim()
        if (text) {
          normalizedEvents.push({
            ...createItemStartedEvent({
              type: AGENT_RUN_ITEM_TYPES.REASONING,
              text,
            }),
          })
        }
        return
      }

      if (blockType === 'tool_use') {
        normalizedEvents.push(createClaudeToolUseEvent(block, state))
        return
      }

      if (blockType === 'text') {
        const text = String(block?.text || '').trim()
        if (text) {
          normalizedEvents.push({
            ...createItemCompletedEvent({
              type: AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE,
              text,
            }),
          })
        }
      }
    })

    return normalizedEvents
  }

  if (eventType === 'user') {
    const blocks = getClaudeMessageContentBlocks(event)
    blocks.forEach((block) => {
      const blockType = String(block?.type || '').trim().toLowerCase()
      if (blockType === 'tool_result') {
        normalizedEvents.push(createClaudeToolResultEvent(block, state))
      }
    })
    return normalizedEvents
  }

  if (eventType === 'tool_use' || eventType === 'tool_use.delta') {
    return [createClaudeToolUseEvent(event, state)]
  }

  if (eventType === 'result') {
    const text = extractClaudeResultText(event)
    const usage = event?.usage && typeof event.usage === 'object'
      ? {
          input_tokens: Number(event.usage.input_tokens) || 0,
          output_tokens: Number(event.usage.output_tokens) || 0,
          cached_input_tokens: Number(event.usage.cached_input_tokens ?? event.usage.cache_read_input_tokens) || 0,
        }
      : null
    return [createTurnCompletedEvent({
      result: text,
      ...(usage ? { usage } : {}),
    })]
  }

  if (eventType === 'error') {
    const message = extractClaudeResultText(event) || extractClaudeAssistantText(event) || String(event?.error || event?.message || '').trim()
    return [createErrorEvent(message)]
  }

  return [{
    type: `claude.${eventType || 'event'}`,
    detail: extractClaudeAssistantText(event) || extractClaudeResultText(event) || '',
  }]
}

export function normalizeClaudeEvent(event = {}, state = createClaudeNormalizationState()) {
  return normalizeClaudeEvents(event, state)[0] || null
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

function createClaudeRunStatusEvent(session = {}) {
  const hasExistingThread = Boolean(
    String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  )

  return {
    ...createStatusEnvelopeEvent({
      stage: hasExistingThread ? 'resuming' : 'starting',
      message: hasExistingThread
        ? '已连接 PromptX 项目，正在继续这轮执行。'
        : '已创建 PromptX 项目，正在启动第一轮执行。',
    }),
  }
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
  onEvent(createClaudeRunStatusEvent(session))

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let lastStderrLine = ''
  let finalMessage = ''
  let finalSessionId = String(session.engineSessionId || session.engineThreadId || session.codexThreadId || '').trim()
  const normalizationState = createClaudeNormalizationState()

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
        ...createStdoutEnvelopeEvent(line),
      })
      return
    }

    const sessionId = extractClaudeSessionId(event)
    if (sessionId) {
      rememberSessionId(sessionId)
    }

    const normalizedEvents = normalizeClaudeEvents(event, normalizationState)
    normalizedEvents.forEach((normalizedEvent) => {
      onEvent(createAgentEventEnvelopeEvent(normalizedEvent))
    })

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
      onEvent(createStderrEnvelopeEvent(line))
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
        onEvent(createStderrEnvelopeEvent(line))
      })

      if (code !== 0) {
        const detail = lastStderrLine || 'Claude Code 执行失败。'
        reject(new Error(detail))
        return
      }

      onEvent(createCompletedEnvelopeEvent(finalMessage))

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
    cancel(options = {}) {
      forceStopChildProcess(child, options)
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
