import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  AGENT_ENGINES,
  AGENT_RUN_EVENT_TYPES,
  AGENT_RUN_ITEM_TYPES,
  BLOCK_TYPES,
} from '@promptx/shared'
import { createTask, deleteTask } from '../../server/src/repository.js'
import { createPromptxCodexSession, deletePromptxCodexSession } from '../../server/src/codexSessions.js'
import {
  appendCodexRunEvent,
  createCodexRun,
  listCodexRunEvents,
  updateCodexRun,
} from '../../server/src/codexRuns.js'

const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const DEFAULT_BASE_URL = String(process.env.PROMPTX_E2E_BASE_URL || 'http://127.0.0.1:5174').replace(/\/$/, '')
const DEFAULT_API_URL = String(process.env.PROMPTX_E2E_API_URL || '').replace(/\/$/, '')
const DEFAULT_API_URL_CANDIDATES = Array.from(new Set([
  DEFAULT_API_URL,
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3000',
].filter(Boolean)))

let promptxStackPromise = null
let promptxStackChild = null
let promptxStackManaged = false
let promptxStackLogTail = ''
let promptxStackCleanupHandlers = null

function appendPromptxStackLog(chunk = '') {
  const next = `${promptxStackLogTail}${String(chunk || '')}`
  promptxStackLogTail = next.slice(-4000)
}

async function canReach(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
    })
    return response.ok
  } catch {
    return false
  }
}

async function waitForUrl(url, timeoutMs = 30000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await canReach(url)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  throw new Error(`等待服务启动超时：${url}\n${promptxStackLogTail.trim()}`)
}

async function resolveReachableApiUrl(candidates = DEFAULT_API_URL_CANDIDATES) {
  for (const candidate of candidates) {
    if (await canReach(`${candidate}/api/tasks`)) {
      return candidate
    }
  }

  return null
}

function resetPromptxE2EStackState() {
  if (promptxStackChild?.stdout) {
    promptxStackChild.stdout.removeAllListeners('data')
  }
  if (promptxStackChild?.stderr) {
    promptxStackChild.stderr.removeAllListeners('data')
  }

  if (promptxStackCleanupHandlers) {
    const { onExit, onSigint, onSigterm } = promptxStackCleanupHandlers
    process.off('exit', onExit)
    process.off('SIGINT', onSigint)
    process.off('SIGTERM', onSigterm)
    promptxStackCleanupHandlers = null
  }

  promptxStackPromise = null
  promptxStackChild = null
  promptxStackManaged = false
  promptxStackLogTail = ''
}

export async function shutdownPromptxE2EStack() {
  if (!promptxStackManaged || !promptxStackChild) {
    resetPromptxE2EStackState()
    return
  }

  const child = promptxStackChild

  if (child.exitCode !== null || child.signalCode !== null) {
    resetPromptxE2EStackState()
    return
  }

  await new Promise((resolve) => {
    let settled = false

    const finish = () => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(forceKillTimer)
      resolve()
    }

    const forceKillTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }, 5000)

    child.once('exit', finish)
    child.once('error', finish)
    child.kill('SIGTERM')
  })

  resetPromptxE2EStackState()
}

export async function ensurePromptxE2EStack() {
  if (promptxStackPromise) {
    return promptxStackPromise
  }

  promptxStackPromise = (async () => {
    promptxStackLogTail = ''
    const [webReady, apiUrl] = await Promise.all([
      canReach(DEFAULT_BASE_URL),
      resolveReachableApiUrl(),
    ])

    if (webReady && apiUrl) {
      promptxStackManaged = false
      return { managed: false, apiUrl }
    }

    promptxStackChild = spawn('pnpm', ['dev'], {
      cwd: WORKSPACE_ROOT,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    promptxStackChild.stdout.on('data', (chunk) => {
      appendPromptxStackLog(chunk)
    })
    promptxStackChild.stderr.on('data', (chunk) => {
      appendPromptxStackLog(chunk)
    })

    promptxStackManaged = true

    const cleanup = (signal = 'SIGTERM') => {
      if (!promptxStackChild || promptxStackChild.killed) {
        return
      }

      if (promptxStackChild.exitCode === null && promptxStackChild.signalCode === null) {
        promptxStackChild.kill(signal)
      }
    }

    const onExit = () => cleanup()
    const onSigint = () => cleanup('SIGINT')
    const onSigterm = () => cleanup('SIGTERM')

    process.once('exit', onExit)
    process.once('SIGINT', onSigint)
    process.once('SIGTERM', onSigterm)

    promptxStackCleanupHandlers = {
      onExit,
      onSigint,
      onSigterm,
    }

    await Promise.all([
      waitForUrl(DEFAULT_BASE_URL),
      DEFAULT_API_URL
        ? waitForUrl(`${DEFAULT_API_URL}/api/tasks`)
        : (async () => {
          const startedAt = Date.now()
          while (Date.now() - startedAt < 30000) {
            const reachableApiUrl = await resolveReachableApiUrl()
            if (reachableApiUrl) {
              return reachableApiUrl
            }
            await new Promise((resolve) => setTimeout(resolve, 300))
          }

          throw new Error(`等待服务启动超时：${DEFAULT_API_URL_CANDIDATES.join(', ')}\n${promptxStackLogTail.trim()}`)
        })(),
    ])

    return {
      managed: true,
      apiUrl: await resolveReachableApiUrl(),
    }
  })()

  return promptxStackPromise
}

function nowIso() {
  return new Date().toISOString()
}

export function buildSessionPayload(session, overrides = {}) {
  return {
    type: 'session',
    session: {
      id: session.id,
      title: session.title,
      engine: session.engine,
      cwd: session.cwd,
      codexThreadId: session.codexThreadId,
      engineThreadId: session.engineThreadId,
      engineSessionId: session.engineSessionId,
      started: session.started,
      ...overrides,
    },
  }
}

export function buildThreadStartedEvent(threadId) {
  return {
    type: 'codex',
    event: {
      type: AGENT_RUN_EVENT_TYPES.THREAD_STARTED,
      thread_id: threadId,
    },
  }
}

export function buildTurnStartedEvent() {
  return {
    type: 'codex',
    event: {
      type: AGENT_RUN_EVENT_TYPES.TURN_STARTED,
    },
  }
}

export function buildReasoningEvent(text) {
  return {
    type: 'codex',
    event: {
      type: AGENT_RUN_EVENT_TYPES.ITEM_STARTED,
      item: {
        type: AGENT_RUN_ITEM_TYPES.REASONING,
        text,
      },
    },
  }
}

export function buildCommandStartedEvent(command) {
  return {
    type: 'codex',
    event: {
      type: AGENT_RUN_EVENT_TYPES.ITEM_STARTED,
      item: {
        type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
        command,
        status: 'in_progress',
      },
    },
  }
}

export function buildCommandCompletedEvent(command, output = '') {
  return {
    type: 'codex',
    event: {
      type: AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED,
      item: {
        type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
        command,
        status: 'completed',
        exit_code: 0,
        aggregated_output: output,
      },
    },
  }
}

export function buildAgentMessageEvent(text) {
  return {
    type: 'codex',
    event: {
      type: AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED,
      item: {
        type: AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE,
        text,
      },
    },
  }
}

export function buildTurnCompletedEvent(usage = null) {
  return {
    type: 'codex',
    event: {
      type: AGENT_RUN_EVENT_TYPES.TURN_COMPLETED,
      ...(usage ? { usage } : {}),
    },
  }
}

export async function appendRunPayloads(runId, payloads = [], patch = {}) {
  const existing = listCodexRunEvents(runId) || []
  let seq = existing.length

  payloads.forEach((payload) => {
    seq += 1
    appendCodexRunEvent(runId, seq, payload)
  })

  listCodexRunEvents(runId)

  if (Object.keys(patch).length) {
    updateCodexRun(runId, patch)
  } else {
    updateCodexRun(runId, {
      updatedAt: nowIso(),
    })
  }
}

export async function createTranscriptFixture(options = {}) {
  const id = randomUUID().slice(0, 8)
  const cwd = String(options.cwd || process.cwd())
  const task = createTask({
    title: options.taskTitle || `E2E Transcript ${id}`,
    blocks: options.taskBlocks || [
      {
        type: BLOCK_TYPES.TEXT,
        content: options.taskText || `E2E task ${id}`,
      },
    ],
  })
  const session = createPromptxCodexSession({
    title: options.sessionTitle || `E2E Session ${id}`,
    engine: options.engine || AGENT_ENGINES.CODEX,
    cwd,
  })
  const run = createCodexRun({
    taskSlug: task.slug,
    sessionId: session.id,
    prompt: options.prompt || `请处理 E2E ${id}`,
    promptBlocks: options.promptBlocks || [
      {
        type: BLOCK_TYPES.TEXT,
        content: options.prompt || `请处理 E2E ${id}`,
      },
    ],
  })

  if (Array.isArray(options.eventPayloads) && options.eventPayloads.length) {
    await appendRunPayloads(run.id, options.eventPayloads)
  }

  if (options.status && options.status !== 'running') {
    updateCodexRun(run.id, {
      status: options.status,
      responseMessage: String(options.responseMessage || ''),
      errorMessage: String(options.errorMessage || ''),
      finishedAt: nowIso(),
      updatedAt: nowIso(),
    })
  }

  return {
    task,
    session,
    run,
    cleanup() {
      deleteTask(task.slug)
      deletePromptxCodexSession(session.id)
    },
  }
}

export async function openWorkbenchTask(page, slug, options = {}) {
  await ensurePromptxE2EStack()
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('promptx:locale', 'zh-CN')
    } catch {
    }
  })
  await page.goto(`${baseUrl}/?task=${encodeURIComponent(slug)}`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await page.waitForSelector('.transcript-card--prompt', { timeout: 30000 })
  await page.waitForTimeout(1200)
}

export async function readTranscriptState(page) {
  return page.evaluate(() => {
    const transcript = document.querySelector('.h-full.space-y-4.overflow-y-auto.px-4.py-4')
    const turns = transcript ? Array.from(transcript.children) : []
    const lastTurn = turns.at(-1) || null
    const processCard = lastTurn?.children?.[1]?.querySelector('.theme-process-running, .theme-process-completed, .theme-process-stopped, .theme-process-error') || null
    const logsContainer = processCard?.querySelector('.mt-3.space-y-3') || null

    return {
      scrollTop: transcript ? Math.round(transcript.scrollTop) : -1,
      clientHeight: transcript ? Math.round(transcript.clientHeight) : -1,
      scrollHeight: transcript ? Math.round(transcript.scrollHeight) : -1,
      distanceToBottom: transcript ? Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight) : -1,
      logCount: logsContainer ? logsContainer.children.length : 0,
      hasNewerButton: Boolean(document.body.innerText.includes('有新消息，跳到底部')),
    }
  })
}
