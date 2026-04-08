## Context

当前 `workspace` 级代码变更通过 `session.cwd -> git rev-parse --show-toplevel` 解析为单一 repo root，再基于这个 root 计算工作区状态。这个模型不适用于 monorepo 目录下嵌套多个独立 Git 仓库的场景。

## Goals / Non-Goals

- Goals:
  - 让用户在一个项目工作目录下，看到所有相关子 Git 仓库的改动
  - 保持现有 `workspace / task / run` 三种 diff scope 的主心智不变
  - 在 UI 中明确文件属于哪个仓库，避免同名文件混淆
- Non-Goals:
  - 不支持跨任意磁盘路径聚合 Git 仓库
  - 不改动任务运行时的 Git baseline 捕获模型，优先保证 `workspace` scope 可见性
  - 不引入新的数据库表

## Decisions

- Decision: `workspace` scope 应基于 `session.cwd` 向下扫描，聚合当前工作目录本身以及其子目录中的 Git 仓库
  - Why: 用户的诉求就是“工作目录下有多个子项目仓库”，向下聚合符合直觉，也不会误把兄弟目录仓库带进来

- Decision: 聚合结果中的每个文件都带 `repoRoot` 和 `repoLabel`
  - Why: 前端需要稳定显示“这个文件属于哪个仓库”

- Decision: 任务列表中的 `workspaceDiffSummary` 聚合所有纳入仓库的统计值
  - Why: 首页只需要给出整体变化规模，不需要展开到仓库粒度

- Decision: Diff 详情面板优先在文件项中展示仓库标签，而不是先做复杂的仓库分组视图
  - Why: 这是最小可落地的交互改动，风险低，兼容现有文件列表和 patch 视图

## Risks / Trade-offs

- 工作目录较大时，扫描子仓库可能增加 `workspace` diff 的计算开销
  - Mitigation: 仅扫描 Git 仓库标记目录，增加缓存，并限制递归范围/跳过常见无关目录

- 多仓库聚合后，`workspace` 摘要与 `task/run` 基线 diff 语义可能产生差异
  - Mitigation: 本次只保证 `workspace` scope 聚合；`task/run` 如仍基于当前项目主仓库，需要在 UI 文案中保持 scope 语义清晰

## Migration Plan

1. 新增“工作目录下 Git 仓库发现”能力
2. 将 `workspace` 摘要与详情切到多仓库聚合
3. 前端文件列表补仓库标签
4. 增加测试并验证大部分旧场景不回归

## Open Questions

- `task` 和 `run` scope 是否也需要扩展到多仓库 baseline？本次先不纳入，后续可单独提 change

