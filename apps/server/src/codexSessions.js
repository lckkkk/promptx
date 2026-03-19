import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { normalizeAgentEngine } from '../../../packages/shared/src/index.js'
import { all, get, run, transaction } from './db.js'
import { assertAgentRunner } from './agents/index.js'

function createHttpError(message, statusCode = 400) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

function toCodexSession(row) {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    title: row.title,
    engine: normalizeAgentEngine(row.engine),
    cwd: row.cwd,
    codexThreadId: row.codex_thread_id || row.engine_thread_id || '',
    engineSessionId: row.engine_session_id || '',
    engineThreadId: row.engine_thread_id || row.codex_thread_id || '',
    engineMeta: parseEngineMeta(row.engine_meta_json),
    running: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    started: Boolean(row.engine_thread_id || row.codex_thread_id),
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
    throw createHttpError(error.message || '当前执行引擎不可用。')
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
    throw createHttpError('请先填写工作目录。')
  }

  const resolved = path.resolve(cwd)
  if (!fs.existsSync(resolved)) {
    throw createHttpError('工作目录不存在，请重新确认。')
  }

  const stats = fs.statSync(resolved)
  if (!stats.isDirectory()) {
    throw createHttpError('工作目录必须是文件夹。')
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
  ensureAgentRunnerAvailable(engine)
  const now = new Date().toISOString()
  const id = `pxcs_${nanoid(12)}`

  transaction(() => {
    run(
      `INSERT INTO codex_sessions (
         id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, '', '', '', '{}', ?, ?)`,
      [id, title, engine, cwd, now, now]
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
    throw createHttpError('已启动的 PromptX 项目不能直接修改工作目录。', 409)
  }
  if (wantsEngine && nextEngine !== existing.engine) {
    throw createHttpError('暂不支持直接切换执行引擎，请新建项目。', 409)
  }

  const title = Object.prototype.hasOwnProperty.call(patch, 'title')
    ? normalizeTitle(patch.title, nextCwd)
    : existing.title
  const codexThreadId = Object.prototype.hasOwnProperty.call(patch, 'codexThreadId')
    ? String(patch.codexThreadId || '').trim()
    : existing.codexThreadId
  const engineSessionId = Object.prototype.hasOwnProperty.call(patch, 'engineSessionId')
    ? String(patch.engineSessionId || '').trim()
    : existing.engineSessionId
  const engineThreadId = Object.prototype.hasOwnProperty.call(patch, 'engineThreadId')
    ? String(patch.engineThreadId || '').trim()
    : (codexThreadId || existing.engineThreadId)
  const engineMeta = Object.prototype.hasOwnProperty.call(patch, 'engineMeta')
    ? (patch.engineMeta && typeof patch.engineMeta === 'object' ? patch.engineMeta : {})
    : existing.engineMeta
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
