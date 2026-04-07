# 设计文档：多用户工作空间隔离

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│                   前端（Vue 3）                      │
│  • 登录页（username + password）                     │
│  • 任务列表（带项目筛选器）                          │
│  • 任务标题（项目名 - 任务名）                       │
└────────────┬──────────────────────────┬──────────────┘
             │ HTTP + Cookie            │
             ▼                          ▼
┌──────────────────────────┐  ┌────────────────────────┐
│   AuthMiddleware         │  │   API Routes           │
│  • 验证用户名+密码        │  │  • 从 request.user     │
│  • 设置 Session Cookie   │  │    读取当前用户        │
│  • 解密 Cookie → user    │  │  • 传递 userId 给      │
│  • 注入 request.user     │  │    Repository 层       │
└──────────┬───────────────┘  └────────┬───────────────┘
           │                           │
           └─────────────┬─────────────┘
                         │
                         ▼
           ┌──────────────────────────┐
           │   Repository 层          │
           │  • 所有查询添加          │
           │    WHERE user_id = ?     │
           │  • 创建数据时设置        │
           │    user_id = current     │
           └─────────┬────────────────┘
                     │
                     ▼
           ┌──────────────────────────┐
           │   SQLite Database        │
           │  • tasks.user_id         │
           │  • codex_sessions.user_id│
           │  • 索引 user_id 列       │
           └──────────────────────────┘

配置文件：
~/.promptx/data/users-config.json
{
  "users": [
    { "username": "alice", "passwordHash": "...", "displayName": "Alice" },
    { "username": "bob", "passwordHash": "...", "displayName": "Bob" }
  ]
}
```

## 核心组件设计

### 1. 用户配置（usersConfig.js）

```javascript
// 文件：apps/server/src/usersConfig.js

import fs from 'node:fs'
import path from 'node:path'
import bcrypt from 'bcryptjs'  // 需要添加依赖
import { ensurePromptxStorageReady } from './appPaths.js'

const USERS_CONFIG_FILE = 'users-config.json'
const DEFAULT_USER = {
  username: 'default',
  passwordHash: '',  // 空密码表示无密码登录
  displayName: '默认用户',
}

function getUsersConfigPath() {
  const { dataDir } = ensurePromptxStorageReady()
  return path.join(dataDir, USERS_CONFIG_FILE)
}

function normalizeUsersConfig(input = {}) {
  const users = Array.isArray(input?.users) ? input.users : [DEFAULT_USER]
  return {
    users: users.map(user => ({
      username: String(user?.username || '').trim(),
      passwordHash: String(user?.passwordHash || '').trim(),
      displayName: String(user?.displayName || user?.username || '').trim(),
    })).filter(user => user.username),
  }
}

function readUsersConfig() {
  const filePath = getUsersConfigPath()
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return normalizeUsersConfig(payload)
  } catch {
    // 首次启动，创建默认用户
    const defaultConfig = normalizeUsersConfig({ users: [DEFAULT_USER] })
    writeUsersConfig(defaultConfig)
    return defaultConfig
  }
}

function writeUsersConfig(config = {}) {
  const filePath = getUsersConfigPath()
  const normalized = normalizeUsersConfig(config)
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

async function validateUserCredentials(username, password) {
  const config = readUsersConfig()
  const user = config.users.find(u => u.username === username)

  if (!user) {
    return { valid: false, error: 'user_not_found' }
  }

  // 空 passwordHash 表示无密码登录（向后兼容）
  if (!user.passwordHash) {
    return { valid: true, user }
  }

  const match = await bcrypt.compare(password, user.passwordHash)
  if (!match) {
    return { valid: false, error: 'invalid_password' }
  }

  return { valid: true, user }
}

async function hashPassword(password) {
  return bcrypt.hash(password, 10)
}

export {
  getUsersConfigPath,
  normalizeUsersConfig,
  readUsersConfig,
  writeUsersConfig,
  validateUserCredentials,
  hashPassword,
}
```

### 2. 会话管理（authMiddleware.js 改造）

**新增功能：**
- 登录成功后设置加密 Cookie：`promptx_session=<encrypted-username>`
- 每次请求从 Cookie 解密出用户，存入 `request.user`

```javascript
// 新增函数

import crypto from 'node:crypto'

const SESSION_COOKIE_NAME = 'promptx_session'
const SESSION_SECRET = process.env.PROMPTX_SESSION_SECRET || 'default-secret-change-in-production'

function encryptUsername(username) {
  const cipher = crypto.createCipher('aes-256-cbc', SESSION_SECRET)
  let encrypted = cipher.update(username, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  return encrypted
}

function decryptUsername(encrypted) {
  try {
    const decipher = crypto.createDecipher('aes-256-cbc', SESSION_SECRET)
    let decrypted = decipher.update(encrypted, 'hex', 'utf8')
    decrypted += decipher.final('utf8')
    return decrypted
  } catch {
    return null
  }
}

function createSessionCookie(username) {
  const encrypted = encryptUsername(username)
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(encrypted)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
}

function parseSessionCookie(cookieHeader = '') {
  const cookies = parseCookieHeader(cookieHeader)
  const encrypted = cookies[SESSION_COOKIE_NAME]
  if (!encrypted) return null
  return decryptUsername(decodeURIComponent(encrypted))
}

// 修改 onRequest 钩子
app.addHook('onRequest', async (request, reply) => {
  // 解析当前用户
  const username = parseSessionCookie(request.headers.cookie)
  if (username) {
    request.user = { username }  // 注入用户信息
  }

  // 原有鉴权逻辑...
  if (isPublicPath(request)) return
  if (!username) {
    // 未登录，重定向或返回 401
    if (isHtmlRequest(request)) {
      return reply.redirect('/login')
    }
    return reply.code(401).send({ message: '请先登录。' })
  }
})

// 修改 POST /login
app.post('/login', async (request, reply) => {
  const form = parseUrlEncodedBody(request.body)
  const username = String(form.username || '').trim()
  const password = String(form.password || '').trim()

  // 限流检查...

  const result = await validateUserCredentials(username, password)
  if (!result.valid) {
    const errorMessages = {
      user_not_found: '用户不存在。',
      invalid_password: '密码不正确。',
    }
    return reply.code(401).type('text/html').send(buildServerLoginPage({
      errorMessage: errorMessages[result.error] || '登录失败。',
      redirectPath,
    }))
  }

  loginRateLimiter.clear(rateLimitKey)
  reply.header('Set-Cookie', createSessionCookie(username))
  return reply.redirect(redirectPath)
})
```

### 3. 数据库 Schema 迁移

**迁移逻辑（db.js）：**

```javascript
// 检测是否需要迁移
function needsUserIdMigration(db) {
  const tableInfo = db.prepare('PRAGMA table_info(tasks)').all()
  return !tableInfo.some(col => col.name === 'user_id')
}

function migrateToMultiUser(db) {
  if (!needsUserIdMigration(db)) return

  console.log('[db] 检测到单用户 Schema，开始迁移到多用户模式...')

  // 备份
  const backupDir = path.join(ensurePromptxStorageReady().dataDir, '..', 'backups')
  fs.mkdirSync(backupDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/:/g, '-')
  const backupPath = path.join(backupDir, `promptx-${timestamp}.sqlite`)
  fs.copyFileSync(dbPath, backupPath)
  console.log(`[db] 数据库已备份到 ${backupPath}`)

  // 迁移
  db.exec(`
    ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
    ALTER TABLE codex_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
    CREATE INDEX idx_tasks_user_id ON tasks(user_id);
    CREATE INDEX idx_codex_sessions_user_id ON codex_sessions(user_id);
  `)

  console.log('[db] 多用户迁移完成，所有现有数据已关联到 "default" 用户')
}

// 在 ensureSchema() 中调用
export function ensureSchema() {
  const db = getDatabase()

  // ... 现有 Schema 创建逻辑 ...

  // 迁移到多用户
  migrateToMultiUser(db)
}
```

### 4. Repository 层改造示例

```javascript
// repository.js 改造

// 原函数签名：
// export function listTasks(options = {})

// 新函数签名：
export function listTasks(userId, options = {}) {
  const query = `
    SELECT * FROM tasks
    WHERE user_id = ?
    ORDER BY sort_order ASC, created_at DESC
  `
  return db.prepare(query).all(userId)
}

export function createTask(userId, payload = {}) {
  const insert = `
    INSERT INTO tasks (slug, title, user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `
  // ...
  db.prepare(insert).run(slug, title, userId, now, now)
}

export function getTaskBySlug(userId, slug) {
  const query = `SELECT * FROM tasks WHERE slug = ? AND user_id = ?`
  return db.prepare(query).get(slug, userId)
}
```

### 5. 前端任务列表筛选（WorkbenchTaskListPanel.vue）

```vue
<template>
  <div class="task-list-panel">
    <!-- 项目筛选器 -->
    <div class="filter-bar">
      <select v-model="selectedProjectId" @change="handleProjectFilter">
        <option value="">全部项目</option>
        <option
          v-for="project in userProjects"
          :key="project.id"
          :value="project.id"
        >
          {{ project.title }}
        </option>
      </select>
    </div>

    <!-- 任务列表 -->
    <div v-for="task in filteredTasks" :key="task.slug">
      <div class="task-title">
        {{ getTaskDisplayTitle(task) }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const selectedProjectId = ref('')
const tasks = ref([])  // 从 API 获取
const codexSessions = ref([])  // 从 API 获取

const userProjects = computed(() => {
  return codexSessions.value.filter(s => tasks.value.some(t => t.codex_session_id === s.id))
})

const filteredTasks = computed(() => {
  if (!selectedProjectId.value) return tasks.value
  return tasks.value.filter(t => t.codex_session_id === selectedProjectId.value)
})

function getTaskDisplayTitle(task) {
  if (!task.codex_session_id) return task.title
  const project = codexSessions.value.find(s => s.id === task.codex_session_id)
  if (!project) return task.title
  return `${project.title} - ${task.title}`
}
</script>
```

## 安全考虑

### 1. 密码存储

- 使用 bcrypt（强度 10 rounds）
- 永不在日志或响应中返回 passwordHash
- 密码重置时重新生成哈希

### 2. Session 安全

- 使用 AES-256 加密用户名
- Session Secret 通过环境变量配置（`PROMPTX_SESSION_SECRET`）
- HttpOnly Cookie 防止 XSS 窃取
- SameSite=Lax 防止 CSRF

### 3. 数据隔离

- 所有查询强制过滤 `user_id`
- API 层从 `request.user` 读取，避免客户端伪造
- 测试覆盖跨用户数据泄露场景

## 向后兼容性

### 单用户模式保留

- 如果 `users-config.json` 只有一个用户且密码为空，表现为单用户模式
- 所有现有数据迁移到 `default` 用户
- 可选择是否为 `default` 用户设置密码

### 配置升级路径

```bash
# 现有用户（单 Token）
PROMPTX_ACCESS_TOKEN=xxx promptx start

# 升级后（多用户）
# 方式 1：保持单用户，为 default 用户设置密码
promptx user reset-password default

# 方式 2：添加新用户
promptx user add alice
promptx user add bob
```

## 性能影响

### 查询性能

- 添加 `user_id` 列和索引，对查询性能影响极小
- SQLite 在小数据量下（< 10 万行）性能优异
- 索引确保 `WHERE user_id = ?` 快速过滤

### 内存占用

- 无额外内存开销（不使用内存 Session Store）
- Cookie 解密开销可忽略

## 未来扩展

本设计为以下扩展预留空间：

- **用户角色**：在 `users-config.json` 中添加 `role` 字段
- **跨用户协作**：添加 `task_shares` 表，记录任务共享关系
- **用户配额**：限制每个用户的任务数、文件大小等
- **审计日志**：记录用户操作历史（创建、修改、删除）
