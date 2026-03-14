import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { all, get, run, transaction } from './db.js'

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
    cwd: row.cwd,
    codexThreadId: row.codex_thread_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    started: Boolean(row.codex_thread_id),
  }
}

function normalizeTitle(input = '', cwd = '') {
  const title = String(input || '').trim().slice(0, 140)
  if (title) {
    return title
  }

  const baseName = path.basename(String(cwd || '').trim())
  return baseName || 'PromptX 会话'
}

function normalizeCwd(input = '') {
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
    `SELECT id, title, cwd, codex_thread_id, created_at, updated_at
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
      `SELECT id, title, cwd, codex_thread_id, created_at, updated_at
       FROM codex_sessions
       WHERE id = ?`,
      [targetId]
    )
  )
}

export function createPromptxCodexSession(input = {}) {
  const cwd = normalizeCwd(input.cwd)
  const title = normalizeTitle(input.title, cwd)
  const now = new Date().toISOString()
  const id = `pxcs_${nanoid(12)}`

  transaction(() => {
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      [id, title, cwd, now, now]
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

  if (existing.started && wantsCwd && nextCwd !== existing.cwd) {
    throw createHttpError('已启动的 PromptX 会话不能直接修改工作目录。', 409)
  }

  const title = Object.prototype.hasOwnProperty.call(patch, 'title')
    ? normalizeTitle(patch.title, nextCwd)
    : existing.title
  const codexThreadId = Object.prototype.hasOwnProperty.call(patch, 'codexThreadId')
    ? String(patch.codexThreadId || '').trim()
    : existing.codexThreadId
  const updatedAt = patch.updatedAt || new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE codex_sessions
       SET title = ?, cwd = ?, codex_thread_id = ?, updated_at = ?
       WHERE id = ?`,
      [title, nextCwd, codexThreadId, updatedAt, existing.id]
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
