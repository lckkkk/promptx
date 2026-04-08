## ADDED Requirements

### Requirement: 工作目录选择器支持新建目录

系统 SHALL 允许用户在新建项目选择工作目录时直接创建新目录。

#### Scenario: 在当前目录下新建子目录

**Given** 用户正在目录选择器中浏览 `/Users/me/projects`
**When** 输入新目录名并执行创建
**Then** 系统在 `/Users/me/projects` 下创建对应子目录
**And** 创建成功后可立即选中该目录

#### Scenario: 目录名非法

**Given** 用户输入非法目录名或越界路径
**When** 执行创建目录
**Then** 系统拒绝创建
**And** 显示明确错误提示

#### Scenario: 目录已存在

**Given** 目标目录已经存在
**When** 用户再次尝试创建同名目录
**Then** 系统提示目录已存在
**And** 不重复创建
