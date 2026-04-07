# 提案：多用户工作空间隔离

## 概述

**Change ID**: `add-multi-user-workspace`
**状态**: 待审核
**创建日期**: 2026-04-07

### 问题陈述

当前 PromptX 仅支持单用户使用，所有任务和项目在一个全局空间中。当多个用户需要使用同一个 PromptX 实例时，他们会看到彼此的所有任务和项目，没有数据隔离和权限控制。

### 目标

改造 PromptX 为多用户系统，实现：

1. **用户名+密码登录** — 替换当前的单一 Token 认证，支持配置多个用户账号
2. **工作空间隔离** — 每个用户只能看到和操作自己的任务、项目、会话和运行记录
3. **项目筛选** — 任务列表支持按项目筛选
4. **任务标题展示优化** — 列表中显示「项目名 - 任务名」格式

### 范围

**包含：**
- 用户认证系统（用户名+密码）
- 数据库 Schema 迁移（添加 user_id 关联）
- API 层权限控制（基于当前用户过滤���据）
- 前端 UI 适配（项目筛选器、标题格式调整）
- 用户配置管理（支持添加/删除用户）

**不包含：**
- 用户自助注册功能（管理员通过配置文件添加用户）
- 用户角色和细粒度权限（所有用户权限平等）
- 跨用户协作功能（任务/项目共享）
- 用户个人资料编辑（头像、昵称等）

### 影响范围

**后端：**
- `authConfig.js` / `authMiddleware.js` — 认证逻辑改造
- `db.js` — 数据库 Schema 迁移
- `repository.js` — 查询函数添加 user_id 过滤
- 所有路由处理函数 — 从会话中读取当前用户

**前端：**
- 登录页面 — 增加用户名输入框
- 任务列表 — 添加项目筛选器，调整标题显示格式
- API 调用 — 所有请求自动携带用户身份（Cookie/Session）

**数据库：**
- `tasks` / `codex_sessions` / `codex_runs` 表 — 添加 `user_id` 列
- 数据迁移逻辑 — 将现有数据关联到默认用户

### 非目标

- 本提案不实现团队权限管理（组长、成员等角色）
- 不支持 OAuth/SSO 第三方登录
- 不实现用户间的任务/项目共享或协作

## 动机

当前 PromptX 被多人共同使用时存在以下问题：

1. **隐私问题** — 所有用户的任务、提示词、上传文件对所有人可见
2. **混乱的工作空间** — 无法区分任务属于谁，导致误操作
3. **无法多租户部署** — 企业/团队无法为不同成员提供独立的工作环境

实现多用户隔离后，PromptX 可以：
- 作为团队工具部署在内网服务器上
- 多个开发者共享同一个 PromptX 实例但数据完全隔离
- 管理员集中管理用户账号，无需每人单独部署

## 设计决策

### 1. 用户存储方式

**选择：配置文件 + 数据库混合模式**

- 用户账号定义在 `~/.promptx/data/users-config.json` 中
- 包含：username、passwordHash（bcrypt）、displayName
- 不存储在数据库中，避免迁移复杂性
- 用户登录后，`user_id` (username) 存储在会话中

**替代方案（已拒绝）：**
- ~~纯数据库存储用户~~ — 需要用户管理 CRUD 接口，增加复杂度
- ~~继续使用单一 Token~~ — 无法区分用户身份

### 2. 会话管理

**选择：基于 Cookie 的 Session**

- 登录成功后设置 HttpOnly Cookie，包含加密的用户名
- Cookie 内容：`promptx_session=<encrypted-username>`
- 有效期 30 天
- 每次请求从 Cookie 中解密出当前用户

**替代方案（已拒绝）：**
- ~~JWT Token~~ — 过度设计，Cookie Session 已足够
- ~~内存 Session Store~~ — 重启后用户需重新登录，体验不佳

### 3. 数据隔离策略

**选择：在查询��过滤（Repository 层）**

- 所有 `list*` / `get*` 函数增加 `user_id` 参数
- 在 SQL 查询中添加 `WHERE user_id = ?`
- API 路由从 request 中获取当前用户，传递给 Repository

**数据库 Schema 改动：**
```sql
ALTER TABLE tasks ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE codex_sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'default';
CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_codex_sessions_user_id ON codex_sessions(user_id);
```

**迁移策略：**
- 现有数据 `user_id` 设为 `'default'`
- 配置文件中预置 `default` 用户，密码为空（可选配置密码）

### 4. 前端适配

**登录页：**
- 增加用户名输入框
- 表单提交：`{ username, password }`
- 登录失败显示具体错误（用户不存在 / 密码错误）

**任务列表：**
- 顶部新增项目筛选下拉框（All / Project A / Project B...）
- 任务卡片标题格式：`<项目名> - <任务名>`（未绑定项目时仅显示任务名）
- 筛选器默认选中"全部项目"

## 风险与缓解

### 风险 1：现有数据迁移失败

**风险**：用户升级后，现有任务/项目丢失或无法访问

**缓解措施：**
- 数据库迁移脚本在启动时自动执行
- 迁移前自动备份数据库文件到 `~/.promptx/backups/`
- 迁移失败时回滚到备份并抛出明确错误提示

### 风险 2：性能下降

**风险**：每次查询都增加 `user_id` 过滤，可能影响性能

**缓解措施：**
- 在 `user_id` 列上创建索引
- 现有查询已经很快（SQLite + 索引），多一个 WHERE 条件影响可忽略
- 如果有性能问题，后续可优化为用户级数据库分片

### 风险 3：用户忘记密码

**风险**：没有密码重置功能，用户忘记密码无法登录

**缓解措施：**
- 管理员可直接编辑 `users-config.json` 重置密码（提供 CLI 工具）
- 文档中明确说明密码重置方式
- 后续可考虑增加密码重置 API（需要邮箱验证或管理员审批）

## 成功指标

- [ ] 可以配置多个用户（至少 2 个）并分别登录
- [ ] 用户 A 看不到用户 B 的任务和项目
- [ ] 任务列表支持按项目筛选
- [ ] 任务标题显示为「项目名 - 任务名」格式
- [ ] 现有单用户数据迁移后可被 `default` 用户访问
- [ ] 所有现有功能（任务创建、运行、Diff、Relay）正常工作

## 参考

- 现有鉴权实现：`apps/server/src/authConfig.js`、`apps/server/src/authMiddleware.js`
- 数据库层：`apps/server/src/db.js`、`apps/server/src/repository.js`
- Relay 的多租户实现：`apps/server/src/relayServer.js`（租户隔离机制可参考）
