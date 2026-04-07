# Capability: 用户工作空间隔离

## ADDED Requirements

### Requirement: 任务按用户隔离

每个用户只能看到和操作自己创建的任务，无法访问其他用户的任务。

#### Scenario: 用户 A 看不到用户 B 的任务

**Given** 用�� B 创建了 3 个任务
**When** 用户 A 登录后访问任务列表
**Then** 任务列表为空，不显示用户 B 的任务

#### Scenario: 用户创建任务自动关联

**Given** 用户 A 已登录
**When** 用户 A 创建一个新任务
**Then** 任务的 `user_id` 字段自动设置为 `A`

#### Scenario: 跨用户访问禁止

**Given** 用户 B 创建了任务 slug 为 `task-123`
**When** 用户 A 尝试访问 `GET /api/tasks/task-123`
**Then** 返回 404（而非 403，避免泄露任务存在性）

### Requirement: 项目（会话）按用户隔离

每个用户只能看到和使用自己创建的项目（Codex Session）。

#### Scenario: 项目列表隔离

**Given** 用户 A 有 2 个项目，用户 B 有 3 个项目
**When** 用户 A 访问项目列表 `GET /api/codex/sessions`
**Then** 返回 2 个项目，不包含用户 B 的项目

#### Scenario: 任务绑定项目校验

**Given** 项目 `project-456` 属于用户 B
**When** 用户 A 尝试将任务绑定到 `project-456`
**Then** 返回 400 错误"项目不存在或无权限"

### Requirement: 运行记录按用户间接隔离

运行记录通过 `task_slug` 或 `session_id` 间接关联用户，无需直接添加 `user_id` 列。

#### Scenario: 运行记录查询隔离

**Given** 任务 `task-789` 属于用户 A
**When** 用户 B 尝试访问 `GET /api/tasks/task-789/run/run-001`
**Then** 返回 404（因为用户 B 看不到 `task-789`）

### Requirement: 数据库迁移保留现有数据

从单用户模式升级到多用户时，现有数据应关联到 `default` 用户。

#### Scenario: 迁移前数据保留

**Given** 数据库中有 10 个任务和 5 个项目（旧 Schema）
**When** 系统启动并执行 Schema 迁移
**Then** 所有任务和项目的 `user_id` 设置为 `'default'`，数据完整保留

#### Scenario: 迁移后 default 用户可访问

**Given** 迁移完成，所有旧数据 `user_id='default'`
**When** `default` 用户登录后访问任务列表
**Then** 看到所有 10 个旧任务

### Requirement: 数据库备份机制

Schema 迁移前应自动备份数据库，防止迁移失败导致数据丢失。

#### Scenario: 迁移前自动备份

**Given** 数据库文件路径为 `~/.promptx/data/promptx.sqlite`
**When** 检测到需要执行 Schema 迁移
**Then** 在 `~/.promptx/backups/` 目录生成带时间戳的备份文件

#### Scenario: 迁移失败提示

**Given** 迁移过程中出现 SQL 错误
**When** 捕获异常
**Then** 输出清晰错误信息，提示备份文件位置，进程退出

## MODIFIED Requirements

### Requirement: Repository 层查询函数签名变更

所有 Repository 层的查询和操作函数增加 `userId` 参数。

#### Scenario: listTasks 函数变更

**Given** 原函数签名为 `listTasks(options)`
**When** 改造为多用户模式
**Then** 新签名为 `listTasks(userId, options)`，SQL 查询中添加 `WHERE user_id = ?`

#### Scenario: createTask 函数变更

**Given** 原函数签名为 `createTask(payload)`
**When** 改造为多用户模式
**Then** 新签名为 `createTask(userId, payload)`，INSERT 时设置 `user_id = userId`

## REMOVED Requirements

无
