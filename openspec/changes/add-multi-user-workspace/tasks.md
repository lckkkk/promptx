# 实现任务清单

## 阶段 1：用户认证系统改造

- [ ] **1.1 用户配置管理**
  - 创建 `apps/server/src/usersConfig.js`
  - 定义用户配置 Schema（username, passwordHash, displayName）
  - 实现 `readUsersConfig()` / `writeUsersConfig()` / `validateUserCredentials(username, password)`
  - 使用 bcrypt 进行密码哈希验证
  - 验证：单元测试覆盖配置读写和密码验证

- [ ] **1.2 会话管理**
  - 在 `authMiddleware.js` 中实现 Session Cookie 加密/解密
  - 登录成功后设置 `promptx_session=<encrypted-username>` Cookie
  - `onRequest` 钩子中从 Cookie 解密出当前用户，存入 `request.user`
  - 验证：登录后 Cookie 正确设置，后续请求可读取用户身份

- [ ] **1.3 登录页面改造**
  - 修改 `authMiddleware.js` 的 `buildServerLoginPage()`，增加用户名输入框
  - POST `/login` 接受 `{ username, password }`，调用 `validateUserCredentials()`
  - 登录失败区分错误类型（用户不存在 / 密码错误 / 限流）
  - 验证：手动测试多个用户登录成功/失败场景

## 阶段 2：数据库 Schema 迁移

- [ ] **2.1 Schema 迁移脚本**
  - 在 `db.js` 的 `ensureSchema()` 中检测是否需要迁移（检查 `user_id` 列是否存在）
  - 执行 `ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`
  - 执行 `ALTER TABLE codex_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default'`
  - 创建索引：`CREATE INDEX idx_tasks_user_id`, `CREATE INDEX idx_codex_sessions_user_id`
  - 验证：测试数据库从旧 Schema 升级到新 Schema，数据保留完整

- [ ] **2.2 数据备份机制**
  - 在迁移前自动备份 `promptx.sqlite` 到 `~/.promptx/backups/promptx-{timestamp}.sqlite`
  - 迁移失败时输出清晰错误信息，提示备份文件位置
  - 验证：故意触发迁移失败，确认备份文件生成且可恢复

## 阶段 3：Repository 层隔离

- [ ] **3.1 修改 Repository 查询函数**
  - 所有 `listTasks()` / `getTaskBySlug()` / `createTask()` / `updateTask()` / `deleteTask()` 增加 `userId` 参数
  - SQL 查询中添加 `WHERE user_id = ?` 或 `INSERT` 时设置 `user_id`
  - 同样修改 `codex_sessions` 相关函数：`listPromptxCodexSessions()` / `createPromptxCodexSession()` 等
  - `codex_runs` 表通过 `task_slug` 或 `session_id` 间接关联用户，无需直接添加 `user_id` 列
  - 验证：单元测试覆盖用户 A 创建的任务，用户 B 无法查询到

- [ ] **3.2 级联查询修正**
  - 确保 `listTaskSlugsByCodexSessionId()` 等级联查询也遵循用户隔离
  - 检查所有涉及跨表查询的地方（JOIN），确保 `user_id` 正确传递
  - 验证：集成测试覆盖复杂查询场景

## 阶段 4：API 路由层改造

- [ ] **4.1 修改 `index.js` 和路由注册函数**
  - 在所有路由处理函数中，从 `request.user` 读取当前用户
  - 将 `user.username` 作为 `userId` 参数传递给 Repository 函数
  - 未登录时（`request.user` 为空）返回 401
  - 验证：手动测试各个 API 端点，确认用户隔离生效

- [ ] **4.2 Relay 客户端兼容性**
  - 确保 Relay 转发请求时，Cookie 正确传递
  - 远程访问时用户身份不丢失
  - 验证：通过 Relay 访问，多用户隔离仍然有效

## 阶段 5：前端 UI 适配

- [ ] **5.1 登录页面**
  - 修改 `buildServerLoginPage()`（已在阶段 1.3 完成）
  - 前端无需额外改动（服务端渲染 HTML）

- [ ] **5.2 任务列表项目筛选**
  - 在 `WorkbenchTaskListPanel.vue` 中添加项目筛选下拉框
  - 选项：「全部项目」+ 当前用户的所有项目（从 `codex_sessions` 中读取）
  - 筛选逻辑：前端过滤或后端 API 支持 `?projectId=xxx` 参数
  - 验证：选择项目后，列表只显示该项目的任务

- [ ] **5.3 任务标题格式调整**
  - 在任务列表渲染时，检查 `task.codex_session_id`
  - 如果已绑定项目，获取项目名称（从 `codexSessions` composable 中）
  - 显示格式：`<项目名> - <任务名>`，未绑定时仅显示任务名
  - 验证：手动检查各种场景（有项目、无项目、长标题）

## 阶段 6：配置与文档

- [ ] **6.1 默认用户预置**
  - 在首次启动时，如果 `users-config.json` 不存在，创建默认用户：
    ```json
    {
      "users": [
        {
          "username": "default",
          "passwordHash": "",
          "displayName": "默认用户"
        }
      ]
    }
    ```
  - 密码为空表示允许无密码登录（向后兼容单用户模式）
  - 验证：全新安装后可用 `default` 用户无密码登录

- [ ] **6.2 CLI 工具：用户管理**
  - 创建 `scripts/user-manager.mjs`
  - 支持命令：
    - `promptx user add <username>` — 交互式输入密码
    - `promptx user list` — 列出所有用户
    - `promptx user remove <username>` — 删除用户
    - `promptx user reset-password <username>` — 重置密码
  - 验证：手动测试各个命令

- [ ] **6.3 文档更新**
  - 更新 `README.md` 多用户配置章节
  - 说明如何添加用户、管理密码
  - 数据迁移注意事项
  - 验证：按文档操作可成功配置多用户

## 阶段 7：测试与验证

- [ ] **7.1 单元测试**
  - `usersConfig.test.js` — 用户配置读写、密码验证
  - `db.test.js` — Schema 迁移、用户隔离查询
  - `repository.test.js` — 各个查询函数的用户过滤逻辑

- [ ] **7.2 集成测试**
  - 测试完整登录流程：用户 A 登录 → 创建任务 → 用户 B 登录 → 看不到用户 A 的任务
  - 测试项目筛选功能
  - 测试数据迁移：旧数据库升级后，`default` 用户可访问所有旧数据

- [ ] **7.3 E2E 测试**
  - Playwright 测试多用户登录和任务创建
  - 验证任务列表筛选器

- [ ] **7.4 性能测试**
  - 对比迁移前后的查询性能
  - 确保添加索引后性能无明显下降

## 依赖关系

- 阶段 2（数据库迁移）依赖阶段 1（用户配置）— 需要知道默认用户
- 阶段 3（Repository 层）依赖阶段 2 — 需要 `user_id` 列存在
- 阶段 4（API 层）依赖阶段 3 — 需要 Repository 函数支持 `userId` 参数
- 阶段 5（前端）依赖阶段 4 — 需要 API 返回正确的用户隔离数据
- 阶段 6、7 可以在各阶段完成后并行进行

## 可并行工作

- 阶段 1.1 和 1.2 可以并行
- 阶段 3.1 和 3.2 可以并行
- 阶段 5.2 和 5.3 可以并行
- 阶段 6.1、6.2、6.3 可以并行
