import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'

const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const SESSION_INDEX_PATH = path.join(CODEX_HOME, 'session_index.jsonl')
const STATE_DB_PATH = path.join(CODEX_HOME, 'state_5.sqlite')
const TMP_DIR = path.join(CODEX_HOME, 'tmp')
const MAX_SESSION_COUNT = 30
const THREAD_MATCH_WINDOW_SECONDS = 5 * 60

function ensureCodexHome() {
  fs.mkdirSync(TMP_DIR, { recursive: true })
}

function trimOutput(value = '', maxLength = 12000) {
  const text = String(value || '').trim()
  if (text.length <= maxLength) {
    return text
  }
  return text.slice(text.length - maxLength)
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
  const lines = parts.map((line) => line.trim()).filter(Boolean)
  return { lines, rest }
}

function flushBufferedText(buffer = '') {
  const { lines, rest } = splitBufferedLines(buffer)
  const tail = String(rest || '').trim()
  return tail ? [...lines, tail] : lines
}

function getSessionDisplayName(session) {
  if (session.threadName) {
    return session.threadName
  }
  return `Session ${session.shortId}`
}

function toUnixTimestamp(value = '') {
  const timestamp = Date.parse(String(value || ''))
  if (Number.isNaN(timestamp)) {
    return 0
  }
  return Math.floor(timestamp / 1000)
}

function loadCodexThreads(limit = MAX_SESSION_COUNT * 8) {
  if (!fs.existsSync(STATE_DB_PATH)) {
    return []
  }

  try {
    const sql = `select id, cwd, title, updated_at from threads order by updated_at desc limit ${Math.max(1, Number(limit) || MAX_SESSION_COUNT * 8)};`
    const output = execFileSync('sqlite3', ['-json', STATE_DB_PATH, sql], {
      encoding: 'utf8',
    }).trim()

    if (!output) {
      return []
    }

    const rows = JSON.parse(output)
    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

function resolveThreadMetadata(session, threads = []) {
  if (!session) {
    return null
  }

  const exactMatch = threads.find((thread) => thread.id === session.id)
  if (exactMatch) {
    return exactMatch
  }

  const sessionUpdatedAt = toUnixTimestamp(session.updatedAt)
  if (!sessionUpdatedAt) {
    return null
  }

  let bestMatch = null
  let bestDiff = Number.POSITIVE_INFINITY

  for (const thread of threads) {
    const threadUpdatedAt = Number(thread.updated_at || 0)
    if (!threadUpdatedAt) {
      continue
    }

    const diff = Math.abs(threadUpdatedAt - sessionUpdatedAt)
    if (diff > THREAD_MATCH_WINDOW_SECONDS || diff >= bestDiff) {
      continue
    }

    bestMatch = thread
    bestDiff = diff
  }

  return bestMatch
}

function normalizeSession(record = {}) {
  if (!record || typeof record !== 'object') {
    return null
  }

  const id = String(record.id || '').trim()
  if (!id) {
    return null
  }

  const updatedAt = String(record.updated_at || '')
  const threadName = String(record.thread_name || '').trim()

  return {
    id,
    shortId: id.slice(0, 8),
    threadName,
    updatedAt,
    displayName: getSessionDisplayName({
      threadName,
      shortId: id.slice(0, 8),
    }),
  }
}

export function listCodexSessions(limit = MAX_SESSION_COUNT) {
  if (!fs.existsSync(SESSION_INDEX_PATH)) {
    return []
  }

  const content = fs.readFileSync(SESSION_INDEX_PATH, 'utf8')
  const sessionsById = new Map()

  for (const line of content.split('\n')) {
    const record = normalizeSession(parseJsonLine(line))
    if (!record) {
      continue
    }

    const previous = sessionsById.get(record.id)
    if (!previous || String(record.updatedAt).localeCompare(String(previous.updatedAt)) > 0) {
      sessionsById.set(record.id, record)
    }
  }

  const threads = loadCodexThreads()

  return Array.from(sessionsById.values())
    .map((session) => {
      const thread = resolveThreadMetadata(session, threads)
      return {
        ...session,
        cwd: thread?.cwd || '',
        sourceThreadId: thread?.id || session.id,
        resumeTarget: session.threadName || thread?.id || session.id,
      }
    })
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, Math.max(1, Number(limit) || MAX_SESSION_COUNT))
}

export function getCodexSessionById(sessionId) {
  const targetId = String(sessionId || '').trim()
  if (!targetId) {
    return null
  }

  return listCodexSessions(MAX_SESSION_COUNT * 4).find((session) => session.id === targetId) || null
}

function extractCodexError(stderr = '', stdout = '') {
  const stderrText = trimOutput(stderr)
  if (stderrText) {
    const lines = stderrText.split('\n').map((line) => line.trim()).filter(Boolean)
    return lines[lines.length - 1] || stderrText
  }

  const stdoutText = trimOutput(stdout)
  if (!stdoutText) {
    return 'Codex 执行失败。'
  }

  const lines = stdoutText.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines[lines.length - 1] || stdoutText
}

function normalizeSessionInput(sessionInput) {
  if (!sessionInput) {
    return null
  }

  if (typeof sessionInput === 'string') {
    const session = getCodexSessionById(sessionInput)
    return session
      ? session
      : {
          id: sessionInput,
          resumeTarget: sessionInput,
          cwd: process.cwd(),
        }
  }

  const id = String(sessionInput.id || '').trim()
  if (!id) {
    return null
  }

  return {
    ...sessionInput,
    id,
    resumeTarget: String(sessionInput.resumeTarget || sessionInput.threadName || id).trim(),
    cwd: String(sessionInput.cwd || process.cwd()).trim() || process.cwd(),
  }
}

function createResumeArgs(session) {
  return [
    ...(session.cwd ? ['-C', session.cwd] : []),
    'exec',
    'resume',
    session.resumeTarget || session.id,
    '-',
    '--json',
  ]
}

export async function sendPromptToCodexSession(sessionInput, prompt) {
  const session = normalizeSessionInput(sessionInput)
  const normalizedPrompt = String(prompt || '').trim()

  if (!session) {
    throw new Error('缺少 Codex session。')
  }
  if (!normalizedPrompt) {
    throw new Error('没有可发送的提示词。')
  }

  ensureCodexHome()

  const outputFile = path.join(TMP_DIR, `promptx-codex-${Date.now()}-${process.pid}.txt`)

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        CODEX_BIN,
        [
          ...createResumeArgs(session),
          '--output-last-message',
          outputFile,
        ],
        {
          env: process.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          cwd: session.cwd || process.cwd(),
        }
      )

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('error', (error) => {
        reject(error)
      })

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(extractCodexError(stderr, stdout)))
          return
        }

        const message = fs.existsSync(outputFile)
          ? fs.readFileSync(outputFile, 'utf8').trim()
          : ''

        resolve({
          message,
          stdout: trimOutput(stdout),
          stderr: trimOutput(stderr),
        })
      })

      child.stdin.write(normalizedPrompt)
      child.stdin.end()
    })

    return {
      sessionId: session.id,
      message: result.message,
      rawStdout: result.stdout,
    }
  } finally {
    fs.rmSync(outputFile, { force: true })
  }
}

export function streamPromptToCodexSession(sessionInput, prompt, callbacks = {}) {
  const session = normalizeSessionInput(sessionInput)
  const normalizedPrompt = String(prompt || '').trim()

  if (!session) {
    throw new Error('缺少 Codex session。')
  }
  if (!normalizedPrompt) {
    throw new Error('没有可发送的提示词。')
  }

  ensureCodexHome()

  const outputFile = path.join(TMP_DIR, `promptx-codex-${Date.now()}-${process.pid}.txt`)
  const onEvent = typeof callbacks.onEvent === 'function' ? callbacks.onEvent : () => {}

  const child = spawn(
    CODEX_BIN,
    [
      ...createResumeArgs(session),
      '--output-last-message',
      outputFile,
    ],
    {
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: session.cwd || process.cwd(),
    }
  )

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let stdoutRaw = ''
  let stderrRaw = ''
  let finalMessage = ''

  const emit = (event) => {
    try {
      onEvent(event)
    } catch {
      // Ignore observer failures to avoid breaking the process lifecycle.
    }
  }

  emit({
    type: 'status',
    stage: 'starting',
    message: '已连接 Codex，正在启动本轮执行。',
  })

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdoutRaw += text
    stdoutBuffer += text
    const { lines, rest } = splitBufferedLines(stdoutBuffer)
    stdoutBuffer = rest

    for (const line of lines) {
      const event = parseJsonLine(line)
      if (event) {
        emit({
          type: 'codex',
          event,
        })
        continue
      }

      emit({
        type: 'stdout',
        text: line,
      })
    }
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderrRaw += text
    stderrBuffer += text
    const { lines, rest } = splitBufferedLines(stderrBuffer)
    stderrBuffer = rest

    for (const line of lines) {
      emit({
        type: 'stderr',
        text: line,
      })
    }
  })

  child.stdin.write(normalizedPrompt)
  child.stdin.end()

  const result = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      reject(error)
    })

    child.on('close', (code) => {
      const stdoutTail = flushBufferedText(stdoutBuffer)
      const stderrTail = flushBufferedText(stderrBuffer)

      stdoutTail.forEach((line) => {
        const event = parseJsonLine(line)
        if (event) {
          emit({
            type: 'codex',
            event,
          })
        } else {
          emit({
            type: 'stdout',
            text: line,
          })
        }
      })

      stderrTail.forEach((line) => {
        emit({
          type: 'stderr',
          text: line,
        })
      })

      if (fs.existsSync(outputFile)) {
        finalMessage = fs.readFileSync(outputFile, 'utf8').trim()
      }

      if (code !== 0) {
        reject(new Error(extractCodexError(stderrRaw, stdoutRaw)))
        return
      }

      emit({
        type: 'completed',
        message: finalMessage,
      })

      resolve({
        sessionId: session.id,
        message: finalMessage,
      })
    })
  }).finally(() => {
    fs.rmSync(outputFile, { force: true })
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
