# PromptX

PromptX 是一个面向需求整理与本机 AI 协作的轻量工作台。

当前这版已经不是早期的“临时文档页”形态，而是以 `workbench` 为核心：左侧管理任务，中间查看 Codex 会话过程，右侧整理并发送上下文。

## 当前定位

- 先把需求、截图、文本、PDF、禅道 Bug 等上下文整理成一个任务
- 再把这份任务发送给本机 Codex 持续多轮处理
- 在同一页里查看执行过程、回复、错误和中间事件

## 当前能力

- 工作台任务流：左侧任务列表、中间会话面板、右侧块编辑区
- 编辑区支持文本、图片、`md` / `txt` / `pdf`
- 任务内容自动保存，支持删除、清空、继续编辑
- 每个任务可绑定一个 PromptX Codex session
- 支持把当前任务发送到本机 Codex，并持续复用同一个线程多轮对话
- 实时查看 Codex 的执行过程、命令输出、待办变化和最终回复
- 仍保留公开页和 Raw 导出，方便共享上下文
- 禅道扩展支持一键提取 Bug 内容并打开工作台

## 重要限制

- 当前只支持对接 Codex，不支持 Claude、OpenAI API、Gemini 或其他模型后端
- 当前只支持 Codex 满血模式，不支持受限模式、轻量模式或降级模式
- 当前必须把 Codex 权限开到最大；如果权限不够，文件读写、命令执行和自动修改流程会频繁失败
- 因为当前要求 Codex 使用最大权限，开发环境默认仅允许本机访问，不建议开放到局域网
- 当前仍然是匿名本地工具，没有账号体系、协作权限或云端托管

如果你的 Codex 运行在受限权限下，PromptX 现在这版基本不在目标支持范围内。

## 安装

```bash
git clone https://github.com/bravf/promptx.git
cd promptx
pnpm install
```

## 启动

```bash
pnpm dev
```

默认会启动：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

出于安全考虑，当前默认只监听本机地址，不再开放局域网访问。

## 使用方式

### 方式 1：直接在工作台里整理并发送任务

1. 打开首页，进入 `workbench`
2. 新建任务，或从左侧选择已有任务
3. 在右侧编辑区录入文本、上传图片、导入文件
4. 在中间面板选择一个 PromptX Codex session
5. 点击发送，把当前任务内容交给 Codex
6. 在中间面板继续查看执行过程，并按需多轮发送

说明：

- 编辑区发送后会清空，按聊天输入框语义继续下一轮
- 中间面板保留本任务下的运行记录和 Codex 回复
- 如果没选 session 就发送，会提示先选择会话

### 方式 2：从禅道 Bug 一键进入工作台

仓库内置了禅道 Chrome 扩展：`apps/zentao-extension`

安装方法：

1. 打开 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `apps/zentao-extension`

使用方法：

1. 保持 `pnpm dev` 已启动
2. 打开禅道 Bug 详情页
3. 点击右下角 `AI修复`
4. 扩展会提取页面内容，创建 PromptX 任务，并直接打开工作台

## Codex 使用说明

PromptX 当前完全围绕本机 Codex 设计。

使用前请确认：

- 终端里可以正常运行 `codex --version`
- Codex 已开启最大权限
- Codex 运行在满血模式
- 本机存在可用的工作目录，供 PromptX session 绑定

当前会话机制：

- PromptX 会为任务绑定一个本机 Codex session
- 同一 session 后续发送会继续复用 Codex thread，而不是每次新开
- 你可以在中间面板查看这条线程的执行过程和最终回复

## 常用命令

```bash
pnpm dev
pnpm build
```

## 项目结构

```text
apps/
  web/                Web 前端
  server/             Fastify 后端
  zentao-extension/   禅道 Chrome 扩展
packages/
  shared/             前后端共享常量与工具
```

## 本地数据目录

本地运行时会生成这些目录：

- `data/`
- `uploads/`
- `tmp/`

这些都不应该提交到 Git。

## 备注

- 默认中文优先
- 当前更偏向个人 / 小团队的本机协作场景
- 更细的仓库约定见 `AGENTS.md`
