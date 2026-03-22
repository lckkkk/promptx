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

const ACTIVE_RUN_STATUSES = new Set(['queued', 'starting', 'running', 'stopping'])
const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'stopped', 'interrupted', 'stop_timeout'])
const EVENT_FLUSH_DELAY_MS = 180
const DEFAULT_RUN_EVENT_RETENTION_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.PROMPTX_CODEX_RUN_EVENT_RETENTION_MS) || 14 * 24 * 60 * 60 * 1000
)
const DEFAULT_MAX_EVENTS_PER_RUN = Math.max(
  50,
  Number(process.env.PROMPTX_CODEX_RUN_EVENTS_MAX_PER_RUN) || 2000
)

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

export function isActiveRunStatus(status = '') {
  return ACTIVE_RUN_STATUSES.has(String(status || '').trim())
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
  const initialStatus = String(input.status || 'queued').trim() || 'queued'

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
  const startedAt = initialStatus === 'queued' ? null : now

  transaction(() => {
    run(
      `INSERT INTO codex_runs (
         id, task_slug, session_id, engine, prompt, prompt_blocks_json, status,
         response_message, error_message, created_at, updated_at, started_at, finished_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', ?, ?, ?, NULL)`,
      [runId, task.slug, session.id, session.engine || 'codex', prompt, JSON.stringify(promptBlocks), initialStatus, now, now, startedAt]
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

export function appendCodexRunEventAutoSeq(runId, payload = {}) {
  const existingEvents = listCodexRunEvents(runId, { limit: 5000 }) || []
  const nextSeq = existingEvents.length
    ? Math.max(...existingEvents.map((item) => Number(item.seq) || 0)) + 1
    : 1

  return appendCodexRunEvent(runId, payload, nextSeq)
}

export function appendCodexRunEventsBatch(runId, items = []) {
  const targetRun = getRunRowById(runId)
  if (!targetRun) {
    return null
  }

  flushPendingRunEvents(targetRun.id)

  const normalizedItems = (Array.isArray(items) ? items : [])
    .map((item) => {
      const seq = Math.max(1, Number(item?.seq) || 0)
      if (!seq) {
        return null
      }

      const payload = item?.payload && typeof item.payload === 'object'
        ? item.payload
        : { type: 'event', message: String(item?.payload || '') }
      const eventType = String(item?.type || payload.type || '').trim() || 'event'
      const createdAt = String(item?.ts || item?.createdAt || '').trim() || new Date().toISOString()

      return {
        seq,
        eventType,
        payloadJson: JSON.stringify(payload),
        createdAt,
      }
    })
    .filter(Boolean)
    .sort((left, right) => left.seq - right.seq)

  if (!normalizedItems.length) {
    return []
  }

  transaction(() => {
    normalizedItems.forEach((item) => {
      run(
        `INSERT OR IGNORE INTO codex_run_events (run_id, seq, event_type, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [targetRun.id, item.seq, item.eventType, item.payloadJson, item.createdAt]
      )
    })
  })

  return normalizedItems.map((item) => ({
    id: 0,
    seq: item.seq,
    eventType: item.eventType,
    payload: parseEventPayload(item.payloadJson),
    createdAt: item.createdAt,
  }))
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
  const startedAt = Object.prototype.hasOwnProperty.call(patch, 'startedAt')
    ? String(patch.startedAt || '')
    : String(existing.started_at || '')
  const updatedAt = patch.updatedAt || new Date().toISOString()

  if (isTerminalRunStatus(status) || finishedAt) {
    flushPendingRunEvents(existing.id)
    captureTerminalRunSnapshot(existing)
  }

  transaction(() => {
    run(
      `UPDATE codex_runs
       SET status = ?, response_message = ?, error_message = ?, started_at = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, responseMessage, errorMessage, startedAt || null, finishedAt || null, updatedAt, existing.id]
    )
  })

  return getCodexRunById(existing.id, { withEvents: true })
}

export function updateCodexRunFromRunnerStatus(runId, patch = {}) {
  const existing = getRunRowById(runId)
  if (!existing) {
    return null
  }

  const status = String(patch.status || '').trim()
  const nextPatch = {
    ...(status ? { status } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'responseMessage')
      ? { responseMessage: patch.responseMessage }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'errorMessage')
      ? { errorMessage: patch.errorMessage }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'startedAt')
      ? { startedAt: patch.startedAt }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'finishedAt')
      ? { finishedAt: patch.finishedAt }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, 'updatedAt')
      ? { updatedAt: patch.updatedAt }
      : {}),
  }

  if (
    !Object.prototype.hasOwnProperty.call(nextPatch, 'startedAt')
    && (status === 'starting' || status === 'running')
    && !String(existing.started_at || '').trim()
  ) {
    nextPatch.startedAt = new Date().toISOString()
  }

  if (
    !Object.prototype.hasOwnProperty.call(nextPatch, 'finishedAt')
    && isTerminalRunStatus(status)
  ) {
    nextPatch.finishedAt = new Date().toISOString()
  }

  return updateCodexRun(existing.id, nextPatch)
}

export function listRunningCodexSessionIds() {
  const activeStatuses = [...ACTIVE_RUN_STATUSES]
  const placeholders = activeStatuses.map(() => '?').join(', ')
  return all(
    `SELECT DISTINCT session_id
     FROM codex_runs
     WHERE status IN (${placeholders})`,
    activeStatuses
  ).map((row) => String(row.session_id || '').trim()).filter(Boolean)
}

export function listRunningCodexTaskSlugs() {
  const activeStatuses = [...ACTIVE_RUN_STATUSES]
  const placeholders = activeStatuses.map(() => '?').join(', ')
  return all(
    `SELECT DISTINCT task_slug
     FROM codex_runs
     WHERE status IN (${placeholders})`,
    activeStatuses
  ).map((row) => String(row.task_slug || '').trim()).filter(Boolean)
}

export function getRunningCodexRunBySessionId(sessionId) {
  const targetId = String(sessionId || '').trim()
  if (!targetId) {
    return null
  }

  const activeStatuses = [...ACTIVE_RUN_STATUSES]
  const placeholders = activeStatuses.map(() => '?').join(', ')
  const row = get(
    `SELECT id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE session_id = ?
       AND status IN (${placeholders})
     ORDER BY created_at DESC
     LIMIT 1`,
    [targetId, ...activeStatuses]
  )

  return toCodexRun(row)
}

export function getRunningCodexRunByTaskSlug(taskSlug) {
  const targetSlug = String(taskSlug || '').trim()
  if (!targetSlug) {
    return null
  }

  const activeStatuses = [...ACTIVE_RUN_STATUSES]
  const placeholders = activeStatuses.map(() => '?').join(', ')
  const row = get(
    `SELECT id, task_slug, session_id, engine, prompt, prompt_blocks_json, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE task_slug = ?
       AND status IN (${placeholders})
     ORDER BY created_at DESC
     LIMIT 1`,
    [targetSlug, ...activeStatuses]
  )

  return toCodexRun(row)
}

export function hasRunningCodexRunsForTask(taskSlug) {
  const task = getTaskRowBySlug(taskSlug)
  if (!task) {
    return false
  }

  const activeStatuses = [...ACTIVE_RUN_STATUSES]
  const placeholders = activeStatuses.map(() => '?').join(', ')
  return Boolean(
    get(
      `SELECT 1
       FROM codex_runs
       WHERE task_slug = ?
         AND status IN (${placeholders})
       LIMIT 1`,
      [task.slug, ...activeStatuses]
    )
  )
}

export function listStaleActiveCodexRuns(maxAgeMs = 20000, now = new Date()) {
  flushPendingRunEvents()
  const activeStatuses = [...ACTIVE_RUN_STATUSES]
  const placeholders = activeStatuses.map(() => '?').join(', ')
  const referenceTime = now instanceof Date ? now : new Date(now)
  const cutoff = new Date(referenceTime.getTime() - Math.max(1000, Number(maxAgeMs) || 20000)).toISOString()
  const lastActivityExpr = `CASE
    WHEN MAX(events.created_at) IS NOT NULL AND MAX(events.created_at) > runs.updated_at
      THEN MAX(events.created_at)
    ELSE runs.updated_at
  END`
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
       runs.finished_at
     FROM codex_runs AS runs
     LEFT JOIN codex_run_events AS events
       ON events.run_id = runs.id
     WHERE runs.status IN (${placeholders})
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
     HAVING ${lastActivityExpr} <= ?
     ORDER BY ${lastActivityExpr} ASC, runs.created_at ASC`,
    [...activeStatuses, cutoff]
  )

  return rows.map((row) => toCodexRun(row))
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

export function pruneCodexRunEvents(options = {}) {
  flushPendingRunEvents()

  const retentionMs = Math.max(60 * 1000, Number(options.retentionMs) || DEFAULT_RUN_EVENT_RETENTION_MS)
  const maxEventsPerRun = Math.max(1, Number(options.maxEventsPerRun) || DEFAULT_MAX_EVENTS_PER_RUN)
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now())
  const cutoffIso = new Date(now.getTime() - retentionMs).toISOString()
  const terminalStatuses = [...TERMINAL_RUN_STATUSES]
  const statusPlaceholders = terminalStatuses.map(() => '?').join(', ')

  const staleRows = all(
    `SELECT events.id
     FROM codex_run_events AS events
     INNER JOIN codex_runs AS runs
       ON runs.id = events.run_id
     WHERE runs.status IN (${statusPlaceholders})
       AND COALESCE(NULLIF(runs.finished_at, ''), runs.updated_at, runs.created_at) <= ?`,
    [...terminalStatuses, cutoffIso]
  )

  let removedByRetention = 0
  if (staleRows.length) {
    transaction(() => {
      staleRows.forEach((row) => {
        run('DELETE FROM codex_run_events WHERE id = ?', [row.id])
        removedByRetention += 1
      })
    })
  }

  const cappedRunRows = all(
    `SELECT events.run_id AS runId, MAX(events.seq) AS maxSeq, COUNT(events.id) AS eventCount
     FROM codex_run_events AS events
     INNER JOIN codex_runs AS runs
       ON runs.id = events.run_id
     WHERE runs.status IN (${statusPlaceholders})
     GROUP BY events.run_id
     HAVING COUNT(events.id) > ?`,
    [...terminalStatuses, maxEventsPerRun]
  )

  let removedByCount = 0
  transaction(() => {
    cappedRunRows.forEach((row) => {
      const maxSeq = Math.max(0, Number(row.maxSeq) || 0)
      const minSeqToKeep = Math.max(1, maxSeq - maxEventsPerRun + 1)
      const deleteCount = Math.max(
        0,
        Number(
          get(
            `SELECT COUNT(*) AS count
             FROM codex_run_events
             WHERE run_id = ?
               AND seq < ?`,
            [row.runId, minSeqToKeep]
          )?.count
        ) || 0
      )
      if (!deleteCount) {
        return
      }
      run(
        `DELETE FROM codex_run_events
         WHERE run_id = ?
           AND seq < ?`,
        [row.runId, minSeqToKeep]
      )
      removedByCount += deleteCount
    })
  })

  const remainingEvents = get('SELECT COUNT(*) AS count FROM codex_run_events')?.count || 0
  return {
    retentionMs,
    maxEventsPerRun,
    cutoffIso,
    removedByRetention,
    removedByCount,
    removedTotal: removedByRetention + removedByCount,
    remainingEvents: Math.max(0, Number(remainingEvents) || 0),
    touchedRuns: cappedRunRows.length,
  }
}

export function markRunningCodexRunsInterrupted(message = '服务已重启，之前的执行已中断。') {
  const activeStatuses = [...ACTIVE_RUN_STATUSES]
  const placeholders = activeStatuses.map(() => '?').join(', ')
  const runningRuns = all(
    `SELECT id
     FROM codex_runs
     WHERE status IN (${placeholders})
     ORDER BY created_at ASC`,
    activeStatuses
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
