import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  clearTaskCodexRuns,
  createCodexSession,
  createTaskCodexRun,
  deleteCodexSession,
  listCodexRunEvents,
  listCodexSessions,
  listCodexWorkspaces,
  listTaskCodexRuns,
  resolveAssetUrl,
  stopCodexRun,
  updateCodexSession,
} from '../lib/api.js'
import {
  subscribeTaskRunEvents,
  useWorkbenchRealtime,
} from './useWorkbenchRealtime.js'
import { getAgentEngineLabel, normalizeAgentEngine } from '../lib/agentEngines.js'

const SESSION_REFRESH_TTL = 1500
const WORKSPACE_REFRESH_TTL = 30000
const SERVER_SYNC_DELAY = 150
const AUTO_SCROLL_THRESHOLD = 48
const FALLBACK_RUN_POLL_INTERVAL_MS = 1800
const FALLBACK_SESSION_POLL_INTERVAL_MS = 7200

function getDateOrderValue(value = '') {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function sortSessions(items = [], currentSessionId = '') {
  return [...items].sort((left, right) => {
    const runningDiff = Number(Boolean(right?.running)) - Number(Boolean(left?.running))
    if (runningDiff) {
      return runningDiff
    }

    const currentDiff = Number(right?.id === currentSessionId) - Number(left?.id === currentSessionId)
    if (currentDiff) {
      return currentDiff
    }

    const updatedDiff = getDateOrderValue(right.updatedAt) - getDateOrderValue(left.updatedAt)
    if (updatedDiff) {
      return updatedDiff
    }

    return String(left.title || left.cwd || left.id).localeCompare(String(right.title || right.cwd || right.id), 'zh-CN')
  })
}

function formatCommandOutput(output = '', limit = 500) {
  const text = String(output || '').trim()
  if (!text) {
    return ''
  }
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}...`
}

function formatTodoItems(items = []) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) {
    return ''
  }

  return list
    .map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text || '未命名任务'}`)
    .join('\n')
}

function formatCount(value = 0) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) {
    return '0'
  }
  return number.toLocaleString('zh-CN')
}

export function formatElapsedDuration(value = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0))
  if (totalSeconds < 66) {
    return `${totalSeconds}s`
  }

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}小时${minutes}分${seconds}秒`
  }

  return `${minutes}分${seconds}秒`
}

function summarizeText(value = '', limit = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return ''
  }
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}...`
}

function formatMultilineList(prefix = '', items = []) {
  const list = items.filter(Boolean)
  if (!list.length) {
    return ''
  }

  const body = list.map((item) => `- ${item}`).join('\n')
  return prefix ? `${prefix}\n${body}` : body
}

function createTurnSummaryState() {
  return {
    commandCount: 0,
    webSearchCount: 0,
    fileChangeCount: 0,
    subAgentCount: 0,
    waitingAgentCount: 0,
    currentActivity: '',
    latestActivity: '',
    latestDetail: '',
  }
}

function findTurnByRunId(turnList = [], runId = '') {
  const normalizedRunId = String(runId || '').trim()
  if (!normalizedRunId) {
    return null
  }

  return (Array.isArray(turnList) ? turnList : []).find((turn) => turn?.runId === normalizedRunId) || null
}

export function applyRunEventsPayloadToTurns(turnList, runId, payload, nextLogId, mergeSession) {
  const activeTurn = findTurnByRunId(turnList, runId)
  if (!activeTurn) {
    return null
  }

  activeTurn.events = []
  activeTurn.lastEventSeq = 0
  activeTurn.summary = createTurnSummaryState()

  ;(payload?.items || []).forEach((event) => {
    applyRunEventToTurn(activeTurn, event, nextLogId, mergeSession)
  })

  activeTurn.eventCount = Math.max(
    Math.max(0, Number(activeTurn.eventCount) || 0),
    Array.isArray(payload?.items) ? payload.items.length : 0,
    Math.max(0, Number(activeTurn.lastEventSeq) || 0)
  )
  activeTurn.eventsLoaded = true
  activeTurn.eventsLoading = false
  return activeTurn
}

export function getTurnAgentEngine(turn = {}) {
  return normalizeAgentEngine(turn?.engine)
}

export function getTurnAgentLabel(turn = {}) {
  return getAgentEngineLabel(getTurnAgentEngine(turn))
}

function getAgentCliCommand(engine = 'codex') {
  return normalizeAgentEngine(engine) === 'claude-code'
    ? 'claude --version'
    : 'codex --version'
}

function getAgentFailureText(engine = 'codex') {
  return `${getAgentEngineLabel(engine)} 执行失败`
}

function parseCodexRetryMessage(message = '') {
  const text = String(message || '').trim()
  if (!text) {
    return null
  }

  const matched = text.match(/^Reconnecting\.\.\.\s*(\d+)\/(\d+)\s*\(([\s\S]+)\)$/i)
  if (!matched) {
    return null
  }

  return {
    attempt: Number(matched[1] || 0),
    total: Number(matched[2] || 0),
    reason: String(matched[3] || '').trim(),
    rawMessage: text,
  }
}

function formatWebSearchEvent(item = {}, phase = 'completed') {
  const action = item.action || {}
  const actionType = String(action.type || '').trim()
  const query = String(item.query || action.query || '').trim()
  const queries = Array.isArray(action.queries) ? action.queries.map((entry) => String(entry || '').trim()).filter(Boolean) : []
  const url = String(action.url || query || '').trim()

  if (actionType === 'search') {
    const title = phase === 'started' ? '正在搜索网页' : '已搜索网页'
    return {
      kind: 'command',
      title,
      detail: formatMultilineList(
        query ? `关键词：${query}` : '',
        queries.length > 1 ? queries : []
      ),
    }
  }

  if (actionType === 'open_page') {
    return {
      kind: 'command',
      title: phase === 'started' ? '正在打开网页' : '已打开网页',
      detail: url,
    }
  }

  return {
    kind: 'command',
    title: phase === 'started' ? '准备网页检索' : '网页检索已更新',
    detail: query,
  }
}

function formatCollabToolEvent(item = {}, phase = 'completed') {
  const tool = String(item.tool || '').trim()
  const agentCount = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter(Boolean).length : 0
  const prompt = summarizeText(item.prompt)

  if (tool === 'spawn_agent') {
    return {
      kind: 'todo',
      title: phase === 'started'
        ? '正在启动子代理'
        : `已启动 ${agentCount || 1} 个子代理`,
      detail: prompt ? `任务：${prompt}` : '',
    }
  }

  if (tool === 'wait') {
    return {
      kind: 'todo',
      title: phase === 'started'
        ? (agentCount ? `等待 ${agentCount} 个子代理返回结果` : '等待子代理返回结果')
        : '子代理结果已汇总',
      detail: prompt ? `等待内容：${prompt}` : '',
    }
  }

  return {
    kind: 'todo',
    title: phase === 'started'
      ? `正在执行协作工具：${tool || '未知工具'}`
      : `协作工具完成：${tool || '未知工具'}`,
    detail: prompt ? `任务：${prompt}` : '',
  }
}

function formatFileChangeEvent(item = {}, phase = 'completed') {
  const changes = Array.isArray(item.changes) ? item.changes : []
  const kindLabelMap = {
    create: '新增',
    update: '更新',
    delete: '删除',
  }

  return {
    kind: 'command',
    title: phase === 'started'
      ? '正在整理文件变更'
      : `已记录 ${changes.length || 0} 个文件改动`,
    detail: formatMultilineList('', changes.map((change) => {
      const changePath = String(change?.path || '').trim()
      const changeKind = kindLabelMap[String(change?.kind || '').trim()] || '变更'
      return `${changeKind} ${changePath || '未命名文件'}`
    })),
  }
}

function syncTurnSummaryFromCodexEvent(turn, event = {}) {
  if (!turn?.summary) {
    turn.summary = createTurnSummaryState()
  }

  const summary = turn.summary
  const agentLabel = getTurnAgentLabel(turn)
  const eventType = String(event.type || '').trim()
  const item = event.item || {}

  if (eventType === 'turn.started') {
    summary.currentActivity = '正在分析任务'
    summary.latestActivity = `${agentLabel} 开始执行`
    summary.latestDetail = ''
    return
  }

  if (eventType === 'turn.completed') {
    summary.currentActivity = ''
    summary.waitingAgentCount = 0
    summary.latestActivity = `${agentLabel} 执行完成`
    summary.latestDetail = ''
    return
  }

  if (eventType === 'turn.failed') {
    summary.currentActivity = ''
    summary.waitingAgentCount = 0
    summary.latestActivity = '本轮运行失败'
    summary.latestDetail = ''
    return
  }

  if (eventType === 'error') {
    const retrying = parseCodexRetryMessage(extractCodexEventErrorText(event))
    if (retrying) {
      summary.currentActivity = `网络异常，正在重试 (${retrying.attempt}/${retrying.total})`
      summary.latestActivity = summary.currentActivity
      summary.latestDetail = summarizeText(retrying.reason, 120)
      return
    }

    summary.currentActivity = ''
    summary.latestActivity = `${agentLabel} 返回错误`
    summary.latestDetail = summarizeText(extractCodexEventErrorText(event), 120)
    return
  }

  if (eventType === 'item.started') {
    if (item.type === 'reasoning') {
      summary.currentActivity = '正在思考'
      summary.latestActivity = '正在思考'
      summary.latestDetail = summarizeText(item.text, 120)
      return
    }

    if (item.type === 'command_execution') {
      summary.currentActivity = '正在执行命令'
      summary.latestActivity = '开始执行命令'
      summary.latestDetail = summarizeText(item.command, 120)
      return
    }

    if (item.type === 'web_search') {
      summary.currentActivity = item.action?.type === 'open_page' ? '正在打开网页' : '正在搜索网页'
      summary.latestActivity = summary.currentActivity
      summary.latestDetail = summarizeText(item.action?.type === 'open_page' ? (item.action?.url || item.query) : (item.query || item.action?.query), 120)
      return
    }

    if (item.type === 'collab_tool_call') {
      if (item.tool === 'wait') {
        const agentCount = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter(Boolean).length : 0
        summary.waitingAgentCount = agentCount
        summary.currentActivity = agentCount ? `等待 ${agentCount} 个子代理返回结果` : '等待子代理返回结果'
        summary.latestActivity = summary.currentActivity
        summary.latestDetail = summarizeText(item.prompt, 120)
        return
      }

      if (item.tool === 'spawn_agent') {
        summary.currentActivity = '正在启动子代理'
        summary.latestActivity = '正在启动子代理'
        summary.latestDetail = summarizeText(item.prompt, 120)
        return
      }
    }

    if (item.type === 'file_change') {
      summary.currentActivity = '正在整理文件变更'
      summary.latestActivity = '正在整理文件变更'
      summary.latestDetail = summarizeText((item.changes || []).map((change) => change?.path).filter(Boolean).join('，'), 120)
      return
    }

    if (item.type === 'todo_list') {
      summary.currentActivity = '正在规划执行步骤'
      summary.latestActivity = '正在规划执行步骤'
      summary.latestDetail = summarizeText((item.items || []).map((entry) => entry?.text).filter(Boolean).join('；'), 120)
    }
    return
  }

  if (eventType !== 'item.completed') {
    return
  }

  if (item.type === 'command_execution') {
    summary.commandCount += 1
    summary.currentActivity = ''
    summary.latestActivity = '命令执行完成'
    summary.latestDetail = summarizeText(item.command, 120)
    return
  }

  if (item.type === 'web_search') {
    summary.webSearchCount += 1
    summary.currentActivity = ''
    summary.latestActivity = item.action?.type === 'open_page' ? '已打开网页' : '已搜索网页'
    summary.latestDetail = summarizeText(item.action?.type === 'open_page' ? (item.action?.url || item.query) : (item.query || item.action?.query), 120)
    return
  }

  if (item.type === 'collab_tool_call') {
    if (item.tool === 'spawn_agent') {
      const agentCount = Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids.filter(Boolean).length : 0
      summary.subAgentCount += agentCount
      summary.currentActivity = ''
      summary.latestActivity = agentCount ? `已启动 ${agentCount} 个子代理` : '已启动子代理'
      summary.latestDetail = summarizeText(item.prompt, 120)
      return
    }

    if (item.tool === 'wait') {
      summary.waitingAgentCount = 0
      summary.currentActivity = ''
      summary.latestActivity = '子代理结果已汇总'
      summary.latestDetail = summarizeText(item.prompt, 120)
      return
    }

    summary.currentActivity = ''
    summary.latestActivity = `协作工具完成：${item.tool || '未知工具'}`
    summary.latestDetail = summarizeText(item.prompt, 120)
    return
  }

  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    summary.fileChangeCount += changes.length
    summary.currentActivity = ''
    summary.latestActivity = changes.length ? `已记录 ${changes.length} 个文件改动` : '已记录文件改动'
    summary.latestDetail = summarizeText(changes.map((change) => change?.path).filter(Boolean).join('，'), 120)
    return
  }

  if (item.type === 'todo_list') {
    summary.currentActivity = ''
    summary.latestActivity = '待办列表已更新'
    summary.latestDetail = summarizeText((item.items || []).map((entry) => entry?.text).filter(Boolean).join('；'), 120)
    return
  }

  if (item.type === 'agent_message') {
    summary.currentActivity = ''
    summary.latestActivity = `${agentLabel} 已返回结果`
    summary.latestDetail = summarizeText(item.text, 120)
  }
}

function getTurnElapsedSeconds(turn = {}, options = {}) {
  const startedAt = Date.parse(String(turn.startedAt || ''))
  if (!Number.isFinite(startedAt)) {
    return 0
  }

  if (turn.status === 'running') {
    if (
      options.currentRunningRunId
      && String(options.currentRunningRunId) === String(turn.runId || '')
      && Number.isFinite(Number(options.runningElapsedSeconds))
    ) {
      return Math.max(0, Math.floor(Number(options.runningElapsedSeconds) || 0))
    }

    const nowMs = Number(options.nowMs) || Date.now()
    return Math.max(0, Math.floor((nowMs - startedAt) / 1000))
  }

  const finishedAt = Date.parse(String(turn.finishedAt || ''))
  if (Number.isFinite(finishedAt) && finishedAt >= startedAt) {
    return Math.max(0, Math.floor((finishedAt - startedAt) / 1000))
  }

  return 0
}

export function getTurnSummaryItems(turn = {}, options = {}) {
  const summary = turn.summary || createTurnSummaryState()
  const items = []
  const elapsedSeconds = getTurnElapsedSeconds(turn, options)

  if (elapsedSeconds > 0) {
    items.push({ key: 'elapsed', label: '耗时', value: formatElapsedDuration(elapsedSeconds) })
  }

  if (summary.webSearchCount) {
    items.push({ key: 'web', label: '网页', value: formatCount(summary.webSearchCount) })
  }
  if (summary.commandCount) {
    items.push({ key: 'command', label: '命令', value: formatCount(summary.commandCount) })
  }
  if (summary.fileChangeCount) {
    items.push({ key: 'file', label: '改动', value: formatCount(summary.fileChangeCount) })
  }
  if (summary.subAgentCount) {
    items.push({ key: 'agent', label: '子代理', value: formatCount(summary.subAgentCount) })
  }

  return items
}

export function getTurnSummaryStatus(turn = {}) {
  const summary = turn.summary || createTurnSummaryState()

  if (summary.waitingAgentCount > 0) {
    return `当前：等待 ${formatCount(summary.waitingAgentCount)} 个子代理返回结果`
  }

  if (summary.currentActivity) {
    return `当前：${summary.currentActivity}`
  }

  if (summary.latestActivity) {
    return `最近：${summary.latestActivity}`
  }

  if (turn.status === 'running') {
    return `当前：正在等待 ${getTurnAgentLabel(turn)} 返回更多事件`
  }

  return ''
}

export function getTurnSummaryDetail(turn = {}) {
  const summary = turn.summary || createTurnSummaryState()
  return String(summary.latestDetail || '').trim()
}

export function hasTurnSummary(turn = {}) {
  return Boolean(getTurnSummaryItems(turn).length || getTurnSummaryStatus(turn) || getTurnSummaryDetail(turn))
}

const CODEX_ISSUE_PATTERNS = [
  {
    type: 'startup_config',
    title: (engine) => `${getAgentEngineLabel(engine)} 启动配置冲突`,
    summary: (engine) => `${getAgentEngineLabel(engine)} 当前启动参数可能与本机包装脚本、别名或外部环境配置冲突，请检查 CLI 启动方式。`,
    patterns: [
      /not inside a trusted directory/i,
      /do you trust the contents of this directory/i,
      /trusted directory/i,
      /skip-git-repo-check/i,
      /prompt injection/i,
      /目录.*信任/,
      /可信目录/,
    ],
  },
  {
    type: 'billing',
    title: '额度或账单异常',
    summary: (engine) => `${getAgentEngineLabel(engine)} 可能因为额度不足、欠费或账单限制而无法继续执行。`,
    patterns: [
      /insufficient_quota/i,
      /exceeded your current quota/i,
      /\bquota\b/i,
      /\bbilling\b/i,
      /credit balance/i,
      /payment required/i,
      /余额不足/,
      /欠费/,
      /账单/,
      /充值/,
    ],
  },
  {
    type: 'permission',
    title: '权限不足',
    summary: (engine) => `${getAgentEngineLabel(engine)} 当前权限不够，无法访问所需文件、命令或资源。`,
    patterns: [
      /permission denied/i,
      /insufficient permissions?/i,
      /forbidden/i,
      /unauthorized/i,
      /access denied/i,
      /not allowed/i,
      /权限不足/,
      /没有权限/,
      /无权/,
      /拒绝访问/,
    ],
  },
  {
    type: 'rate_limit',
    title: '请求过于频繁',
    summary: (engine) => `${getAgentEngineLabel(engine)} 可能触发了限流，请稍后再试。`,
    patterns: [
      /rate limit/i,
      /too many requests/i,
      /\b429\b/,
      /请求过于频繁/,
      /限流/,
    ],
  },
  {
    type: 'context_limit',
    title: '上下文过长',
    summary: '这次发送的内容可能过长，超过了模型可处理的上下文限制。',
    patterns: [
      /context length/i,
      /maximum context length/i,
      /context_length_exceeded/i,
      /token limit/i,
      /prompt is too long/i,
      /上下文过长/,
      /超过.*token/i,
      /超出.*上下文/,
    ],
  },
  {
    type: 'model_unavailable',
    title: '模型或服务暂不可用',
    summary: (engine) => `${getAgentEngineLabel(engine)} 背后的模型或服务当前不可用，请稍后重试。`,
    patterns: [
      /model .*not found/i,
      /model .*unavailable/i,
      /service unavailable/i,
      /server error/i,
      /overloaded/i,
      /\b503\b/,
      /模型不可用/,
      /服务不可用/,
    ],
  },
  {
    type: 'network',
    title: '网络连接异常',
    summary: (engine) => `${getAgentEngineLabel(engine)} 在请求过程中遇到了网络问题或连接超时。`,
    patterns: [
      /timed out/i,
      /\btimeout\b/i,
      /stream disconnected/i,
      /error sending request/i,
      /connection reset/i,
      /connection closed/i,
      /socket hang up/i,
      /network error/i,
      /fetch failed/i,
      /econnreset/i,
      /econnrefused/i,
      /enotfound/i,
      /network is unreachable/i,
      /temporary failure in name resolution/i,
      /网络异常/,
      /连接超时/,
    ],
  },
  {
    type: 'cli_missing',
    title: (engine) => `${getAgentEngineLabel(engine)} CLI 不可用`,
    summary: (engine) => `当前环境没有正确安装或配置 ${getAgentEngineLabel(engine)} CLI。`,
    patterns: [
      /找不到 Codex CLI/,
      /找不到 Claude Code CLI/,
      /codex --version/i,
      /claude --version/i,
      /enoent/i,
      /not recognized as an internal or external command/i,
      /command not found/i,
    ],
  },
]

export function classifyCodexIssue(message = '', engine = 'codex') {
  const text = String(message || '').trim()
  if (!text) {
    return null
  }

  const matched = CODEX_ISSUE_PATTERNS.find((issue) => issue.patterns.some((pattern) => pattern.test(text)))
  if (!matched) {
    return null
  }

  return {
    type: matched.type,
    title: typeof matched.title === 'function' ? matched.title(engine) : matched.title,
    summary: typeof matched.summary === 'function' ? matched.summary(engine) : matched.summary,
    rawMessage: text,
  }
}

export function formatCodexIssueMessage(message = '', engine = 'codex') {
  const text = String(message || '').trim()
  if (!text) {
    return ''
  }

  const issue = classifyCodexIssue(text, engine)
  if (!issue) {
    return text
  }

  return `${issue.summary}\n\n原始错误：${issue.rawMessage}`
}

function extractTextFromUnknownError(input, depth = 0) {
  if (!input || depth > 4) {
    return ''
  }

  if (typeof input === 'string') {
    return input.trim()
  }

  if (typeof input !== 'object') {
    return ''
  }

  const priorityKeys = [
    'message',
    'detail',
    'error',
    'last_error',
    'cause',
    'reason',
    'stderr',
    'text',
    'summary',
  ]

  for (const key of priorityKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue
    }

    const value = extractTextFromUnknownError(input[key], depth + 1)
    if (value) {
      return value
    }
  }

  for (const value of Object.values(input)) {
    const text = extractTextFromUnknownError(value, depth + 1)
    if (text) {
      return text
    }
  }

  return ''
}

export function extractCodexEventErrorText(event = {}) {
  return extractTextFromUnknownError(event)
}

export function formatCodexEvent(event = {}, agentLabel = 'Codex', engine = 'codex') {
  const eventType = String(event.type || '').trim()
  const item = event.item || {}

  if (!eventType) {
    return { title: `收到 ${agentLabel} 事件`, detail: '' }
  }

  if (eventType === 'thread.started') {
    return {
      title: `${agentLabel} 会话已创建`,
      detail: event.thread_id ? `线程 ID: ${event.thread_id}` : '',
    }
  }

  if (eventType === 'turn.started') {
    return { title: `${agentLabel} 开始执行`, detail: '' }
  }

  if (eventType === 'turn.completed') {
    const usage = event.usage
      ? [
        `输入 ${formatCount(event.usage.input_tokens)}`,
        event.usage.cached_input_tokens ? `缓存 ${formatCount(event.usage.cached_input_tokens)}` : '',
        `输出 ${formatCount(event.usage.output_tokens)}`,
      ].filter(Boolean).join(' / ')
      : ''
    return {
      title: `${agentLabel} 执行完成`,
      detail: usage,
    }
  }

  if (eventType === 'error' || eventType === 'turn.failed') {
    const rawMessage = extractCodexEventErrorText(event) || `${agentLabel} 执行失败`
    const retrying = eventType === 'error' ? parseCodexRetryMessage(rawMessage) : null
    if (retrying) {
      return {
        kind: 'info',
        title: `网络异常，正在重试 (${retrying.attempt}/${retrying.total})`,
        detail: formatCodexIssueMessage(retrying.reason || retrying.rawMessage, engine),
      }
    }

    const issue = classifyCodexIssue(rawMessage, engine)
    return {
      kind: 'error',
      title: issue?.title || (eventType === 'turn.failed' ? '本轮运行失败' : `${agentLabel} 返回错误`),
      detail: formatCodexIssueMessage(rawMessage, engine),
    }
  }

  if (eventType === 'item.started') {
    if (item.type === 'reasoning') {
      return {
        kind: 'info',
        title: '正在思考',
        detail: item.text || '',
      }
    }

    if (item.type === 'web_search') {
      return formatWebSearchEvent(item, 'started')
    }

    if (item.type === 'collab_tool_call') {
      return formatCollabToolEvent(item, 'started')
    }

    if (item.type === 'file_change') {
      return formatFileChangeEvent(item, 'started')
    }

    if (item.type === 'command_execution') {
      return {
        kind: 'command',
        title: '开始执行命令',
        detail: item.command || '',
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '更新待办列表',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `开始处理 ${item.type || '未知项目'}`,
      detail: '',
    }
  }

  if (eventType === 'item.updated' && item.type === 'todo_list') {
    return {
      kind: 'todo',
      title: '更新待办列表',
      detail: formatTodoItems(item.items),
    }
  }

  if (eventType === 'item.completed') {
    if (item.type === 'agent_message' && item.text) {
      return {
        kind: 'result',
        title: `${agentLabel} 已返回结果`,
        detail: '',
      }
    }

    if (item.type === 'web_search') {
      return formatWebSearchEvent(item, 'completed')
    }

    if (item.type === 'collab_tool_call') {
      return formatCollabToolEvent(item, 'completed')
    }

    if (item.type === 'file_change') {
      return formatFileChangeEvent(item, 'completed')
    }

    if (item.type === 'command_execution') {
      const success = item.exit_code === 0 || item.status === 'completed'
      return {
        kind: success ? 'command' : 'error',
        title: success ? '命令执行完成' : `命令执行失败(exit ${item.exit_code ?? '?'})`,
        detail: [item.command, formatCommandOutput(item.aggregated_output)].filter(Boolean).join('\n\n'),
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '更新待办列表',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `完成 ${item.type || '未知项目'}`,
      detail: '',
    }
  }

  return {
    title: `事件: ${eventType}`,
    detail: '',
  }
}

export function getProcessStatus(turn) {
  if (turn.status === 'running') {
    return '进行中'
  }
  if (turn.status === 'error') {
    return '失败'
  }
  if (turn.status === 'interrupted') {
    return '已中断'
  }
  if (turn.status === 'stopped') {
    return '已停止'
  }
  return '已完成'
}

function normalizeLogEntry(entry = {}, nextLogId) {
  if (typeof entry === 'string') {
    const text = entry.trim()
    if (!text) {
      return null
    }
    return {
      id: nextLogId(),
      kind: 'info',
      title: text,
      detail: '',
    }
  }

  const title = String(entry.title || '').trim()
  const detail = String(entry.detail || '').trim()
  if (!title && !detail) {
    return null
  }

  return {
    id: nextLogId(),
    kind: entry.kind || 'info',
    title: title || detail,
    detail: title ? detail : '',
  }
}

function createBaseTurn(run = {}, nextTurnId) {
  const promptBlocks = Array.isArray(run.promptBlocks)
    ? run.promptBlocks.map((block) => ({
        ...block,
        meta: block?.meta ? { ...block.meta } : {},
        content: block?.type === 'image' ? resolveAssetUrl(block.content) : block.content,
      }))
    : []

  return {
    id: nextTurnId(),
    runId: String(run.id || '').trim(),
    engine: getTurnAgentEngine(run),
    prompt: String(run.prompt || '').trim(),
    promptBlocks,
    status: 'completed',
    startedAt: run.startedAt || run.createdAt || '',
    finishedAt: run.finishedAt || '',
    events: [],
    eventCount: Math.max(0, Number(run.eventCount) || (Array.isArray(run.events) ? run.events.length : 0)),
    eventsLoaded: Boolean(run.eventsIncluded),
    eventsLoading: false,
    responseMessage: '',
    errorMessage: '',
    lastEventSeq: 0,
    summary: createTurnSummaryState(),
  }
}

function appendTurnEvent(turn, entry, nextLogId) {
  const normalized = normalizeLogEntry(entry, nextLogId)
  if (!normalized) {
    return
  }

  turn.events.push(normalized)
  if (turn.events.length > 120) {
    turn.events.splice(0, turn.events.length - 120)
  }
}

function upsertRetryingEvent(turn, entry, nextLogId) {
  const normalized = normalizeLogEntry(entry, nextLogId)
  if (!normalized) {
    return
  }

  for (let index = turn.events.length - 1; index >= 0; index -= 1) {
    if (!String(turn.events[index]?.title || '').startsWith('网络异常，正在重试')) {
      continue
    }
    turn.events.splice(index, 1, normalized)
    return
  }

  turn.events.push(normalized)
  if (turn.events.length > 120) {
    turn.events.splice(0, turn.events.length - 120)
  }
}

export function applyRunPayloadToTurn(turn, payload = {}, nextLogId, mergeSession = () => {}) {
  if (payload.type === 'session') {
    mergeSession(payload.session)
    turn.engine = getTurnAgentEngine(payload.session || turn)
    appendTurnEvent(turn, {
      title: `已连接项目：${payload.session?.title || '未命名项目'}`,
      detail: payload.session?.cwd ? `工作目录：${payload.session.cwd}` : '',
    }, nextLogId)
    return
  }

  if (payload.type === 'session.updated') {
    mergeSession(payload.session)
    turn.engine = getTurnAgentEngine(payload.session || turn)
    appendTurnEvent(turn, {
      title: '项目会话已更新',
      detail: payload.session?.started ? '后续请求会继续复用当前项目的执行引擎会话。' : '',
    }, nextLogId)
    return
  }

  if (payload.type === 'status') {
    if (payload.stage === 'starting' || payload.stage === 'resuming') {
      return
    }

    appendTurnEvent(turn, {
      title: payload.message || '状态已更新',
      detail: '',
    }, nextLogId)
    return
  }

  if (payload.type === 'stderr') {
    const issue = classifyCodexIssue(payload.text, turn.engine)
    appendTurnEvent(turn, {
      kind: 'error',
      title: issue?.title || 'stderr',
      detail: formatCodexIssueMessage(payload.text, turn.engine),
    }, nextLogId)
    return
  }

  if (payload.type === 'stdout') {
    appendTurnEvent(turn, {
      kind: 'command',
      title: 'stdout',
      detail: payload.text,
    }, nextLogId)
    return
  }

  if (payload.type === 'codex') {
    syncTurnSummaryFromCodexEvent(turn, payload.event)
    const formattedEvent = formatCodexEvent(payload.event, getTurnAgentLabel(turn), turn.engine)
    if (String(formattedEvent.title || '').startsWith('网络异常，正在重试')) {
      upsertRetryingEvent(turn, formattedEvent, nextLogId)
    } else {
      appendTurnEvent(turn, formattedEvent, nextLogId)
    }
    if (payload.event?.type === 'item.completed' && payload.event?.item?.type === 'agent_message' && payload.event?.item?.text) {
      turn.responseMessage = payload.event.item.text
    }
    const message = extractCodexEventErrorText(payload.event) || `${getTurnAgentLabel(turn)} 执行失败`
    const retrying = payload.event?.type === 'error' ? parseCodexRetryMessage(message) : null
    if (!retrying && (payload.event?.type === 'error' || payload.event?.type === 'turn.failed')) {
      const message = extractCodexEventErrorText(payload.event) || `${getTurnAgentLabel(turn)} 执行失败`
      turn.errorMessage = formatCodexIssueMessage(message, turn.engine)
      turn.status = 'error'
    }
    return
  }

  if (payload.type === 'completed') {
    appendTurnEvent(turn, {
      kind: 'result',
      title: '本轮执行结束',
      detail: '',
    }, nextLogId)
    if (payload.message) {
      turn.responseMessage = payload.message
    }
    return
  }

  if (payload.type === 'stopped') {
    appendTurnEvent(turn, {
      title: payload.message || '执行已手动停止',
      detail: '',
    }, nextLogId)
    return
  }

  if (payload.type === 'error') {
    const issue = classifyCodexIssue(payload.message, turn.engine)
    appendTurnEvent(turn, {
      kind: 'error',
      title: issue?.title || '执行失败',
      detail: formatCodexIssueMessage(payload.message || `${getTurnAgentLabel(turn)} 执行失败`, turn.engine),
    }, nextLogId)
  }
}

function shouldPreferEventDerivedError(runError = '', eventError = '', engine = 'codex') {
  const persisted = String(runError || '').trim()
  const derived = String(eventError || '').trim()

  if (!derived) {
    return false
  }

  if (!persisted) {
    return true
  }

  if (/no last agent message|wrote empty content/i.test(persisted)) {
    return true
  }

  if (/执行失败[。.]?$/i.test(persisted)) {
    return true
  }

  const persistedIssue = classifyCodexIssue(persisted, engine)
  const derivedIssue = classifyCodexIssue(derived, engine)

  return !persistedIssue && Boolean(derivedIssue)
}

export function syncTurnStateFromRun(turn, run = {}) {
  turn.status = run.status || 'completed'
  turn.responseMessage = String(run.responseMessage || turn.responseMessage || '')
  turn.finishedAt = String(run.finishedAt || turn.finishedAt || '')
  const persistedError = formatCodexIssueMessage(String(run.errorMessage || ''), turn.engine)
  const eventDerivedError = String(turn.errorMessage || '')
  turn.errorMessage = shouldPreferEventDerivedError(run.errorMessage, eventDerivedError, turn.engine)
    ? eventDerivedError
    : persistedError

  if (turn.status === 'completed' && !turn.responseMessage) {
    turn.responseMessage = `本轮 ${getTurnAgentLabel(turn)} 执行已完成，没有返回额外文本。`
  }

  return turn
}

export function applyRunEventToTurn(turn, event = {}, nextLogId, mergeSession = () => {}) {
  const nextSeq = Math.max(0, Number(event?.seq) || 0)
  if (nextSeq && nextSeq <= Number(turn.lastEventSeq || 0)) {
    return false
  }

  const payload = event?.payload || {}
  applyRunPayloadToTurn(turn, payload, nextLogId, mergeSession)

  if (payload.type === 'completed') {
    turn.status = 'completed'
    turn.finishedAt = new Date().toISOString()
  } else if (payload.type === 'stopped') {
    turn.status = 'stopped'
    turn.errorMessage = ''
    turn.finishedAt = new Date().toISOString()
  } else if (payload.type === 'error') {
    turn.status = 'error'
    turn.errorMessage = formatCodexIssueMessage(String(payload.message || turn.errorMessage || `${getTurnAgentLabel(turn)} 执行失败`), turn.engine)
    turn.finishedAt = new Date().toISOString()
  }

  if (nextSeq) {
    turn.lastEventSeq = nextSeq
  }
  turn.eventCount = Math.max(
    Math.max(0, Number(turn.eventCount) || 0),
    nextSeq,
    Array.isArray(turn.events) ? turn.events.length : 0
  )
  if (nextSeq || (Array.isArray(turn.events) && turn.events.length)) {
    turn.eventsLoaded = true
  }

  return true
}

export function createTurnFromRun(run, nextTurnId, nextLogId, mergeSession) {
  const turn = createBaseTurn(run, nextTurnId)

  ;(run.events || []).forEach((event) => {
    applyRunEventToTurn(turn, event, nextLogId, mergeSession)
  })

  return syncTurnStateFromRun(turn, run)
}

export function useCodexSessionPanel(props, emit) {
  const realtime = useWorkbenchRealtime()
  const sessions = ref([])
  const workspaces = ref([])
  const loading = ref(false)
  const managerBusy = ref(false)
  const sending = ref(false)
  const sessionError = ref('')
  const turns = ref([])
  const transcriptRef = ref(null)
  const sendingStartedAt = ref(0)
  const sendingElapsedSeconds = ref(0)
  const showManager = ref(false)
  const currentRunningRunId = ref('')
  const hasNewerMessages = ref(false)
  const supportsServerEvents = typeof window !== 'undefined' && typeof window.EventSource !== 'undefined'

  let turnId = 0
  let logId = 0
  let sendingTimer = null
  let sessionsLoadPromise = null
  let workspacesLoadPromise = null
  let lastSessionsLoadedAt = 0
  let lastWorkspacesLoadedAt = 0
  let runsLoadPromise = null
  let runPollTimer = null
  let lastRunFingerprint = ''
  let lastFallbackSessionPollAt = 0
  let unsubscribeTaskRunEvents = null
  let serverSyncTimer = null
  let pendingScrollJobId = 0
  let pendingScrollFrameIds = []
  let stickToBottom = true
  const runEventLoadPromises = new Map()
  let pendingServerSync = {
    sessions: false,
    runs: false,
  }

  const hasPrompt = computed(() => typeof props.buildPrompt === 'function' || Boolean(String(props.prompt || '').trim()))
  const hasSessions = computed(() => sessions.value.length > 0)
  const selectedSessionId = computed({
    get() {
      return String(props.selectedSessionId || '').trim()
    },
    set(value) {
      emit('selected-session-change', String(value || '').trim())
    },
  })
  const sortedSessions = computed(() => sortSessions(sessions.value, selectedSessionId.value))
  const helperText = computed(() => {
    if (!hasSessions.value) {
      return '还没有 PromptX 项目，请先在管理弹窗里新建一个固定工作目录。'
    }
    return ''
  })
  const workingLabel = computed(() => `运行中 (${formatElapsedDuration(sendingElapsedSeconds.value)})`)

  function clearSendingTimer() {
    if (sendingTimer) {
      window.clearInterval(sendingTimer)
      sendingTimer = null
    }
  }

  function startSendingTimer() {
    clearSendingTimer()
    if (!sendingStartedAt.value) {
      sendingStartedAt.value = Date.now()
    }
    sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
    sendingTimer = window.setInterval(() => {
      sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
    }, 1000)
  }

  function clearRunPollTimer() {
    if (runPollTimer) {
      window.clearInterval(runPollTimer)
      runPollTimer = null
    }
  }

  function clearServerSyncTimer() {
    if (serverSyncTimer) {
      window.clearTimeout(serverSyncTimer)
      serverSyncTimer = null
    }
  }

  function clearPendingScrollFrames() {
    if (typeof window === 'undefined' || !pendingScrollFrameIds.length) {
      pendingScrollFrameIds = []
      return
    }

    pendingScrollFrameIds.forEach((frameId) => {
      window.cancelAnimationFrame(frameId)
    })
    pendingScrollFrameIds = []
  }

  function cancelScheduledScrollToBottom() {
    pendingScrollJobId += 1
    clearPendingScrollFrames()
  }

  function flushServerSync() {
    clearServerSyncTimer()

    const nextSync = pendingServerSync
    pendingServerSync = {
      sessions: false,
      runs: false,
    }

    if (nextSync.sessions) {
      loadSessions({ force: true }).catch(() => {})
    }

    if (nextSync.runs) {
      refreshRunHistory({ force: true }).catch(() => {})
    }
  }

  function scheduleServerSync(options = {}) {
    if (typeof window === 'undefined') {
      return
    }

    pendingServerSync = {
      sessions: pendingServerSync.sessions || Boolean(options.sessions),
      runs: pendingServerSync.runs || Boolean(options.runs),
    }

    if (serverSyncTimer || (!pendingServerSync.sessions && !pendingServerSync.runs)) {
      return
    }

    serverSyncTimer = window.setTimeout(() => {
      flushServerSync()
    }, SERVER_SYNC_DELAY)
  }

  function isTranscriptNearBottom(element = transcriptRef.value) {
    if (!element) {
      return true
    }

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    return distanceToBottom <= AUTO_SCROLL_THRESHOLD
  }

  function handleTranscriptScroll() {
    const nextStickToBottom = isTranscriptNearBottom()
    if (!nextStickToBottom) {
      cancelScheduledScrollToBottom()
    }

    stickToBottom = nextStickToBottom
    if (stickToBottom) {
      hasNewerMessages.value = false
    }
  }

  function scheduleScrollToBottom(options = {}) {
    const { force = false } = options
    if (force) {
      stickToBottom = true
      hasNewerMessages.value = false
    }

    cancelScheduledScrollToBottom()
    const jobId = pendingScrollJobId

    nextTick(() => {
      const element = transcriptRef.value
      if (!element || jobId !== pendingScrollJobId) {
        return
      }
      if (!force && !stickToBottom) {
        hasNewerMessages.value = true
        return
      }

      const run = () => {
        const currentElement = transcriptRef.value
        if (!currentElement || jobId !== pendingScrollJobId) {
          return
        }
        currentElement.scrollTop = currentElement.scrollHeight
        stickToBottom = true
        hasNewerMessages.value = false
      }

      run()
      const firstFrameId = requestAnimationFrame(() => {
        run()
        const secondFrameId = requestAnimationFrame(run)
        pendingScrollFrameIds = [secondFrameId]
      })
      pendingScrollFrameIds = [firstFrameId]
    })
  }

  function scrollToBottom() {
    scheduleScrollToBottom({ force: true })
  }

  function getDisplayTurnSummaryItems(turn) {
    return getTurnSummaryItems(turn, {
      currentRunningRunId: currentRunningRunId.value,
      runningElapsedSeconds: sendingElapsedSeconds.value,
      nowMs: Date.now(),
    })
  }

  function openManager() {
    showManager.value = true
    loadWorkspaces().catch(() => {})
  }

  function closeManager() {
    showManager.value = false
  }

  function mergeSessionRecord(currentSession, nextSession, options = {}) {
    const { preserveRunning = false } = options
    if (!nextSession?.id) {
      return currentSession || null
    }

    if (!preserveRunning) {
      return nextSession
    }

    return {
      ...nextSession,
      running: Boolean(currentSession?.running),
    }
  }

  function mergeSession(nextSession, options = {}) {
    if (!nextSession?.id) {
      return
    }

    const nextList = [...sessions.value]
    const index = nextList.findIndex((item) => item.id === nextSession.id)
    if (index >= 0) {
      nextList[index] = mergeSessionRecord(nextList[index], nextSession, options)
    } else {
      nextList.unshift(mergeSessionRecord(null, nextSession, options))
    }
    sessions.value = nextList
  }

  function nextTurnIdValue() {
    turnId += 1
    return turnId
  }

  function nextLogIdValue() {
    logId += 1
    return logId
  }

  function syncRunningStateFromTurns() {
    const runningTurn = [...turns.value].reverse().find((turn) => turn.status === 'running') || null

    currentRunningRunId.value = runningTurn?.runId || ''
    sending.value = Boolean(runningTurn)
    if (runningTurn?.startedAt) {
      const startedAt = Date.parse(String(runningTurn.startedAt || ''))
      sendingStartedAt.value = Number.isFinite(startedAt) ? startedAt : Date.now()
      return
    }

    sendingStartedAt.value = 0
  }

  function cloneTurnSummaryState(summary = null) {
    return summary ? { ...summary } : createTurnSummaryState()
  }

  function preserveTurnEventsState(nextTurn, previousTurn = null) {
    if (!previousTurn?.runId || nextTurn.eventsLoaded || !previousTurn.eventsLoaded) {
      if (runEventLoadPromises.has(nextTurn.runId)) {
        nextTurn.eventsLoading = true
      }
      return nextTurn
    }

    const previousCoverage = Math.max(
      Math.max(0, Number(previousTurn.lastEventSeq) || 0),
      Math.max(0, Number(previousTurn.eventCount) || 0),
      Array.isArray(previousTurn.events) ? previousTurn.events.length : 0
    )
    const nextCoverage = Math.max(0, Number(nextTurn.eventCount) || 0)
    if (previousCoverage < nextCoverage) {
      if (runEventLoadPromises.has(nextTurn.runId)) {
        nextTurn.eventsLoading = true
      }
      return nextTurn
    }

    nextTurn.events = Array.isArray(previousTurn.events) ? [...previousTurn.events] : []
    nextTurn.eventCount = Math.max(
      Math.max(0, Number(nextTurn.eventCount) || 0),
      Math.max(0, Number(previousTurn.eventCount) || 0),
      nextTurn.events.length
    )
    nextTurn.eventsLoaded = true
    nextTurn.eventsLoading = runEventLoadPromises.has(nextTurn.runId)
    nextTurn.lastEventSeq = Math.max(0, Number(previousTurn.lastEventSeq) || 0)
    nextTurn.summary = cloneTurnSummaryState(previousTurn.summary)
    return nextTurn
  }

  function setTurnEventsLoading(runId, loading) {
    const activeTurn = findTurnByRunId(turns.value, runId)
    if (!activeTurn) {
      return null
    }

    activeTurn.eventsLoading = Boolean(loading)
    turns.value = [...turns.value]
    return activeTurn
  }

  async function loadTurnEvents(turn, options = {}) {
    const runId = String(turn?.runId || '').trim()
    const { force = false } = options
    if (!runId) {
      return []
    }

    const currentTurn = findTurnByRunId(turns.value, runId) || turn
    if (currentTurn?.eventsLoaded && !force) {
      return currentTurn.events
    }

    if (runEventLoadPromises.has(runId)) {
      return runEventLoadPromises.get(runId)
    }

    setTurnEventsLoading(runId, true)

    const requestPromise = (async () => {
      try {
        const payload = await listCodexRunEvents(runId, {
          limit: 5000,
        })
        const appliedTurn = applyRunEventsPayloadToTurns(
          turns.value,
          runId,
          payload,
          nextLogIdValue,
          (session) => {
            mergeSession(session, { preserveRunning: true })
          }
        )

        if (!appliedTurn) {
          return Array.isArray(currentTurn?.events) ? currentTurn.events : []
        }

        turns.value = [...turns.value]
        if (props.active && turns.value.at(-1)?.runId === runId) {
          scheduleScrollToBottom()
        }
        return appliedTurn.events
      } catch (err) {
        sessionError.value = err.message
        throw err
      } finally {
        setTurnEventsLoading(runId, false)
        runEventLoadPromises.delete(runId)
      }
    })()

    runEventLoadPromises.set(runId, requestPromise)
    return requestPromise
  }

  function applyIncomingRunEvent(runId, event) {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId || !event) {
      return false
    }

    const turnIndex = turns.value.findIndex((turn) => turn.runId === normalizedRunId)
    if (turnIndex < 0) {
      return false
    }

    const turn = turns.value[turnIndex]
    const didApply = applyRunEventToTurn(turn, event, nextLogIdValue, (session) => {
      mergeSession(session, { preserveRunning: true })
    })
    if (!didApply) {
      return true
    }

    turns.value = [...turns.value]
    syncRunningStateFromTurns()
    scheduleScrollToBottom()
    return true
  }

  function updatePollingState() {
    clearRunPollTimer()
    if (supportsServerEvents || !props.active || !sending.value || !props.taskSlug) {
      return
    }

    runPollTimer = window.setInterval(() => {
      refreshRunHistory({ force: true }).catch(() => {})

      const now = Date.now()
      if (now - lastFallbackSessionPollAt < FALLBACK_SESSION_POLL_INTERVAL_MS) {
        return
      }

      lastFallbackSessionPollAt = now
      loadSessions({ force: true }).catch(() => {})
    }, FALLBACK_RUN_POLL_INTERVAL_MS)
  }

  function rebuildTurns(runs = []) {
    const nextSessions = [...sessions.value]
    const previousTurnsByRunId = new Map(
      turns.value
        .filter((turn) => String(turn?.runId || '').trim())
        .map((turn) => [String(turn.runId || '').trim(), turn])
    )
    const mergeRunSession = (session) => {
      if (!session?.id) {
        return
      }

      const index = nextSessions.findIndex((item) => item.id === session.id)
      if (index >= 0) {
        nextSessions[index] = mergeSessionRecord(nextSessions[index], session, { preserveRunning: true })
      } else {
        nextSessions.unshift(mergeSessionRecord(null, session, { preserveRunning: true }))
      }
    }

    turnId = 0
    logId = 0
    turns.value = [...(runs || [])]
      .reverse()
      .map((run) => {
        const nextTurn = createTurnFromRun(run, nextTurnIdValue, nextLogIdValue, mergeRunSession)
        return preserveTurnEventsState(nextTurn, previousTurnsByRunId.get(String(run?.id || '').trim()) || null)
      })
    sessions.value = nextSessions
    syncRunningStateFromTurns()
  }

  async function refreshRunHistory(options = {}) {
    const { force = false, scrollToLatest = false } = options
    const taskSlug = String(props.taskSlug || '').trim()
    if (!taskSlug || (!props.active && !force)) {
      return
    }

    if (runsLoadPromise && !force) {
      return runsLoadPromise
    }

    runsLoadPromise = (async () => {
      try {
        const payload = await listTaskCodexRuns(taskSlug, {
          limit: 30,
        })
        const items = payload.items || []
        const fingerprint = JSON.stringify(items.map((item) => ({
          id: item.id,
          status: item.status,
          updatedAt: item.updatedAt,
          eventCount: Math.max(0, Number(item.eventCount) || 0),
        })))
        const shouldScroll = scrollToLatest || (lastRunFingerprint && fingerprint !== lastRunFingerprint)

        rebuildTurns(items)
        lastRunFingerprint = fingerprint
        updatePollingState()

        const latestTurn = turns.value.at(-1) || null
        if (latestTurn?.runId && !latestTurn.eventsLoaded) {
          loadTurnEvents(latestTurn).catch(() => {})
        }

        if (shouldScroll) {
          scheduleScrollToBottom()
        }
      } catch (err) {
        sessionError.value = err.message
      } finally {
        runsLoadPromise = null
      }
    })()

    return runsLoadPromise
  }

  async function loadSessions(options = {}) {
    const { force = false } = options

    if (sessionsLoadPromise) {
      return sessionsLoadPromise
    }

    const now = Date.now()
    if (!force && lastSessionsLoadedAt && now - lastSessionsLoadedAt < SESSION_REFRESH_TTL) {
      return {
        items: sessions.value,
        workspaces: workspaces.value,
      }
    }

    sessionsLoadPromise = (async () => {
      loading.value = true
      sessionError.value = ''

      try {
        const sessionPayload = await listCodexSessions()
        const nextSessions = sessionPayload.items || []

        sessions.value = nextSessions
        lastSessionsLoadedAt = Date.now()

        return {
          items: nextSessions,
          workspaces: workspaces.value,
        }
      } catch (err) {
        sessionError.value = err.message
        throw err
      } finally {
        loading.value = false
        sessionsLoadPromise = null
      }
    })()

    return sessionsLoadPromise
  }

  async function loadWorkspaces(options = {}) {
    const { force = false } = options

    if (workspacesLoadPromise) {
      return workspacesLoadPromise
    }

    const now = Date.now()
    if (!force && lastWorkspacesLoadedAt && now - lastWorkspacesLoadedAt < WORKSPACE_REFRESH_TTL) {
      return {
        items: workspaces.value,
      }
    }

    workspacesLoadPromise = (async () => {
      try {
        const workspacePayload = await listCodexWorkspaces()
        workspaces.value = workspacePayload.items || []
        lastWorkspacesLoadedAt = Date.now()
        return {
          items: workspaces.value,
        }
      } finally {
        workspacesLoadPromise = null
      }
    })()

    return workspacesLoadPromise
  }

  async function loadSessionResources(options = {}) {
    const { forceSessions = false, forceWorkspaces = false } = options
    const [sessionPayload, workspacePayload] = await Promise.all([
      loadSessions({ force: forceSessions }),
      loadWorkspaces({ force: forceWorkspaces }),
    ])

    return {
      items: sessionPayload?.items || sessions.value,
      workspaces: workspacePayload?.items || workspaces.value,
    }
  }

  function upsertWorkspace(cwd = '') {
    const normalized = String(cwd || '').trim()
    if (!normalized || workspaces.value.includes(normalized)) {
      return
    }
    workspaces.value = [normalized, ...workspaces.value]
  }

  function handleSelectSession(sessionId) {
    const normalizedSessionId = String(sessionId || '').trim()
    if (
      props.sessionSelectionLocked
      && normalizedSessionId
      && normalizedSessionId !== selectedSessionId.value
    ) {
      sessionError.value = props.sessionSelectionLockReason || '该任务已有项目历史，不能再切换项目；如需使用新项目，请新建任务。'
      return
    }

    selectedSessionId.value = normalizedSessionId
  }

  function refreshSessionsForSelection() {
    loadSessionResources({
      forceSessions: true,
      forceWorkspaces: true,
    }).catch(() => {})
  }

  async function handleCreateSession(payload) {
    managerBusy.value = true
    sessionError.value = ''

    try {
      const session = await createCodexSession(payload)
      mergeSession(session)
      upsertWorkspace(session.cwd)
      selectedSessionId.value = session.id
      return session
    } catch (err) {
      sessionError.value = err.message
      throw err
    } finally {
      managerBusy.value = false
    }
  }

  async function handleUpdateSession(sessionId, payload) {
    managerBusy.value = true
    sessionError.value = ''

    try {
      const session = await updateCodexSession(sessionId, payload)
      mergeSession(session)
      upsertWorkspace(session.cwd)
      return session
    } catch (err) {
      sessionError.value = err.message
      throw err
    } finally {
      managerBusy.value = false
    }
  }

  async function handleDeleteSession(sessionId) {
    const targetId = String(sessionId || '').trim()
    if (!targetId) {
      return {
        deletedSessionId: '',
        selectedSessionId: selectedSessionId.value,
      }
    }

    managerBusy.value = true
    sessionError.value = ''

    try {
      await deleteCodexSession(targetId)
      const remainingSessions = sessions.value.filter((session) => session.id !== targetId)
      sessions.value = remainingSessions

      let nextSelectedSessionId = selectedSessionId.value
      if (selectedSessionId.value === targetId) {
        nextSelectedSessionId = sortSessions(remainingSessions, '')[0]?.id || ''
        selectedSessionId.value = nextSelectedSessionId
      }

      return {
        deletedSessionId: targetId,
        selectedSessionId: nextSelectedSessionId,
      }
    } catch (err) {
      sessionError.value = err.message
      throw err
    } finally {
      managerBusy.value = false
    }
  }

  function applyCreatedRun(result = {}) {
    const createdRun = result?.run || null
    const createdSession = result?.session || null

    if (createdSession) {
      mergeSession(createdSession, { preserveRunning: true })
    }

    if (!createdRun?.id) {
      syncRunningStateFromTurns()
      scheduleScrollToBottom({ force: true })
      return
    }

    const mergeRunSession = (session) => {
      mergeSession(session, { preserveRunning: true })
    }
    const nextTurn = createTurnFromRun(createdRun, nextTurnIdValue, nextLogIdValue, mergeRunSession)
    const existingTurnIndex = turns.value.findIndex((turn) => turn.runId === nextTurn.runId)

    if (existingTurnIndex >= 0) {
      const nextTurns = [...turns.value]
      nextTurns.splice(existingTurnIndex, 1, nextTurn)
      turns.value = nextTurns
    } else {
      turns.value = [...turns.value, nextTurn]
    }

    syncRunningStateFromTurns()
    scheduleScrollToBottom({ force: true })
  }

  async function handleSend() {
    if (!props.taskSlug || !hasPrompt.value || sending.value) {
      return false
    }

    if (!selectedSessionId.value) {
      openManager()
      sessionError.value = '请先选择一个 PromptX 项目。'
      return false
    }

    sessionError.value = ''

    try {
      await loadSessionResources({
        forceSessions: true,
      })

      const latestSelectedSession = sessions.value.find((session) => session.id === selectedSessionId.value) || null
      if (!latestSelectedSession) {
        sessionError.value = '当前项目不存在，请重新选择。'
        return false
      }

      if (latestSelectedSession.running) {
        sessionError.value = '当前项目正在运行中，请等待完成后再发送。'
        return false
      }

      const prompt = typeof props.buildPrompt === 'function'
        ? await props.buildPrompt()
        : props.prompt
      const promptBlocks = typeof props.buildPromptBlocks === 'function'
        ? await props.buildPromptBlocks()
        : []

      if (!String(prompt || '').trim()) {
        sessionError.value = '没有可发送的提示词。'
        return false
      }

      const result = await createTaskCodexRun(props.taskSlug, {
        sessionId: selectedSessionId.value,
        prompt,
        promptBlocks,
      })
      applyCreatedRun(result)
      if (typeof props.afterSend === 'function') {
        Promise.resolve(props.afterSend()).catch((err) => {
          console.error('[promptx] afterSend failed', err)
        })
      }

      if (!supportsServerEvents) {
        lastFallbackSessionPollAt = Date.now()
        Promise.all([
          refreshRunHistory({ force: true }),
          loadSessions({ force: true }),
        ]).catch((err) => {
          sessionError.value = err.message
        })
      }
      return true
    } catch (err) {
      sessionError.value = err.message
      return false
    }
  }

  async function stopSending() {
    if (!currentRunningRunId.value) {
      return
    }

    try {
      await stopCodexRun(currentRunningRunId.value)
      if (!supportsServerEvents) {
        lastFallbackSessionPollAt = Date.now()
        await Promise.all([
          refreshRunHistory({ force: true }),
          loadSessions({ force: true }),
        ])
      }
    } catch (err) {
      sessionError.value = err.message
    }
  }

  async function clearTurns() {
    if (!props.taskSlug || sending.value) {
      return
    }

    try {
      await clearTaskCodexRuns(props.taskSlug)
      turns.value = []
      currentRunningRunId.value = ''
      lastRunFingerprint = ''
      stickToBottom = true
      hasNewerMessages.value = false
      scheduleScrollToBottom({ force: true })
    } catch (err) {
      sessionError.value = err.message
    }
  }

  function formatTurnTime(value = '') {
    if (!value) {
      return ''
    }

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return ''
    }

    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  function getProcessCardClass(turn) {
    if (turn.status === 'error') {
      return 'theme-process-error'
    }
    if (turn.status === 'interrupted' || turn.status === 'stopped') {
      return 'theme-process-stopped'
    }
    if (turn.status === 'completed') {
      return 'theme-process-completed'
    }
    return 'theme-process-running'
  }

  function shouldShowResponse(turn) {
    return Boolean(turn.responseMessage || turn.errorMessage || turn.status === 'completed')
  }

  watch(
    sending,
    (value) => {
      if (value) {
        if (!sendingStartedAt.value) {
          sendingStartedAt.value = Date.now()
        }
        startSendingTimer()
      } else {
        clearSendingTimer()
        sendingStartedAt.value = 0
        sendingElapsedSeconds.value = 0
      }
      updatePollingState()
      emit('sending-change', value)
    },
    { immediate: true }
  )

  watch(
    () => props.active,
    (active) => {
      if (active) {
        loadSessionResources({
          forceSessions: true,
        }).catch(() => {})
        refreshRunHistory({ force: true, scrollToLatest: true }).catch(() => {})
        return
      }

      clearServerSyncTimer()
      clearRunPollTimer()
    },
    { immediate: true }
  )

  watch(
    () => props.taskSlug,
    () => {
      runEventLoadPromises.clear()
      turns.value = []
      currentRunningRunId.value = ''
      lastRunFingerprint = ''
      stickToBottom = true
      hasNewerMessages.value = false
      showManager.value = false
      sessionError.value = ''
      if (props.active) {
        refreshRunHistory({ force: true, scrollToLatest: true }).catch(() => {})
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    clearSendingTimer()
    clearRunPollTimer()
    clearServerSyncTimer()
    cancelScheduledScrollToBottom()
    unsubscribeTaskRunEvents?.()
  })

  watch(
    () => realtime.readyVersion.value,
    () => {
      const currentTaskSlug = String(props.taskSlug || '').trim()
      if (!props.active && !showManager.value) {
        return
      }

      if (showManager.value) {
        loadWorkspaces().catch(() => {})
      }

      scheduleServerSync({
        sessions: true,
        runs: Boolean(currentTaskSlug),
      })
    }
  )

  watch(
    () => realtime.sessionsSyncVersion.value,
    () => {
      if (!props.active && !showManager.value) {
        return
      }

      scheduleServerSync({ sessions: true })
    }
  )

  watch(
    () => realtime.getTaskRunSyncVersion(props.taskSlug),
    () => {
      if (!props.active || !props.taskSlug) {
        return
      }

      scheduleServerSync({
        sessions: true,
        runs: true,
      })
    }
  )

  watch(
    () => String(props.taskSlug || '').trim(),
    (taskSlug) => {
      unsubscribeTaskRunEvents?.()
      unsubscribeTaskRunEvents = null

      if (!taskSlug) {
        return
      }

      unsubscribeTaskRunEvents = subscribeTaskRunEvents(taskSlug, ({ runId, event }) => {
        if (!props.active) {
          return
        }

        const applied = applyIncomingRunEvent(runId, event)
        if (!applied) {
          scheduleServerSync({
            sessions: true,
            runs: true,
          })
        }
      })
    },
    { immediate: true }
  )

  return {
    clearTurns,
    closeManager,
    formatTurnTime,
    getProcessCardClass,
    getProcessStatus,
    getTurnAgentLabel,
    getTurnSummaryDetail,
    getDisplayTurnSummaryItems,
    getTurnSummaryStatus,
    handleCreateSession,
    handleDeleteSession,
    handleSelectSession,
    handleSend,
    handleUpdateSession,
    loadTurnEvents,
    hasTurnSummary,
    helperText,
    loading,
    managerBusy,
    openManager,
    refreshSessionsForSelection,
    selectedSessionId,
    sending,
    sessionError,
    shouldShowResponse,
    showManager,
    sortedSessions,
    stopSending,
    hasNewerMessages,
    transcriptRef,
    turns,
    workspaces,
    workingLabel,
    sessions,
    loadSessions,
    handleTranscriptScroll,
    scrollToBottom,
  }
}
