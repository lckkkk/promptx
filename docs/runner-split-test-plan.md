# Runner Split 自动化测试计划

本文档覆盖 runner 拆分后的功能、性能与稳定性验证，目标是确认：

- `apps/server` 在高负载下仍可稳定响应控制面 API 与 SSE。
- `apps/runner` 能独立承载长任务、停止流程、异常回收与重启恢复。
- 长时间运行下不存在明显的卡死、堆积或内存失控。

## 测试矩阵

| 类别 | 脚本 | 关注点 |
| --- | --- | --- |
| 真实全链路 | `pnpm e2e:real-agents` | 真实调用本机 `codex` / `opencode`，覆盖新建任务、项目、发送真实提示词、事件流、线程复用 |
| 真实 stop | `pnpm e2e:real-stop` | 真实调用本机 `codex` / `opencode`，覆盖长任务启动、stop、子进程回收、SSE stop 通知 |
| 冒烟 | `pnpm smoke:runner-split` | 基础启动、运行、停止、runner 崩溃回收 |
| 控制面压测 | `pnpm load:control-plane` | 长任务并发时 `/api/tasks`、`/api/codex/sessions`、run 列表接口延迟 |
| 停止风暴 | `pnpm load:stop-storm` | 批量 stop 的确认延迟、最终收敛状态 |
| SSE 扇出 | `pnpm load:sse-fanout` | 多客户端订阅稳定性、事件扇出、SSE 下控制面响应 |
| Chaos | `pnpm chaos:runner-kill` | runner 进程丢失后的回收速度、server 存活性 |
| Soak | `pnpm soak:runner-split` | 长时混合负载、随机 stop、runner 重启、RSS 趋势、无卡死 |
| 一键摸底 | `pnpm perf:runner-split` | 串行执行 smoke + 控制面 + SSE + stop storm + chaos + soak，输出一份汇总结果 |
| 本机巡检 | `pnpm local:runner-check` | 本机串行执行单测 + 真实 stop + 默认档性能摸底，适合作为本机 CI 替代 |
| 本机夜巡 | `pnpm local:runner-check:nightly` | 本机串行执行单测 + 真实 agent + 真实 stop + nightly 档性能摸底 |

## 推荐执行顺序

```bash
pnpm e2e:real-agents
pnpm e2e:real-stop
pnpm smoke:runner-split
pnpm load:control-plane
pnpm load:sse-fanout
pnpm load:stop-storm
pnpm chaos:runner-kill
pnpm soak:runner-split
pnpm perf:runner-split
pnpm local:runner-check
pnpm local:runner-check:nightly
```

## 关键阈值

默认脚本内置以下阈值，超出会直接返回非零退出码：

- 真实全链路：
  - 必须成功创建真实任务、真实 PromptX 项目、真实 run
  - 必须通过真实 CLI 完成两轮 prompt
  - 第一轮与第二轮都要有持久化事件
  - 第二轮必须复用同一线程 / session 标识
  - 只读测试期间工作目录内容不能被改写
  - 开启 SSE 校验时，不允许流意外断开
- 真实 stop：
  - 必须成功启动真实长任务
  - stop 接口返回后 run 必须落到 `stopped`
  - 长任务子进程 PID 必须被回收
  - 持久化事件中必须出现 `stopped`
  - 开启 SSE 校验时，必须能收到 stop 相关的 `runs.changed` / `run.event`

- 控制面压测：
  - `/api/tasks` p95 <= 300ms
  - `/api/codex/sessions` p95 <= 300ms
  - `/api/tasks/:slug/codex-runs` p95 <= 500ms
- SSE 扇出：
  - 所有 SSE 客户端都必须成功 ready
  - 默认不允许意外断连
  - 首条业务事件 p95 <= 1500ms
  - 每个客户端至少收到 20 条非 ready 事件
- 停止风暴：
  - stop ack p95 <= 1000ms
  - stop 完成 p95 <= 12000ms
  - 默认 `stop_timeout` 占比 <= 0
- Chaos：
  - `/api/tasks` p95 <= 400ms
  - runner 丢失后回收 p95 <= 12000ms
- Soak：
  - `/api/tasks` p95 <= 500ms
  - `/api/codex/sessions` p95 <= 500ms
  - run 列表 p95 <= 700ms
  - stop ack p95 <= 1200ms
  - 结束时 `stuckActiveRuns` 必须为 0
  - 默认允许 `stop_timeout` 比例 <= 10%

## 压测参数

所有脚本都支持环境变量覆盖。常用示例：

```bash
PROMPTX_SSE_CLIENTS=100 pnpm load:sse-fanout
PROMPTX_STOP_STORM_RUNS=30 pnpm load:stop-storm
PROMPTX_CHAOS_RUNS=16 pnpm chaos:runner-kill
PROMPTX_REAL_ENGINES=codex,opencode pnpm e2e:real-agents
PROMPTX_REAL_ENGINES=codex,opencode pnpm e2e:real-stop
PROMPTX_SOAK_DURATION_MS=1800000 PROMPTX_SOAK_MAX_ACTIVE_RUNS=16 pnpm soak:runner-split
PROMPTX_PERF_PROFILE=nightly pnpm perf:runner-split
pnpm local:runner-check
pnpm local:runner-check:nightly
```

### SSE 扇出

- `PROMPTX_SSE_CLIENTS`：SSE 客户端数，默认 `40`
- `PROMPTX_SSE_RUNS`：后台长任务数，默认 `10`
- `PROMPTX_SSE_DURATION_MS`：压测时长，默认 `10000`
- `PROMPTX_SSE_MIN_EVENTS_PER_CLIENT`：每客户端最少事件数，默认 `20`

### 真实全链路

- `PROMPTX_REAL_ENGINES`：要测试的真实引擎，逗号分隔，默认自动探测已安装引擎
- `PROMPTX_REAL_RUN_TIMEOUT_MS`：单次真实 run 超时，默认 `240000`
- `PROMPTX_REAL_VERIFY_SSE`：是否校验 SSE 流，默认 `1`

### 真实 stop

- `PROMPTX_REAL_STOP_START_TIMEOUT_MS`：等待真实长任务启动的超时，默认 `120000`
- `PROMPTX_REAL_STOP_FINAL_TIMEOUT_MS`：stop 后等待终态的超时，默认 `30000`
- `PROMPTX_REAL_STOP_FORCE_AFTER_MS`：传给 stop 接口的强杀宽限，默认 `1500`
- `PROMPTX_REAL_STOP_PID_EXIT_TIMEOUT_MS`：等待长任务 PID 回收的超时，默认 `10000`

### Soak

- `PROMPTX_SOAK_DURATION_MS`：Soak 时长，默认 `300000`
- `PROMPTX_SOAK_MAX_ACTIVE_RUNS`：最大活跃 run 数，默认 `10`
- `PROMPTX_SOAK_CREATE_INTERVAL_MS`：新建 run 的最小间隔，默认 `1200`
- `PROMPTX_SOAK_STOP_PROBABILITY`：每轮随机 stop 概率，默认 `0.35`
- `PROMPTX_SOAK_RESTART_RUNNER`：是否执行 runner 重启演练，默认 `1`
- `PROMPTX_SOAK_KILL_AT_MS`：runner 重启触发时刻，默认总时长一半

### 一键摸底

- `PROMPTX_PERF_PROFILE`：压测档位，支持 `default` / `nightly`
- `PROMPTX_PERF_REPORT_PATH`：可选，把汇总 JSON 额外写到指定路径

默认 `default` 档位更适合白天快速摸底；`nightly` 会把 SSE、控制面和 soak 强度再往上推一档，适合夜间长跑。

### 本机巡检

- `pnpm local:runner-check`：快速本机巡检，默认执行：
  - `pnpm --filter @promptx/server test`
  - `pnpm e2e:real-stop`
  - `pnpm perf:runner-split`
- `pnpm local:runner-check:nightly`：夜间本机巡检，默认执行：
  - `pnpm --filter @promptx/server test`
  - `pnpm e2e:real-agents`
  - `pnpm e2e:real-stop`
  - `PROMPTX_PERF_PROFILE=nightly pnpm perf:runner-split`
- 报告默认写到 `apps/server/tmp/runner-checks/<timestamp>-<profile>`
- 也可以用 `PROMPTX_LOCAL_CHECK_REPORT_DIR` 或 `--report-dir` 指定输出目录

### Windows 定时任务

- 安装夜间巡检任务：

```bash
pnpm local:runner-check:task:install
```

- 删除夜间巡检任务：

```bash
pnpm local:runner-check:task:remove
```

- 如需自定义时间或任务名，可直接运行：

```bash
node scripts/local-runner-check-task.mjs install --profile nightly --time 02:30 --task-name "PromptX Runner Check Nightly"
```

## 验收建议

建议至少保留两组基线结果：

1. 开发机默认参数结果：用于快速回归。
2. 高压参数结果：例如 `100` SSE 客户端、`16` 活跃 run、`30min` soak，用于夜间验收。

若 soak 期间出现异常，优先检查：

- server/runner 标准输出末尾日志
- `stuckActiveRuns` 是否大于 0
- `terminalCounts.error` 或 `terminalCounts.stop_timeout` 是否异常放大
- RSS 是否持续单向增长且在 runner 重启后不回落
