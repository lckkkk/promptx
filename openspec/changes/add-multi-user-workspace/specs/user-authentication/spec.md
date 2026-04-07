# Capability: 用户认证

## ADDED Requirements

### Requirement: 支持多用户配置

系统应支持配置多个用户账号，每个用户有独立的用户名和密码。

#### Scenario: 管理员添加新用户

**Given** 管理员有权限访问配置文件
**When** 执行 `promptx user add alice` 并输入密码
**Then** `users-config.json` 中新增用户记录，密码存储为 bcrypt 哈希

#### Scenario: 用户列表查看

**Given** 配置文件中有 3 个用户
**When** 执行 `promptx user list`
**Then** 输出所有用户的 username 和 displayName（不包含密码哈希）

### Requirement: 用户名+密码登录

用户必须提供正确的用户名和密码才能登录系统。

#### Scenario: 登录成功

**Given** 用户 "alice" 的密码是 "secret123"
**When** 在登录页面输入用户名 "alice" 和密码 "secret123" 并提交
**Then** 系统验证通过，设置 Session Cookie，重定向到原页面

#### Scenario: 用户名不存在

**Given** 配置文件中没有用户 "bob"
**When** 输入用户名 "bob" 和任意密码并提交
**Then** 显示错误"用户不存在"，返回 401 状态码

#### Scenario: 密码错误

**Given** 用户 "alice" 的正确密码是 "secret123"
**When** 输入用户名 "alice" 和错误密码 "wrong" 并提交
**Then** 显示错误"密码不正确"，返回 401 状态码

### Requirement: Session 持久化

用户登录成功后，Session 应持久化到 Cookie 中，30 天内无需重新登录。

#### Scenario: Cookie 有效期

**Given** 用户在 4 月 1 日登录成功
**When** 在 4 月 15 日访问系统
**Then** Cookie 仍然有效，无需重新登录

#### Scenario: Cookie 过期

**Given** 用户在 3 月 1 日登录成功
**When** 在 4 月 5 日（超过 30 天）访问系统
**Then** Cookie 已过期，重定向到登录页

### Requirement: 默认用户向后兼容

系统首次启动时应创建 `default` 用户，密码为空，兼容单用户模式。

#### Scenario: 全新安装

**Given** `users-config.json` 不存在
**When** 首次启动 PromptX
**Then** 自动创建 `default` 用户，密码为空（无密码登录）

#### Scenario: 无密码登录

**Given** `default` 用户的 passwordHash 为空字符串
**When** 在登录页面输入用户名 "default"，密码留空并提交
**Then** 验证通过，成功登录

### Requirement: 登录限流

登录接口应限制失败尝试次数，防止暴力破解。

#### Scenario: 连续失败限流

**Given** 用户在 5 分钟内登录失败 10 次
**When** 第 11 次尝试登录
**Then** 返回 429 状态码，提示"尝试次数过多，请 X 分钟后再试"

#### Scenario: 成功登录清空限流

**Given** 用户之前失败 5 次
**When** 本次登录成功
**Then** 清空该用户的失败计数

## MODIFIED Requirements

无（此为新增 capability）

## REMOVED Requirements

无（此为新增 capability）
