import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ensurePromptxStorageReady } from './appPaths.js'

const SCHEMA_VERSION = 2
const { dataDir } = ensurePromptxStorageReady()
const dbPath = path.join(dataDir, 'promptx.sqlite')
const dbWalPath = `${dbPath}-wal`
const dbShmPath = `${dbPath}-shm`

fs.mkdirSync(dataDir, { recursive: true })

let db = openDatabaseFromDisk()
let transactionDepth = 0

function setDatabasePragmas(targetDb) {
  targetDb.pragma('foreign_keys = ON')
  targetDb.pragma('journal_mode = WAL')
  targetDb.pragma('synchronous = NORMAL')
}

function validateDatabase(targetDb) {
  targetDb.prepare('SELECT name FROM sqlite_master LIMIT 1').all()
}

function createDatabaseConnection() {
  const connection = new Database(dbPath)
  setDatabasePragmas(connection)
  validateDatabase(connection)
  return connection
}

function closeDatabase(targetDb) {
  if (!targetDb) {
    return
  }

  try {
    targetDb.close()
  } catch {
    // Ignore close failures during process shutdown or reset.
  }
}

function backupDatabaseFile(reason = 'legacy') {
  if (!fs.existsSync(dbPath)) {
    return ''
  }

  const backupPath = `${dbPath}.${reason}-${Date.now()}.bak`
  fs.copyFileSync(dbPath, backupPath)
  return backupPath
}

function resetDatabaseFile() {
  closeDatabase(db)
  fs.rmSync(dbPath, { force: true })
  db = createDatabaseConnection()
}

function openDatabaseFromDisk() {
  try {
    return createDatabaseConnection()
  } catch {
    backupDatabaseFile('corrupt')
    fs.rmSync(dbPath, { force: true })
    return createDatabaseConnection()
  }
}

function normalizeIdentifier(value = '') {
  const text = String(value || '').trim()
  if (!/^[A-Za-z0-9_]+$/.test(text)) {
    throw new Error(`非法标识符：${value}`)
  }
  return text
}

function normalizeParams(params = []) {
  if (Array.isArray(params)) {
    return params
  }

  if (params && typeof params === 'object') {
    return params
  }

  if (typeof params === 'undefined') {
    return []
  }

  return [params]
}

function executeStatement(statement, method, params = []) {
  const normalized = normalizeParams(params)

  if (Array.isArray(normalized)) {
    return statement[method](...normalized)
  }

  return statement[method](normalized)
}

function tableExists(name) {
  return Boolean(
    get('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', String(name || '').trim()])
  )
}

function columnExists(tableName, columnName) {
  try {
    const normalizedTableName = normalizeIdentifier(tableName)
    return all(`PRAGMA table_info(${normalizedTableName})`).some((row) => row.name === columnName)
  } catch {
    return false
  }
}

function hasLegacySchema() {
  const hasLegacyDocumentsTable = tableExists('documents')
  const hasLegacyBlockColumn = tableExists('blocks') && !columnExists('blocks', 'task_id')
  const hasLegacyTaskColumns = tableExists('tasks') && !columnExists('tasks', 'auto_title')

  return hasLegacyDocumentsTable || hasLegacyBlockColumn || hasLegacyTaskColumns
}

function resetLegacyDatabaseIfNeeded() {
  if (!hasLegacySchema()) {
    return false
  }

  backupDatabaseFile('legacy')
  resetDatabaseFile()
  return true
}

function ensureSchemaMetaTable() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)
}

function readSchemaVersion() {
  ensureSchemaMetaTable()
  const row = get('SELECT value FROM schema_meta WHERE key = ?', ['schema_version'])
  return Math.max(0, Number(row?.value) || 0)
}

function writeSchemaVersion(version = 0) {
  ensureSchemaMetaTable()
  run(
    `INSERT INTO schema_meta (key, value)
     VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(Math.max(0, Number(version) || 0))]
  )
}

function migrateToV1() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      edit_token TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL DEFAULT '',
      auto_title TEXT NOT NULL DEFAULT '',
      last_prompt_preview TEXT NOT NULL DEFAULT '',
      todo_items_json TEXT NOT NULL DEFAULT '[]',
      codex_session_id TEXT NOT NULL DEFAULT '',
      automation_enabled INTEGER NOT NULL DEFAULT 0,
      automation_cron TEXT NOT NULL DEFAULT '',
      automation_timezone TEXT NOT NULL DEFAULT 'local',
      automation_concurrency_policy TEXT NOT NULL DEFAULT 'skip',
      automation_last_triggered_at TEXT NOT NULL DEFAULT '',
      automation_next_trigger_at TEXT NOT NULL DEFAULT '',
      notification_enabled INTEGER NOT NULL DEFAULT 0,
      notification_profile_id INTEGER,
      notification_channel_type TEXT NOT NULL DEFAULT 'dingtalk',
      notification_webhook_url TEXT NOT NULL DEFAULT '',
      notification_secret TEXT NOT NULL DEFAULT '',
      notification_trigger_on TEXT NOT NULL DEFAULT 'completed',
      notification_locale TEXT NOT NULL DEFAULT 'zh-CN',
      notification_message_mode TEXT NOT NULL DEFAULT 'summary',
      notification_last_status TEXT NOT NULL DEFAULT '',
      notification_last_error TEXT NOT NULL DEFAULT '',
      notification_last_sent_at TEXT NOT NULL DEFAULT '',
      visibility TEXT NOT NULL DEFAULT 'private',
      expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notification_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'dingtalk',
      webhook_url TEXT NOT NULL DEFAULT '',
      secret TEXT NOT NULL DEFAULT '',
      trigger_on TEXT NOT NULL DEFAULT 'completed',
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      message_mode TEXT NOT NULL DEFAULT 'summary',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(sort_order ASC, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_visibility ON tasks(visibility, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_notification_profile_id ON tasks(notification_profile_id);
    CREATE INDEX IF NOT EXISTS idx_blocks_task_sort ON blocks(task_id, sort_order ASC);
    CREATE INDEX IF NOT EXISTS idx_notification_profiles_user_id ON notification_profiles(user_id, updated_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_profiles_user_name ON notification_profiles(user_id, name);

    CREATE TABLE IF NOT EXISTS codex_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'codex',
      cwd TEXT NOT NULL,
      codex_thread_id TEXT,
      engine_session_id TEXT NOT NULL DEFAULT '',
      engine_thread_id TEXT NOT NULL DEFAULT '',
      engine_meta_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_codex_sessions_updated_at ON codex_sessions(updated_at DESC);

    CREATE TABLE IF NOT EXISTS codex_runs (
      id TEXT PRIMARY KEY,
      task_slug TEXT NOT NULL,
      session_id TEXT NOT NULL,
      engine TEXT NOT NULL DEFAULT 'codex',
      prompt TEXT NOT NULL DEFAULT '',
      prompt_blocks_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      response_message TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      FOREIGN KEY (task_slug) REFERENCES tasks(slug) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES codex_sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_codex_runs_task_slug_created_at ON codex_runs(task_slug, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_codex_runs_session_id_status ON codex_runs(session_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_codex_runs_status_created_at ON codex_runs(status, created_at DESC);

    CREATE TABLE IF NOT EXISTS codex_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL DEFAULT 'event',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES codex_runs(id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_codex_run_events_run_seq ON codex_run_events(run_id, seq);
    CREATE INDEX IF NOT EXISTS idx_codex_run_events_run_id_id ON codex_run_events(run_id, id ASC);

    CREATE TABLE IF NOT EXISTS task_git_baselines (
      task_slug TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      head_oid TEXT NOT NULL DEFAULT '',
      branch_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (task_slug) REFERENCES tasks(slug) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS task_git_baseline_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_slug TEXT NOT NULL,
      path TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (task_slug) REFERENCES task_git_baselines(task_slug) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_git_baseline_entries_scope_path
      ON task_git_baseline_entries(task_slug, path);

    CREATE TABLE IF NOT EXISTS run_git_baselines (
      run_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      head_oid TEXT NOT NULL DEFAULT '',
      branch_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES codex_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS run_git_baseline_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (run_id) REFERENCES run_git_baselines(run_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_git_baseline_entries_scope_path
      ON run_git_baseline_entries(run_id, path);

    CREATE TABLE IF NOT EXISTS run_git_final_snapshots (
      run_id TEXT PRIMARY KEY,
      repo_root TEXT NOT NULL,
      head_oid TEXT NOT NULL DEFAULT '',
      branch_label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES codex_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS run_git_final_snapshot_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      path TEXT NOT NULL,
      state_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (run_id) REFERENCES run_git_final_snapshots(run_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_git_final_snapshot_entries_scope_path
      ON run_git_final_snapshot_entries(run_id, path);
  `)
}

function migrateToV2() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'dingtalk',
      webhook_url TEXT NOT NULL DEFAULT '',
      secret TEXT NOT NULL DEFAULT '',
      trigger_on TEXT NOT NULL DEFAULT 'completed',
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      message_mode TEXT NOT NULL DEFAULT 'summary',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notification_profiles_user_id ON notification_profiles(user_id, updated_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_profiles_user_name ON notification_profiles(user_id, name);
  `)

  try {
    db.exec(`ALTER TABLE tasks ADD COLUMN notification_profile_id INTEGER`)
  } catch {
    // Column already exists.
  }

  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_notification_profile_id ON tasks(notification_profile_id)')
}

function applyAdditiveSchemaPatches() {
  const alterStatements = [
    `ALTER TABLE tasks ADD COLUMN auto_title TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN last_prompt_preview TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN todo_items_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE tasks ADD COLUMN codex_session_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN automation_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN automation_cron TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN automation_timezone TEXT NOT NULL DEFAULT 'local'`,
    `ALTER TABLE tasks ADD COLUMN automation_concurrency_policy TEXT NOT NULL DEFAULT 'skip'`,
    `ALTER TABLE tasks ADD COLUMN automation_last_triggered_at TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN automation_next_trigger_at TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN notification_enabled INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE tasks ADD COLUMN notification_profile_id INTEGER`,
    `ALTER TABLE tasks ADD COLUMN notification_channel_type TEXT NOT NULL DEFAULT 'dingtalk'`,
    `ALTER TABLE tasks ADD COLUMN notification_webhook_url TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN notification_secret TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN notification_trigger_on TEXT NOT NULL DEFAULT 'completed'`,
    `ALTER TABLE tasks ADD COLUMN notification_locale TEXT NOT NULL DEFAULT 'zh-CN'`,
    `ALTER TABLE tasks ADD COLUMN notification_message_mode TEXT NOT NULL DEFAULT 'summary'`,
    `ALTER TABLE tasks ADD COLUMN notification_last_status TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN notification_last_error TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE tasks ADD COLUMN notification_last_sent_at TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE codex_sessions ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex'`,
    `ALTER TABLE codex_sessions ADD COLUMN engine_session_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE codex_sessions ADD COLUMN engine_thread_id TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE codex_sessions ADD COLUMN engine_meta_json TEXT NOT NULL DEFAULT '{}'`,
    `UPDATE codex_sessions
     SET engine_thread_id = COALESCE(NULLIF(engine_thread_id, ''), COALESCE(codex_thread_id, ''))
     WHERE COALESCE(NULLIF(engine_thread_id, ''), '') = ''`,
    `ALTER TABLE codex_runs ADD COLUMN prompt_blocks_json TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE codex_runs ADD COLUMN engine TEXT NOT NULL DEFAULT 'codex'`,
    `UPDATE codex_runs
     SET engine = COALESCE(NULLIF(engine, ''), 'codex')
     WHERE COALESCE(NULLIF(engine, ''), '') = ''`,
    `ALTER TABLE task_git_baselines ADD COLUMN branch_label TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE run_git_baselines ADD COLUMN branch_label TEXT NOT NULL DEFAULT ''`,
    `ALTER TABLE codex_run_events ADD COLUMN event_type TEXT NOT NULL DEFAULT 'event'`,
    `ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE codex_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`,
  ]

  alterStatements.forEach((statement) => {
    try {
      db.exec(statement)
    } catch {
      // Column already exists.
    }
  })

  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_sort_order ON tasks(sort_order ASC, created_at DESC, id DESC)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_codex_session_id ON tasks(codex_session_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_notification_profile_id ON tasks(notification_profile_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_codex_sessions_user_id ON codex_sessions(user_id)')
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      channel_type TEXT NOT NULL DEFAULT 'dingtalk',
      webhook_url TEXT NOT NULL DEFAULT '',
      secret TEXT NOT NULL DEFAULT '',
      trigger_on TEXT NOT NULL DEFAULT 'completed',
      locale TEXT NOT NULL DEFAULT 'zh-CN',
      message_mode TEXT NOT NULL DEFAULT 'summary',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  db.exec('CREATE INDEX IF NOT EXISTS idx_notification_profiles_user_id ON notification_profiles(user_id, updated_at DESC, id DESC)')
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_profiles_user_name ON notification_profiles(user_id, name)')
  db.exec(`
    DELETE FROM blocks
    WHERE task_id NOT IN (SELECT id FROM tasks);
  `)

  normalizeTaskSortOrder()
}

function normalizeTaskSortOrder() {
  const rows = all(
    `SELECT id, sort_order, created_at
     FROM tasks
     ORDER BY sort_order ASC, created_at DESC, id DESC`
  )

  if (rows.length < 2) {
    return
  }

  const needsNormalization = rows.some((row, index) => Number(row.sort_order) !== index)
  if (!needsNormalization) {
    return
  }

  transaction(() => {
    rows.forEach((row, index) => {
      run('UPDATE tasks SET sort_order = ? WHERE id = ?', [index, Number(row.id)])
    })
  })
}

function ensureSchema() {
  resetLegacyDatabaseIfNeeded()
  const currentVersion = readSchemaVersion()

  if (currentVersion < 1) {
    migrateToV1()
    writeSchemaVersion(1)
  }

  if (readSchemaVersion() < 2) {
    migrateToV2()
    writeSchemaVersion(2)
  }

  applyAdditiveSchemaPatches()

  if (readSchemaVersion() < SCHEMA_VERSION) {
    writeSchemaVersion(SCHEMA_VERSION)
  }
}

ensureSchema()

export function persist() {
  return
}

export function all(sql, params = []) {
  const statement = db.prepare(sql)
  return executeStatement(statement, 'all', params)
}

export function get(sql, params = []) {
  const statement = db.prepare(sql)
  return executeStatement(statement, 'get', params) || null
}

export function run(sql, params = []) {
  const statement = db.prepare(sql)
  executeStatement(statement, 'run', params)
}

export function transaction(callback) {
  const isOuterTransaction = transactionDepth === 0

  if (isOuterTransaction) {
    db.exec('BEGIN')
  }

  transactionDepth += 1

  try {
    const result = callback()
    transactionDepth -= 1

    if (isOuterTransaction) {
      db.exec('COMMIT')
    }

    return result
  } catch (error) {
    transactionDepth -= 1

    if (isOuterTransaction) {
      db.exec('ROLLBACK')
    }

    throw error
  }
}

function getFileSizeBytes(targetPath = '') {
  try {
    return fs.statSync(targetPath).size
  } catch {
    return 0
  }
}

export function getDatabaseFileStats() {
  return {
    dbPath,
    walPath: dbWalPath,
    shmPath: dbShmPath,
    dbSizeBytes: getFileSizeBytes(dbPath),
    walSizeBytes: getFileSizeBytes(dbWalPath),
    shmSizeBytes: getFileSizeBytes(dbShmPath),
  }
}

export function runDatabaseMaintenance(options = {}) {
  if (transactionDepth > 0) {
    throw new Error('数据库维护不能在事务中执行。')
  }

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()
  const before = getDatabaseFileStats()
  const optimizeResult = db.pragma('optimize')
  const checkpointResult = db.pragma('wal_checkpoint(TRUNCATE)')
  const shouldVacuum = Boolean(options.vacuum)

  if (shouldVacuum) {
    db.exec('VACUUM')
  }

  const after = getDatabaseFileStats()
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedMs,
    vacuumed: shouldVacuum,
    optimizeResult,
    checkpointResult,
    before,
    after,
  }
}

export function closeDatabaseForTesting() {
  closeDatabase(db)
}

process.once('exit', () => {
  closeDatabase(db)
})
