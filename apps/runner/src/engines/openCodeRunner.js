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

const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode'
const RESOLVED_OPENCODE_BIN = resolveOpenCodeBinary()

function resolveOpenCodeBinary() {
  if (process.platform !== 'win32') {
    return OPENCODE_BIN
  }

  if (path.extname(OPENCODE_BIN)) {
    return OPENCODE_BIN
  }

  if (fs.existsSync(`${OPENCODE_BIN}.cmd`)) {
    return `${OPENCODE_BIN}.cmd`
  }

  if (fs.existsSync(`${OPENCODE_BIN}.bat`)) {
    return `${OPENCODE_BIN}.bat`
  }

  if (fs.existsSync(OPENCODE_BIN)) {
    return OPENCODE_BIN
  }

  try {
    const output = execFileSync('where.exe', [OPENCODE_BIN], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return OPENCODE_BIN
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || OPENCODE_BIN
  } catch {
    return OPENCODE_BIN
  }
}

function createOpenCodeSpawn(commandArgs = [], cwd = '') {
  const options = createManagedSpawnOptions({
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(RESOLVED_OPENCODE_BIN)) {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', RESOLVED_OPENCODE_BIN, ...commandArgs],
      options
    )
  }

  return spawn(RESOLVED_OPENCODE_BIN, commandArgs, options)
}

function normalizeSpawnError(error) {
  if (error?.code === 'ENOENT') {
    const attempted = RESOLVED_OPENCODE_BIN === OPENCODE_BIN
      ? OPENCODE_BIN
      : `${OPENCODE_BIN} -> ${RESOLVED_OPENCODE_BIN}`

    return new Error(
      `找不到 OpenCode CLI（尝试执行：${attempted}）。请先确认终端里可以运行 \`opencode --version\`，或设置环境变量 \`OPENCODE_BIN\`。`
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

function summarizeOpenCodeInput(input = {}) {
  if (!input || typeof input !== 'object') {
    return ''
  }

  const command = String(input.command || '').trim()
  if (command) {
    return command
  }

  const singleValueKeys = ['filePath', 'path', 'pattern', 'query', 'url', 'description']
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

function stringifyOpenCodeOutput(output) {
  if (typeof output === 'string') {
    return output.trim()
  }

  if (output == null) {
    return ''
  }

  try {
    const compact = JSON.stringify(output)
    return compact.length <= 12000 ? compact : `${compact.slice(0, 11997)}...`
  } catch {
    return String(output || '').trim()
  }
}

function extractOpenCodeErrorText(input, depth = 0) {
  if (!input || depth > 5) {
    return ''
  }

  if (typeof input === 'string') {
    return input.trim()
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      const text = extractOpenCodeErrorText(item, depth + 1)
      if (text) {
        return text
      }
    }
    return ''
  }

  if (typeof input !== 'object') {
    return ''
  }

  const priorityKeys = [
    'message',
    'error',
    'responseBody',
    'data',
    'detail',
    'reason',
    'stderr',
    'text',
    'name',
  ]

  for (const key of priorityKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue
    }

    const text = extractOpenCodeErrorText(input[key], depth + 1)
    if (text) {
      return text
    }
  }

  for (const value of Object.values(input)) {
    const text = extractOpenCodeErrorText(value, depth + 1)
    if (text) {
      return text
    }
  }

  return ''
}

function buildOpenCodeToolCommand(event = {}) {
  const part = event?.part && typeof event.part === 'object' ? event.part : event
  const toolName = String(part?.tool || 'OpenCode tool').trim() || 'OpenCode tool'
  const input = part?.state?.input && typeof part.state.input === 'object'
    ? part.state.input
    : {}
  const inputSummary = summarizeOpenCodeInput(input)
  return inputSummary ? `${toolName}: ${inputSummary}` : toolName
}

export function extractOpenCodeText(event = {}) {
  return String(event?.part?.text || event?.text || '').trim()
}

export function extractOpenCodeSessionId(event = {}) {
  const candidates = [
    event?.sessionID,
    event?.sessionId,
    event?.part?.sessionID,
    event?.part?.sessionId,
  ]

  return candidates.map((value) => String(value || '').trim()).find(Boolean) || ''
}

export function extractOpenCodeUsage(event = {}) {
  const tokens = event?.part?.tokens
  if (!tokens || typeof tokens !== 'object') {
    return null
  }

  return {
    input_tokens: Number(tokens.input) || 0,
    output_tokens: Number(tokens.output) || 0,
    cached_input_tokens: Number(tokens.cache?.read) || 0,
  }
}

export function extractOpenCodeErrorMessage(event = {}) {
  return extractOpenCodeText(event)
    || extractOpenCodeErrorText(event?.error)
    || extractOpenCodeErrorText(event)
}

function createOpenCodeRunStatusEvent(session = {}) {
  const hasExistingThread = Boolean(
    String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  )

  return createStatusEnvelopeEvent({
    stage: hasExistingThread ? 'resuming' : 'starting',
    message: hasExistingThread
      ? '已连接 PromptX 项目，正在继续这轮执行。'
      : '已创建 PromptX 项目，正在启动第一轮执行。',
  })
}

export function createOpenCodeNormalizationState() {
  return {
    turnStarted: false,
  }
}

export function normalizeOpenCodeEvents(event = {}, state = createOpenCodeNormalizationState()) {
  const eventType = String(event?.type || '').trim().toLowerCase()
  const normalizedEvents = []

  if (eventType === 'step_start') {
    if (!state.turnStarted) {
      state.turnStarted = true
      normalizedEvents.push({ type: 'turn.started' })
    }
    return normalizedEvents
  }

  if (eventType === 'tool_use') {
    const command = buildOpenCodeToolCommand(event)
    const status = String(event?.part?.state?.status || '').trim().toLowerCase()
    const output = stringifyOpenCodeOutput(event?.part?.state?.output)

    normalizedEvents.push(createItemStartedEvent({
      type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
      command,
      status: 'in_progress',
    }))

    if (status === 'completed' || status === 'failed' || status === 'error') {
      normalizedEvents.push(createItemCompletedEvent({
        type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
        command,
        status: status === 'completed' ? 'completed' : 'failed',
        exit_code: status === 'completed' ? 0 : 1,
        aggregated_output: output,
      }))
    }

    return normalizedEvents
  }

  if (eventType === 'text') {
    const text = extractOpenCodeText(event)
    if (!text) {
      return normalizedEvents
    }

    normalizedEvents.push(createItemCompletedEvent({
      type: AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE,
      text,
    }))
    return normalizedEvents
  }

  if (eventType === 'step_finish') {
    const reason = String(event?.part?.reason || '').trim().toLowerCase()
    if (reason === 'stop') {
      const usage = extractOpenCodeUsage(event)
      normalizedEvents.push(createTurnCompletedEvent(usage ? { usage } : {}))
      return normalizedEvents
    }

    return normalizedEvents
  }

  if (eventType === 'error') {
    const message = extractOpenCodeText(event) || String(event?.message || event?.error || '').trim()
    if (message) {
      normalizedEvents.push(createErrorEvent(message))
    }
    return normalizedEvents
  }

  return [{
    type: `opencode.${eventType || 'event'}`,
    detail: extractOpenCodeText(event),
  }]
}

export function normalizeOpenCodeEvent(event = {}, state = createOpenCodeNormalizationState()) {
  return normalizeOpenCodeEvents(event, state)[0] || null
}

function createExecArgs(session) {
  const args = [
    'run',
    '--format',
    'json',
  ]

  const sessionId = String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  if (sessionId) {
    args.push('--session', sessionId)
  }

  if (session?.cwd) {
    args.push('--dir', session.cwd)
  }

  return args
}

function writePromptToChildStdin(child, prompt) {
  if (!child?.stdin) {
    return
  }

  try {
    child.stdin.setDefaultEncoding?.('utf8')
    child.stdin.end(`${String(prompt || '')}\n`)
  } catch {
    try {
      child.stdin.end()
    } catch {
      // Ignore stdin close failures after spawn.
    }
  }
}

export function streamPromptToOpenCodeSession(sessionInput, prompt, callbacks = {}) {
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

  const child = createOpenCodeSpawn(createExecArgs(session), session.cwd)
  onEvent(createOpenCodeRunStatusEvent(session))
  writePromptToChildStdin(child, normalizedPrompt)

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let lastStderrLine = ''
  let finalMessage = ''
  let finalSessionId = String(session.engineSessionId || session.engineThreadId || session.codexThreadId || '').trim()
  let lastErrorMessage = ''
  const normalizationState = createOpenCodeNormalizationState()

  const rememberSessionId = (sessionId) => {
    const value = String(sessionId || '').trim()
    if (!value || value === finalSessionId) {
      return
    }

    finalSessionId = value
    onThreadStarted(value)
    onEvent(createAgentEventEnvelopeEvent(createThreadStartedEvent(value)))
  }

  const emitOpenCodeJsonLine = (line) => {
    const event = parseJsonLine(line)
    if (!event) {
      onEvent(createStdoutEnvelopeEvent(line))
      return
    }

    const sessionId = extractOpenCodeSessionId(event)
    if (sessionId) {
      rememberSessionId(sessionId)
    }

    const normalizedEvents = normalizeOpenCodeEvents(event, normalizationState)
    normalizedEvents.forEach((normalizedEvent) => {
      onEvent(createAgentEventEnvelopeEvent(normalizedEvent))
    })

    const eventType = String(event?.type || '').trim().toLowerCase()

    if (eventType === 'text') {
      const text = extractOpenCodeText(event)
      if (text) {
        finalMessage = `${finalMessage}${finalMessage ? '\n' : ''}${text}`
      }
    }

    if (eventType === 'error') {
      lastErrorMessage = extractOpenCodeErrorMessage(event) || lastErrorMessage
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    const { lines, rest } = splitBufferedLines(stdoutBuffer)
    stdoutBuffer = rest
    lines.forEach(emitOpenCodeJsonLine)
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
      flushBufferedText(stdoutBuffer).forEach(emitOpenCodeJsonLine)
      flushBufferedText(stderrBuffer).forEach((line) => {
        lastStderrLine = line
        onEvent(createStderrEnvelopeEvent(line))
      })

      if (code !== 0 || lastErrorMessage) {
        reject(new Error(lastErrorMessage || lastStderrLine || 'OpenCode 执行失败。'))
        return
      }

      const message = finalMessage.trim()
      onEvent(createCompletedEnvelopeEvent(message))

      resolve({
        sessionId: session.id,
        threadId: finalSessionId,
        message,
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

export const openCodeRunner = {
  engine: AGENT_ENGINES.OPENCODE,
  label: getAgentEngineLabel(AGENT_ENGINES.OPENCODE),
  supportsWorkspaceHistory: false,
  listKnownWorkspaces() {
    return []
  },
  streamSessionPrompt(session, prompt, callbacks = {}) {
    return streamPromptToOpenCodeSession(session, prompt, callbacks)
  },
}
