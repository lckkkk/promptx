import {
  AGENT_RUN_ENVELOPE_EVENT_TYPES,
  AGENT_RUN_EVENT_TYPES,
  AGENT_RUN_ITEM_TYPES,
  normalizeAgentRunEnvelopeEventType,
} from '@promptx/shared'
import { resolveAssetUrl } from '../lib/api.js'
import { getAgentEngineLabel, normalizeAgentEngine } from '../lib/agentEngines.js'

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

export function findTurnByRunId(turnList = [], runId = '') {
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

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_STARTED) {
    summary.currentActivity = '正在分析任务'
    summary.latestActivity = `${agentLabel} 开始执行`
    summary.latestDetail = ''
    return
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_COMPLETED) {
    summary.currentActivity = ''
    summary.waitingAgentCount = 0
    summary.latestActivity = `${agentLabel} 执行完成`
    summary.latestDetail = ''
    return
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_FAILED) {
    summary.currentActivity = ''
    summary.waitingAgentCount = 0
    summary.latestActivity = '本轮运行失败'
    summary.latestDetail = ''
    return
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ERROR) {
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

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_STARTED) {
    if (item.type === AGENT_RUN_ITEM_TYPES.REASONING) {
      summary.currentActivity = '正在思考'
      summary.latestActivity = '正在思考'
      summary.latestDetail = summarizeText(item.text, 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
      summary.currentActivity = '正在执行命令'
      summary.latestActivity = '开始执行命令'
      summary.latestDetail = summarizeText(item.command, 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
      summary.currentActivity = item.action?.type === 'open_page' ? '正在打开网页' : '正在搜索网页'
      summary.latestActivity = summary.currentActivity
      summary.latestDetail = summarizeText(item.action?.type === 'open_page' ? (item.action?.url || item.query) : (item.query || item.action?.query), 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
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

    if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
      summary.currentActivity = '正在整理文件变更'
      summary.latestActivity = '正在整理文件变更'
      summary.latestDetail = summarizeText((item.changes || []).map((change) => change?.path).filter(Boolean).join('，'), 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
      summary.currentActivity = '正在规划执行步骤'
      summary.latestActivity = '正在规划执行步骤'
      summary.latestDetail = summarizeText((item.items || []).map((entry) => entry?.text).filter(Boolean).join('；'), 120)
    }
    return
  }

  if (eventType !== AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED) {
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
    summary.commandCount += 1
    summary.currentActivity = ''
    summary.latestActivity = '命令执行完成'
    summary.latestDetail = summarizeText(item.command, 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
    summary.webSearchCount += 1
    summary.currentActivity = ''
    summary.latestActivity = item.action?.type === 'open_page' ? '已打开网页' : '已搜索网页'
    summary.latestDetail = summarizeText(item.action?.type === 'open_page' ? (item.action?.url || item.query) : (item.query || item.action?.query), 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
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

  if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
    const changes = Array.isArray(item.changes) ? item.changes : []
    summary.fileChangeCount += changes.length
    summary.currentActivity = ''
    summary.latestActivity = changes.length ? `已记录 ${changes.length} 个文件改动` : '已记录文件改动'
    summary.latestDetail = summarizeText(changes.map((change) => change?.path).filter(Boolean).join('，'), 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
    summary.currentActivity = ''
    summary.latestActivity = '待办列表已更新'
    summary.latestDetail = summarizeText((item.items || []).map((entry) => entry?.text).filter(Boolean).join('；'), 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE) {
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

  if (eventType === AGENT_RUN_EVENT_TYPES.THREAD_STARTED) {
    return {
      title: `${agentLabel} 会话已创建`,
      detail: event.thread_id ? `线程 ID: ${event.thread_id}` : '',
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_STARTED) {
    return { title: `${agentLabel} 开始执行`, detail: '' }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_COMPLETED) {
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

  if (eventType === AGENT_RUN_EVENT_TYPES.ERROR || eventType === AGENT_RUN_EVENT_TYPES.TURN_FAILED) {
    const rawMessage = extractCodexEventErrorText(event) || `${agentLabel} 执行失败`
    const retrying = eventType === AGENT_RUN_EVENT_TYPES.ERROR ? parseCodexRetryMessage(rawMessage) : null
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
      title: issue?.title || (eventType === AGENT_RUN_EVENT_TYPES.TURN_FAILED ? '本轮运行失败' : `${agentLabel} 返回错误`),
      detail: formatCodexIssueMessage(rawMessage, engine),
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_STARTED) {
    if (item.type === AGENT_RUN_ITEM_TYPES.REASONING) {
      return {
        kind: 'info',
        title: '正在思考',
        detail: item.text || '',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
      return formatWebSearchEvent(item, 'started')
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
      return formatCollabToolEvent(item, 'started')
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
      return formatFileChangeEvent(item, 'started')
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
      return {
        kind: 'command',
        title: '开始执行命令',
        detail: item.command || '',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
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

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_UPDATED && item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
    return {
      kind: 'todo',
      title: '更新待办列表',
      detail: formatTodoItems(item.items),
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED) {
    if (item.type === AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE && item.text) {
      return {
        kind: 'result',
        title: `${agentLabel} 已返回结果`,
        detail: '',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
      return formatWebSearchEvent(item, 'completed')
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
      return formatCollabToolEvent(item, 'completed')
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
      return formatFileChangeEvent(item, 'completed')
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
      const success = item.exit_code === 0 || item.status === 'completed'
      return {
        kind: success ? 'command' : 'error',
        title: success ? '命令执行完成' : `命令执行失败(exit ${item.exit_code ?? '?'})`,
        detail: [item.command, formatCommandOutput(item.aggregated_output)].filter(Boolean).join('\n\n'),
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
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
  const envelopeType = normalizeAgentRunEnvelopeEventType(payload.type)

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.SESSION) {
    mergeSession(payload.session)
    turn.engine = getTurnAgentEngine(payload.session || turn)
    appendTurnEvent(turn, {
      title: `已连接项目：${payload.session?.title || '未命名项目'}`,
      detail: payload.session?.cwd ? `工作目录：${payload.session.cwd}` : '',
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.SESSION_UPDATED) {
    mergeSession(payload.session)
    turn.engine = getTurnAgentEngine(payload.session || turn)
    appendTurnEvent(turn, {
      title: '项目会话已更新',
      detail: payload.session?.started ? '后续请求会继续复用当前项目的执行引擎会话。' : '',
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STATUS) {
    if (payload.stage === 'starting' || payload.stage === 'resuming') {
      return
    }

    appendTurnEvent(turn, {
      title: payload.message || '状态已更新',
      detail: '',
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STDERR) {
    const issue = classifyCodexIssue(payload.text, turn.engine)
    appendTurnEvent(turn, {
      kind: 'error',
      title: issue?.title || 'stderr',
      detail: formatCodexIssueMessage(payload.text, turn.engine),
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STDOUT) {
    appendTurnEvent(turn, {
      kind: 'command',
      title: 'stdout',
      detail: payload.text,
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.AGENT_EVENT) {
    syncTurnSummaryFromCodexEvent(turn, payload.event)
    const formattedEvent = formatCodexEvent(payload.event, getTurnAgentLabel(turn), turn.engine)
    if (String(formattedEvent.title || '').startsWith('网络异常，正在重试')) {
      upsertRetryingEvent(turn, formattedEvent, nextLogId)
    } else {
      appendTurnEvent(turn, formattedEvent, nextLogId)
    }
    if (payload.event?.type === AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED && payload.event?.item?.type === AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE && payload.event?.item?.text) {
      turn.responseMessage = payload.event.item.text
    }
    const message = extractCodexEventErrorText(payload.event) || `${getTurnAgentLabel(turn)} 执行失败`
    const retrying = payload.event?.type === 'error' ? parseCodexRetryMessage(message) : null
    if (!retrying && (payload.event?.type === AGENT_RUN_EVENT_TYPES.ERROR || payload.event?.type === AGENT_RUN_EVENT_TYPES.TURN_FAILED)) {
      const message = extractCodexEventErrorText(payload.event) || `${getTurnAgentLabel(turn)} 执行失败`
      turn.errorMessage = formatCodexIssueMessage(message, turn.engine)
      turn.status = 'error'
    }
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.COMPLETED) {
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

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STOPPED) {
    appendTurnEvent(turn, {
      title: payload.message || '执行已手动停止',
      detail: '',
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.ERROR) {
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

  const envelopeType = normalizeAgentRunEnvelopeEventType(payload.type)

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.COMPLETED) {
    turn.status = 'completed'
    turn.finishedAt = new Date().toISOString()
  } else if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STOPPED) {
    turn.status = 'stopped'
    turn.errorMessage = ''
    turn.finishedAt = new Date().toISOString()
  } else if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.ERROR) {
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
