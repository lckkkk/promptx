# Change: 隔离工作区 Diff 摘要慢请求

## Why

当前任务列表的工作区 Diff 摘要接口会在 Server 主线程中同步扫描工作目录并执行 Git 命令。遇到大工作区或多仓库目录时，请求可能持续数秒，期间会阻塞 Runner 状态上报链路，最终触发“Runner 已失联”的误判回收。

## What Changes

- 将任务列表使用的工作区 Diff 摘要计算迁移到子进程执行，避免阻塞 Server 主线程
- 为工作区仓库发现与摘要结果增加短时缓存，降低重复扫描和重复 Git 调用
- 为 `workspace-diff-summaries` 增加超时降级与失败兜底，慢请求不再影响正常运行链路

## Impact

- Affected specs: `workspace-git-diff`
- Affected code:
  - `apps/server/src/gitDiff.js`
  - `apps/server/src/gitDiffWorker.js`
  - `apps/server/src/gitDiffClient.js`
  - `apps/server/src/taskRoutes.js`
  - `apps/server/src/gitDiffClient.test.js`
  - `apps/server/src/taskRoutes.test.js`
