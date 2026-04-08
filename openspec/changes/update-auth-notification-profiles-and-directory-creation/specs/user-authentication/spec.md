## MODIFIED Requirements

### Requirement: 用户名+密码登录

系统 MUST 要求用户提供已配置账号的正确用户名和密码才能登录系统。

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

### Requirement: 默认用户向后兼容

系统 SHALL 不再允许 `default` 空密码用户作为正式登录方式。

#### Scenario: 首次启动无账号

**Given** 用户配置文件不存在或没有任何可用账号
**When** 管理员首次启动 PromptX
**Then** 系统提示必须先创建账号
**And** 不允许直接使用 `default` 空密码登录

#### Scenario: default 空密码登录被拒绝

**Given** 系统中存在 `default` 用户且密码为空
**When** 在登录页面输入用户名 "default"，密码留空并提交
**Then** 登录被拒绝
**And** 系统提示必须使用已配置账户密码登录
