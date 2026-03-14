import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import initSqlJs from 'sql.js'

const require = createRequire(import.meta.url)
const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
const dataDir = path.resolve(process.cwd(), 'data')
const dbPath = path.join(dataDir, 'promptx.sqlite')

fs.mkdirSync(dataDir, { recursive: true })

const SQL = await initSqlJs({
  locateFile: () => wasmPath,
})

const db = fs.existsSync(dbPath)
  ? new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)))
  : new SQL.Database()

db.run(`
  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    edit_token TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'listed',
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS blocks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_documents_visibility ON documents(visibility, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_blocks_document_sort ON blocks(document_id, sort_order ASC);

  CREATE TABLE IF NOT EXISTS codex_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    cwd TEXT NOT NULL,
    codex_thread_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_codex_sessions_updated_at ON codex_sessions(updated_at DESC);
`)

// Clean up leftovers created before foreign keys were enforced.
db.run(`
  DELETE FROM blocks
  WHERE document_id NOT IN (SELECT id FROM documents);
`)

persist()

export function persist() {
  fs.writeFileSync(dbPath, Buffer.from(db.export()))
  db.run('PRAGMA foreign_keys = ON;')
}

export function all(sql, params = []) {
  const stmt = db.prepare(sql, params)
  const rows = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}

export function get(sql, params = []) {
  return all(sql, params)[0] || null
}

export function run(sql, params = []) {
  db.run(sql, params)
}

export function transaction(callback) {
  try {
    db.run('BEGIN')
    const result = callback()
    db.run('COMMIT')
    persist()
    return result
  } catch (error) {
    db.run('ROLLBACK')
    throw error
  }
}
