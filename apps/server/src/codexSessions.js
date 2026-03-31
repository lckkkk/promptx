import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { normalizeAgentEngine } from '../../../packages/shared/src/index.js'
import { all, get, run, transaction } from './db.js'
import { assertAgentRunner } from './agents/index.js'
import { createApiError } from './apiErrors.js'

function createHttpError(message, statusCode = 400) {
  return createApiError('', message, statusCode)
}

function cloneEngineMeta(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? { ...input }
    : {}
}

function getSessionIdentityValue(record = {}) {
  return String(
    record.engineSessionId
    || record.engine_session_id
    || record.engineThreadId
    || record.engine_thread_id
    || record.codexThreadId
    || record.codex_thread_id
    || ''
  ).trim()
}

function hasSessionIdentity(record = {}) {
  return Boolean(getSessionIdentityValue(record))
}

function hasManualSessionBinding(engineMeta = {}) {
  return Boolean(engineMeta?.manualSessionBinding)
}

function mapSessionIdToEngine(engine, sessionId = '') {
  const normalizedEngine = normalizeAgentEngine(engine)
  const normalizedSessionId = String(sessionId || '').trim()

  if (!normalizedSessionId) {
    return {
      codexThreadId: '',
      engineSessionId: '',
      engineThreadId: '',
    }
  }

  if (normalizedEngine === 'codex') {
    return {
      codexThreadId: normalizedSessionId,
      engineSessionId: '',
      engineThreadId: normalizedSessionId,
    }
  }

  return {
    codexThreadId: '',
    engineSessionId: normalizedSessionId,
    engineThreadId: normalizedSessionId,
  }
}

function toCodexSession(row) {
  if (!row) {
    return null
  }

  const engineMeta = parseEngineMeta(row.engine_meta_json)
  const sessionId = getSessionIdentityValue(row)

  return {
    id: row.id,
    title: row.title,
    engine: normalizeAgentEngine(row.engine),
    cwd: row.cwd,
    codexThreadId: row.codex_thread_id || row.engine_thread_id || '',
    engineSessionId: row.engine_session_id || '',
    engineThreadId: row.engine_thread_id || row.codex_thread_id || '',
    sessionId,
    engineMeta,
    running: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    started: hasSessionIdentity(row) && !hasManualSessionBinding(engineMeta),
  }
}

function parseEngineMeta(rawValue = '{}') {
  try {
    const parsed = JSON.parse(rawValue || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function ensureAgentRunnerAvailable(engine) {
  try {
    assertAgentRunner(engine)
  } catch (error) {
    throw createApiError('errors.agentEngineUnavailable', error.message || '当前执行引擎不可用。')
  }
}

function normalizeTitle(input = '', cwd = '') {
  const title = String(input || '').trim().slice(0, 140)
  if (title) {
    return title
  }

  const baseName = path.basename(String(cwd || '').trim())
  return baseName || 'PromptX 项目'
}

export function normalizeCwd(input = '') {
  const cwd = String(input || '').trim()
  if (!cwd) {
    throw createApiError('errors.cwdRequired', '请先填写工作目录。')
  }

  const resolved = path.resolve(cwd)
  if (!fs.existsSync(resolved)) {
    throw createApiError('errors.cwdNotFound', '工作目录不存在，请重新确认。')
  }

  const stats = fs.statSync(resolved)
  if (!stats.isDirectory()) {
    throw createApiError('errors.cwdMustBeDirectory', '工作目录必须是文件夹。')
  }

  return resolved
}

export function listPromptxCodexSessions(limit = 30) {
  const rows = all(
    `SELECT id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at
     FROM codex_sessions
     ORDER BY updated_at DESC
     LIMIT ?`,
    [Math.max(1, Number(limit) || 30)]
  )

  return rows.map(toCodexSession)
}

export function getPromptxCodexSessionById(sessionId) {
  const targetId = String(sessionId || '').trim()
  if (!targetId) {
    return null
  }

  return toCodexSession(
    get(
      `SELECT id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at
       FROM codex_sessions
       WHERE id = ?`,
      [targetId]
    )
  )
}

export function createPromptxCodexSession(input = {}) {
  const cwd = normalizeCwd(input.cwd)
  const title = normalizeTitle(input.title, cwd)
  const engine = normalizeAgentEngine(input.engine)
  const sessionId = String(input.sessionId || '').trim()
  const sessionFields = mapSessionIdToEngine(engine, sessionId)
  const engineMeta = sessionId
    ? { manualSessionBinding: true }
    : {}
  ensureAgentRunnerAvailable(engine)
  const now = new Date().toISOString()
  const id = `pxcs_${nanoid(12)}`

  transaction(() => {
    run(
      `INSERT INTO codex_sessions (
         id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        title,
        engine,
        cwd,
        sessionFields.codexThreadId,
        sessionFields.engineSessionId,
        sessionFields.engineThreadId,
        JSON.stringify(engineMeta),
        now,
        now,
      ]
    )
  })

  return getPromptxCodexSessionById(id)
}

export function updatePromptxCodexSession(sessionId, patch = {}) {
  const existing = getPromptxCodexSessionById(sessionId)
  if (!existing) {
    return null
  }

  const wantsCwd = Object.prototype.hasOwnProperty.call(patch, 'cwd')
  const nextCwd = wantsCwd
    ? normalizeCwd(patch.cwd)
    : existing.cwd
  const wantsEngine = Object.prototype.hasOwnProperty.call(patch, 'engine')
  const nextEngine = wantsEngine
    ? normalizeAgentEngine(patch.engine)
    : existing.engine
  ensureAgentRunnerAvailable(nextEngine)

  if (existing.started && wantsCwd && nextCwd !== existing.cwd) {
    throw createApiError('errors.startedProjectCwdLocked', '已启动的 PromptX 项目不能直接修改工作目录。', 409)
  }
  if (existing.started && wantsEngine && nextEngine !== existing.engine) {
    throw createApiError('errors.startedProjectEngineLocked', '已启动的 PromptX 项目不能直接切换执行引擎，请新建项目。', 409)
  }

  const wantsGenericSessionId = Object.prototype.hasOwnProperty.call(patch, 'sessionId')
  const wantsCodexThreadId = Object.prototype.hasOwnProperty.call(patch, 'codexThreadId')
  const wantsEngineSessionId = Object.prototype.hasOwnProperty.call(patch, 'engineSessionId')
  const wantsEngineThreadId = Object.prototype.hasOwnProperty.call(patch, 'engineThreadId')
  const wantsExplicitSessionFields = wantsCodexThreadId || wantsEngineSessionId || wantsEngineThreadId
  const nextSessionId = wantsGenericSessionId
    ? String(patch.sessionId || '').trim()
    : existing.sessionId
  if (existing.started && wantsGenericSessionId && nextSessionId !== existing.sessionId) {
    throw createApiError('errors.startedProjectSessionLocked', '已启动的 PromptX 项目不能直接修改会话 ID，请新建项目。', 409)
  }

  const title = Object.prototype.hasOwnProperty.call(patch, 'title')
    ? normalizeTitle(patch.title, nextCwd)
    : existing.title
  let codexThreadId = existing.codexThreadId
  let engineSessionId = existing.engineSessionId
  let engineThreadId = existing.engineThreadId

  if (wantsGenericSessionId || (wantsEngine && hasManualSessionBinding(existing.engineMeta) && !wantsExplicitSessionFields)) {
    const mapped = mapSessionIdToEngine(nextEngine, nextSessionId)
    codexThreadId = mapped.codexThreadId
    engineSessionId = mapped.engineSessionId
    engineThreadId = mapped.engineThreadId
  } else {
    if (wantsCodexThreadId) {
      codexThreadId = String(patch.codexThreadId || '').trim()
    }
    if (wantsEngineSessionId) {
      engineSessionId = String(patch.engineSessionId || '').trim()
    }
    if (wantsEngineThreadId) {
      engineThreadId = String(patch.engineThreadId || '').trim()
    }
  }

  const engineMeta = Object.prototype.hasOwnProperty.call(patch, 'engineMeta')
    ? cloneEngineMeta(patch.engineMeta)
    : cloneEngineMeta(existing.engineMeta)

  if (wantsGenericSessionId) {
    if (nextSessionId) {
      engineMeta.manualSessionBinding = true
    } else {
      delete engineMeta.manualSessionBinding
    }
  } else if (patch.clearManualSessionBinding === true || wantsExplicitSessionFields) {
    delete engineMeta.manualSessionBinding
  }

  const updatedAt = patch.updatedAt || new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE codex_sessions
       SET title = ?, engine = ?, cwd = ?, codex_thread_id = ?, engine_session_id = ?, engine_thread_id = ?, engine_meta_json = ?, updated_at = ?
       WHERE id = ?`,
      [title, nextEngine, nextCwd, codexThreadId, engineSessionId, engineThreadId, JSON.stringify(engineMeta), updatedAt, existing.id]
    )
  })

  return getPromptxCodexSessionById(existing.id)
}

export function resetPromptxCodexSession(sessionId) {
  const existing = getPromptxCodexSessionById(sessionId)
  if (!existing) {
    return null
  }

  const updatedAt = new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE codex_sessions
       SET codex_thread_id = '', engine_session_id = '', engine_thread_id = '', engine_meta_json = '{}', updated_at = ?
       WHERE id = ?`,
      [updatedAt, existing.id]
    )
  })

  return getPromptxCodexSessionById(existing.id)
}

export function deletePromptxCodexSession(sessionId) {
  const existing = getPromptxCodexSessionById(sessionId)
  if (!existing) {
    return null
  }

  transaction(() => {
    run('DELETE FROM codex_sessions WHERE id = ?', [existing.id])
  })

  return existing
}
