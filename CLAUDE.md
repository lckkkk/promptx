<!-- OPENSPEC:START -->
# OpenSpec Instructions

These instructions are for AI assistants working in this project.

Always open `@/openspec/AGENTS.md` when the request:
- Mentions planning or proposals (words like proposal, spec, change, plan)
- Introduces new capabilities, breaking changes, architecture shifts, or big performance/security work
- Sounds ambiguous and you need the authoritative spec before coding

Use `@/openspec/AGENTS.md` to learn:
- How to create and apply change proposals
- Spec format and conventions
- Project structure and guidelines

Keep this managed block so 'openspec update' can refresh the instructions.

<!-- OPENSPEC:END -->

# 项目执行约定

- 当前项目如需打包、安装并重启本地运行版本，统一执行：
  - `npm run local:update`
- “需要执行 local update”的判定规则：
  - 只要本次改动影响用户当前会在 PromptX 中直接看到或直接用到的行为，就在改动完成后执行 `npm run local:update`。
  - 典型场景包括：前端界面/交互改动、服务端接口或业务逻辑改动、CLI 行为改动、安装包内容改动、会影响本地运行结果的配置或脚本改动。
  - 不需要执行 `npm run local:update` 的场景：纯文档改动、纯测试改动、仅 OpenSpec / AGENTS / CLAUDE 之类说明文件改动、以及明确不会影响当前本地运行版本的开发辅助改动。
- 如果用户明确要求“执行 local update / 打包安装重启 / 用最新改动跑起来”，则无论改动类型如何，都执行 `npm run local:update`。
