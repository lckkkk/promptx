import { nanoid } from 'nanoid'
import {
  BLOCK_TYPES,
  CODEX_RUN_EVENTS_MODES,
  clampText,
  normalizeCodexRunEventsMode,
} from '../../../packages/shared/src/index.js'
import { all, get, run, transaction } from './db.js'
import { getPromptxCodexSessionById } from './codexSessions.js'
import { captureRunGitBaseline, captureRunGitFinalSnapshot, captureTaskGitBaseline } from './gitDiff.js'
import { getTaskBySlug, updateTaskCodexSession } from './repository.js'
import { assertAgentRunner } from './agents/index.js'

const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'stopped', 'interrupted'])
const EVENT_FLUSH_DELAY_MS = 180

const pendingRunEventsByRunId = new Map()
let pendingRunEventsFlushTimer = null

function parseEventPayload(rawValue = '{}') {
  try {
    return JSON.parse(rawValue || '{}')
  } catch {
    return {}
  }
}

function parsePromptBlocks(rawValue = '[]') {
  try {
    const parsed = JSON.parse(rawValue || '[]')
    return Array.isArray(parsed) ? parsed.filter(Boolean) : []
  } catch {
    return []
  }
}

function normalizePromptBlock(block = {}) {
  const type =
    block.type === BLOCK_TYPES.IMAGE
      ? BLOCK_TYPES.IMAGE
      : block.type === BLOCK_TYPES.IMPORTED_TEXT
        ? BLOCK_TYPES.IMPORTED_TEXT
        : BLOCK_TYPES.TEXT

  const content = clampText(
    String(block.content || ''),
    type === BLOCK_TYPES.IMAGE ? 1000 : 50000
  )
  const meta =
    type === BLOCK_TYPES.IMPORTED_TEXT
      ? {
          fileName: clampText(block.meta?.fileName || '', 180),
          collapsed: Boolean(block.meta?.collapsed),
        }
      : {}

  return {
    type,
    content,
    meta,
  }
}

function normalizePromptBlocks(blocks = []) {
  return Array.isArray(blocks)
    ? blocks.map((block) => normalizePromptBlock(block)).filter(Boolean)
    : []
}

function toCodexRunEvent(row) {
  return {
    id: Number(row.id),
    seq: Number(row.seq),
    eventType: String(row.event_type || '').trim() || 'event',
    payload: parseEventPayload(row.payload_json),
    createdAt: row.created_at,
  }
}

function toCodexRun(row, events = null) {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    taskSlug: row.task_slug,
    sessionId: row.session_id,
    engine: String(row.engine || '').trim() || 'codex',
    prompt: row.prompt || '',
    promptBlocks: parsePromptBlocks(row.prompt_blocks_json),
    status: row.status || 'running',
    responseMessage: row.response_message || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || row.created_at,
    finishedAt: row.finished_at || '',
    completed: TERMINAL_RUN_STATUSES.has(String(row.status || '')),
    eventCount: Math.max(0, Number(row.event_count) || 0),
    lastEventSeq: Math.max(0, Number(row.last_event_seq) || 0),
    events: Array.isArray(events) ? events : [],
    eventsIncluded: Array.isArray(events),
  }
}

function loadEventsForRunIds(runIds = [], afterSeq = 0) {
  if (!runIds.length) {
    return new Map()
  }

  const placeholders = runIds.map(() => '?').join(', ')
  const rows = all(
    `SELECT id, run_id, seq, event_type, payload_json, created_at
     FROM codex_run_events
     WHERE run_id IN (${placeholders})
       AND seq > ?
     ORDER BY run_id ASC, seq ASC, id ASC`,
    [...runIds, Math.max(0, Number(afterSeq) || 0)]
  )

  const grouped = new Map()
  rows.forEach((row) => {
    const runId = row.run_id
    if (!grouped.has(runId)) {
      grouped.set(runId, [])
    }
    grouped.get(runId).push(toCodexRunEvent(row))
  })

  return grouped
}

function getTaskRowBySlug(slug) {
  const targetSlug = String(slug || '').trim()
  if (!targetSlug) {
    return null
  }

  return get(
    `SELECT id, slug
     FROM tasks
     WHERE slug = ?`,
    [targetSlug]
  )
}

function getRunRowById(runId) {
  const targetId = String(runId || '').trim()
  if (!targetId) {
    return null
  }

  return get(
    `SELECT id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE id = ?`,
    [targetId]
  )
}

function clearPendingRunEventsFlushTimer() {
  if (pendingRunEventsFlushTimer) {
    clearTimeout(pendingRunEventsFlushTimer)
    pendingRunEventsFlushTimer = null
  }
}

function flushPendingRunEvents(runId = '') {
  const normalizedRunId = String(runId || '').trim()
  const targetRunIds = normalizedRunId
    ? [normalizedRunId]
    : [...pendingRunEventsByRunId.keys()]

  const flushableRunIds = targetRunIds.filter((item) => {
    const events = pendingRunEventsByRunId.get(item)
    return Array.isArray(events) && events.length > 0
  })

  if (!flushableRunIds.length) {
    return 0
  }

  let insertedCount = 0
  transaction(() => {
    flushableRunIds.forEach((targetRunId) => {
      const events = pendingRunEventsByRunId.get(targetRunId) || []
      if (!events.length) {
        pendingRunEventsByRunId.delete(targetRunId)
        return
      }

      events.forEach((event) => {
        run(
          `INSERT INTO codex_run_events (run_id, seq, event_type, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?)`,
          [targetRunId, event.seq, event.eventType, event.payloadJson, event.createdAt]
        )
        insertedCount += 1
      })

      pendingRunEventsByRunId.delete(targetRunId)
    })
  })

  if (!pendingRunEventsByRunId.size) {
    clearPendingRunEventsFlushTimer()
  }

  return insertedCount
}

function schedulePendingRunEventsFlush() {
  if (pendingRunEventsFlushTimer) {
    return
  }

  pendingRunEventsFlushTimer = setTimeout(() => {
    pendingRunEventsFlushTimer = null
    flushPendingRunEvents()
  }, EVENT_FLUSH_DELAY_MS)
  pendingRunEventsFlushTimer.unref?.()
}

export function isTerminalRunStatus(status = '') {
  return TERMINAL_RUN_STATUSES.has(String(status || '').trim())
}

export function getCodexRunById(runId, options = {}) {
  flushPendingRunEvents(runId)
  const row = getRunRowById(runId)
  if (!row) {
    return null
  }

  if (!options.withEvents) {
    return toCodexRun(row, null)
  }

  const events = loadEventsForRunIds([row.id]).get(row.id) || []
  return toCodexRun(row, events)
}

export function listTaskCodexRuns(taskSlug, limit = 20) {
  return listTaskCodexRunsWithOptions(taskSlug, { limit })
}

export function listTaskCodexRunsWithOptions(taskSlug, options = {}) {
  const task = getTaskRowBySlug(taskSlug)
  if (!task) {
    return null
  }

  flushPendingRunEvents()
  const eventsMode = normalizeCodexRunEventsMode(options.events, options)
  const includeEvents = eventsMode === CODEX_RUN_EVENTS_MODES.ALL
  const includeLatestEvents = eventsMode === CODEX_RUN_EVENTS_MODES.LATEST
  const limit = Math.max(1, Number(options.limit) || 20)
  const rows = all(
    `SELECT
       runs.id,
       runs.task_slug,
       runs.session_id,
       runs.engine,
       runs.prompt,
       runs.prompt_blocks_json,
       runs.status,
       runs.response_message,
       runs.error_message,
       runs.created_at,
       runs.updated_at,
       runs.started_at,
       runs.finished_at,
       COUNT(events.id) AS event_count,
       MAX(events.seq) AS last_event_seq
     FROM codex_runs
     AS runs
     LEFT JOIN codex_run_events AS events
       ON events.run_id = runs.id
     WHERE runs.task_slug = ?
     GROUP BY
       runs.id,
       runs.task_slug,
       runs.session_id,
       runs.engine,
       runs.prompt,
       runs.prompt_blocks_json,
       runs.status,
       runs.response_message,
       runs.error_message,
       runs.created_at,
       runs.updated_at,
       runs.started_at,
       runs.finished_at
     ORDER BY runs.created_at DESC
     LIMIT ?`,
    [task.slug, limit]
  )

  const eventRunIds = includeEvents
    ? rows.map((row) => row.id)
    : includeLatestEvents && rows.length
      ? [rows[0].id]
      : []
  const eventsByRunId = eventRunIds.length ? loadEventsForRunIds(eventRunIds) : null

  return rows.map((row, index) => {
    const shouldAttachEvents = includeEvents || (includeLatestEvents && index === 0)
    return toCodexRun(row, shouldAttachEvents ? (eventsByRunId?.get(row.id) || []) : null)
  })
}

export function listCodexRunEvents(runId, options = {}) {
  flushPendingRunEvents(runId)
  const targetRun = getRunRowById(runId)
  if (!targetRun) {
    return null
  }

  const afterSeq = Math.max(0, Number(options.afterSeq) || 0)
  const limit = Math.max(1, Number(options.limit) || 500)
  const rows = all(
    `SELECT id, run_id, seq, event_type, payload_json, created_at
     FROM codex_run_events
     WHERE run_id = ?
       AND seq > ?
     ORDER BY seq ASC, id ASC
     LIMIT ?`,
    [targetRun.id, afterSeq, limit]
  )

  return rows.map(toCodexRunEvent)
}

export function createCodexRun(input = {}) {
  const taskSlug = String(input.taskSlug || '').trim()
  const sessionId = String(input.sessionId || '').trim()
  const prompt = String(input.prompt || '').trim()
  const promptBlocks = normalizePromptBlocks(input.promptBlocks)

  if (!taskSlug) {
    throw new Error('缺少任务。')
  }
  if (!sessionId) {
    throw new Error('请先选择 PromptX 项目。')
  }
  if (!prompt) {
    throw new Error('没有可发送的提示词。')
  }

  const task = getTaskBySlug(taskSlug)
  if (!task || task.expired) {
    throw new Error('任务不存在。')
  }

  const session = getPromptxCodexSessionById(sessionId)
  if (!session) {
    throw new Error('没有找到对应的 PromptX 项目。')
  }
  assertAgentRunner(session.engine)

  const now = new Date().toISOString()
  const runId = `pxcr_${nanoid(12)}`

  transaction(() => {
    run(
      `INSERT INTO codex_runs (
         id, task_slug, session_id, engine, prompt, prompt_blocks_json, status,
         response_message, error_message, created_at, updated_at, started_at, finished_at
       )
       VALUES (?, ?, ?, ?, ?, ?, 'running', '', '', ?, ?, ?, NULL)`,
      [runId, task.slug, session.id, session.engine || 'codex', prompt, JSON.stringify(promptBlocks), now, now, now]
    )
  })

  updateTaskCodexSession(task.slug, session.id)

  try {
    captureTaskGitBaseline(task.slug, session.cwd)
    captureRunGitBaseline(runId, session.cwd)
  } catch {
    // Ignore diff baseline failures so they do not block the Codex run itself.
  }

  return getCodexRunById(runId, { withEvents: true })
}

function captureTerminalRunSnapshot(runRecord) {
  const sessionId = String(runRecord?.session_id || runRecord?.sessionId || '').trim()
  if (!sessionId) {
    return null
  }

  const session = getPromptxCodexSessionById(sessionId)
  if (!session?.cwd) {
    return null
  }

  try {
    return captureRunGitFinalSnapshot(runRecord.id, session.cwd)
  } catch {
    return null
  }
}

export function appendCodexRunEvent(runId, payloadOrSeq = {}, maybeSeqOrPayload = 1) {
  const targetRun = getRunRowById(runId)
  if (!targetRun) {
    return null
  }

  const seqFirst = typeof payloadOrSeq === 'number'
  const seq = Math.max(1, Number(seqFirst ? payloadOrSeq : maybeSeqOrPayload) || 1)
  const rawPayload = seqFirst ? maybeSeqOrPayload : payloadOrSeq
  const normalizedPayload = rawPayload && typeof rawPayload === 'object'
    ? rawPayload
    : { type: 'info', message: String(rawPayload || '') }
  const now = new Date().toISOString()
  const eventType = String(normalizedPayload.type || '').trim() || 'event'
  const payloadJson = JSON.stringify(normalizedPayload)

  const pendingEvents = pendingRunEventsByRunId.get(targetRun.id) || []
  pendingEvents.push({
    seq,
    eventType,
    payloadJson,
    createdAt: now,
  })
  pendingRunEventsByRunId.set(targetRun.id, pendingEvents)
  schedulePendingRunEventsFlush()

  return {
    id: 0,
    seq,
    eventType,
    payload: normalizedPayload,
    createdAt: now,
  }
}

export function updateCodexRun(runId, patch = {}) {
  const existing = getRunRowById(runId)
  if (!existing) {
    return null
  }

  const status = String(patch.status || existing.status || 'running').trim() || 'running'
  const responseMessage = Object.prototype.hasOwnProperty.call(patch, 'responseMessage')
    ? String(patch.responseMessage || '')
    : String(existing.response_message || '')
  const errorMessage = Object.prototype.hasOwnProperty.call(patch, 'errorMessage')
    ? String(patch.errorMessage || '')
    : String(existing.error_message || '')
  const finishedAt = Object.prototype.hasOwnProperty.call(patch, 'finishedAt')
    ? String(patch.finishedAt || '')
    : String(existing.finished_at || '')
  const updatedAt = patch.updatedAt || new Date().toISOString()

  if (isTerminalRunStatus(status) || finishedAt) {
    flushPendingRunEvents(existing.id)
    captureTerminalRunSnapshot(existing)
  }

  transaction(() => {
    run(
      `UPDATE codex_runs
       SET status = ?, response_message = ?, error_message = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, responseMessage, errorMessage, finishedAt || null, updatedAt, existing.id]
    )
  })

  return getCodexRunById(existing.id, { withEvents: true })
}

export function listRunningCodexSessionIds() {
  return all(
    `SELECT DISTINCT session_id
     FROM codex_runs
     WHERE status = 'running'`
  ).map((row) => String(row.session_id || '').trim()).filter(Boolean)
}

export function listRunningCodexTaskSlugs() {
  return all(
    `SELECT DISTINCT task_slug
     FROM codex_runs
     WHERE status = 'running'`
  ).map((row) => String(row.task_slug || '').trim()).filter(Boolean)
}

export function getRunningCodexRunBySessionId(sessionId) {
  const targetId = String(sessionId || '').trim()
  if (!targetId) {
    return null
  }

  const row = get(
    `SELECT id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE session_id = ?
       AND status = 'running'
     ORDER BY created_at DESC
     LIMIT 1`,
    [targetId]
  )

  return toCodexRun(row)
}

export function getRunningCodexRunByTaskSlug(taskSlug) {
  const targetSlug = String(taskSlug || '').trim()
  if (!targetSlug) {
    return null
  }

  const row = get(
    `SELECT id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE task_slug = ?
       AND status = 'running'
     ORDER BY created_at DESC
     LIMIT 1`,
    [targetSlug]
  )

  return toCodexRun(row)
}

export function hasRunningCodexRunsForTask(taskSlug) {
  const task = getTaskRowBySlug(taskSlug)
  if (!task) {
    return false
  }

  return Boolean(
    get(
      `SELECT 1
       FROM codex_runs
       WHERE task_slug = ?
         AND status = 'running'
       LIMIT 1`,
      [task.slug]
    )
  )
}

export function deleteTaskCodexRuns(taskSlug) {
  const task = getTaskRowBySlug(taskSlug)
  if (!task) {
    return { error: 'not_found' }
  }

  transaction(() => {
    run('DELETE FROM codex_runs WHERE task_slug = ?', [task.slug])
  })

  return { ok: true }
}

export function markRunningCodexRunsInterrupted(message = '服务已重启，之前的执行已中断。') {
  const runningRuns = all(
    `SELECT id
     FROM codex_runs
     WHERE status = 'running'
     ORDER BY created_at ASC`
  )

  runningRuns.forEach((row) => {
    const existingEvents = listCodexRunEvents(row.id) || []
    const nextSeq = existingEvents.length
      ? Math.max(...existingEvents.map((item) => Number(item.seq) || 0)) + 1
      : 1

    appendCodexRunEvent(row.id, {
      type: 'interrupted',
      message,
    }, nextSeq)

    updateCodexRun(row.id, {
      status: 'interrupted',
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    })
  })

  return runningRuns.length
}

export function markInterruptedCodexRuns(message) {
  return markRunningCodexRunsInterrupted(message)
}
