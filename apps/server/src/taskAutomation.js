import crypto from 'node:crypto'
import {
  BLOCK_TYPES,
  TASK_AUTOMATION_CONCURRENCY_POLICIES,
  TASK_NOTIFICATION_CHANNELS,
  TASK_NOTIFICATION_LOCALES,
  TASK_NOTIFICATION_TRIGGERS,
  clampText,
  normalizeTaskNotificationLocale,
} from '../../../packages/shared/src/index.js'

const CRON_FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
]
const SCHEDULER_INTERVAL_MS = 15 * 1000
const MAX_CRON_SCAN_MINUTES = 366 * 24 * 60

function text(locale, zh, en) {
  return normalizeTaskNotificationLocale(locale) === TASK_NOTIFICATION_LOCALES.EN_US ? en : zh
}

function resolveNotificationLocale(task = {}) {
  return normalizeTaskNotificationLocale(task?.notification?.locale)
}

function resolveImageUrl(content = '', rawTaskUrl = '') {
  const value = String(content || '').trim()
  if (!value) {
    return ''
  }
  if (/^https?:\/\//i.test(value)) {
    return value
  }

  try {
    return new URL(value, rawTaskUrl).toString()
  } catch {
    return value
  }
}

export function buildTaskPrompt(task = {}, rawTaskUrl = '') {
  const parts = []

  for (const block of (task.blocks || [])) {
    if (block.type === BLOCK_TYPES.TEXT || block.type === BLOCK_TYPES.IMPORTED_TEXT) {
      const text = String(block.content || '').trim()
      if (text) {
        parts.push(text, '')
      }
      continue
    }

    if (block.type === BLOCK_TYPES.IMAGE) {
      const imageUrl = resolveImageUrl(block.content, rawTaskUrl)
      if (imageUrl) {
        parts.push(imageUrl, '')
      }
    }
  }

  return parts.join('\n').trim()
}

export function buildTaskPromptBlocks(task = {}, rawTaskUrl = '') {
  return (task.blocks || []).map((block) => {
    if (block.type === BLOCK_TYPES.IMAGE) {
      return {
        ...block,
        content: resolveImageUrl(block.content, rawTaskUrl),
      }
    }

    return {
      ...block,
      content: String(block.content || ''),
    }
  })
}

function expandCronPart(part = '', range = {}) {
  const text = String(part || '').trim()
  if (!text) {
    throw new Error('Cron 字段不能为空。')
  }

  const values = new Set()
  const segments = text.split(',').map((item) => item.trim()).filter(Boolean)
  if (!segments.length) {
    throw new Error('Cron 字段不能为空。')
  }

  segments.forEach((segment) => {
    const [base, stepRaw] = segment.split('/')
    const step = stepRaw ? Number(stepRaw) : 1
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`无效的 Cron 步长：${segment}`)
    }

    let start = range.min
    let end = range.max

    if (base && base !== '*') {
      if (base.includes('-')) {
        const [startRaw, endRaw] = base.split('-')
        start = Number(startRaw)
        end = Number(endRaw)
      } else {
        start = Number(base)
        end = Number(base)
      }
    }

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < range.min || end > range.max || start > end) {
      throw new Error(`无效的 Cron 范围：${segment}`)
    }

    for (let value = start; value <= end; value += step) {
      values.add(value)
    }
  })

  return values
}

export function parseCronExpression(expression = '') {
  const parts = String(expression || '').trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) {
    throw new Error('Cron 表达式需要 5 段，例如 `0 9 * * 1-5`。')
  }

  const fields = parts.map((part, index) => ({
    raw: part,
    values: expandCronPart(part, CRON_FIELD_RANGES[index]),
  }))

  return {
    minute: fields[0],
    hour: fields[1],
    dayOfMonth: fields[2],
    month: fields[3],
    dayOfWeek: fields[4],
  }
}

function matchesCron(parsed, date) {
  const minute = date.getMinutes()
  const hour = date.getHours()
  const dayOfMonth = date.getDate()
  const month = date.getMonth() + 1
  const dayOfWeek = date.getDay()

  const minuteMatch = parsed.minute.values.has(minute)
  const hourMatch = parsed.hour.values.has(hour)
  const monthMatch = parsed.month.values.has(month)
  const dayOfMonthMatch = parsed.dayOfMonth.values.has(dayOfMonth)
  const dayOfWeekMatch = parsed.dayOfWeek.values.has(dayOfWeek)
  const domWildcard = parsed.dayOfMonth.raw === '*'
  const dowWildcard = parsed.dayOfWeek.raw === '*'
  const dayMatch = domWildcard && dowWildcard
    ? true
    : domWildcard
      ? dayOfWeekMatch
      : dowWildcard
        ? dayOfMonthMatch
        : (dayOfMonthMatch || dayOfWeekMatch)

  return minuteMatch && hourMatch && monthMatch && dayMatch
}

export function getNextCronOccurrence(expression = '', fromDate = new Date()) {
  const parsed = parseCronExpression(expression)
  const cursor = new Date(fromDate)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  for (let index = 0; index < MAX_CRON_SCAN_MINUTES; index += 1) {
    if (matchesCron(parsed, cursor)) {
      return new Date(cursor)
    }
    cursor.setMinutes(cursor.getMinutes() + 1)
  }

  throw new Error('未能在合理范围内解析到下一次执行时间，请检查 Cron 表达式。')
}

export function normalizeCronExpression(expression = '') {
  const normalized = String(expression || '').trim().replace(/\s+/g, ' ')
  if (!normalized) {
    return ''
  }

  parseCronExpression(normalized)
  return normalized
}

function formatAutomationError(error) {
  return clampText(error?.message || '自动运行失败。', 280)
}

function shouldNotifyRun(task = {}, run = {}) {
  const notification = task.notification || {}
  if (!notification.enabled || !String(notification.webhookUrl || '').trim()) {
    return false
  }

  const trigger = String(notification.triggerOn || TASK_NOTIFICATION_TRIGGERS.COMPLETED).trim()
  const status = String(run.status || '').trim()

  if (trigger === TASK_NOTIFICATION_TRIGGERS.SUCCESS) {
    return status === 'completed' && !String(run.errorMessage || '').trim()
  }

  if (trigger === TASK_NOTIFICATION_TRIGGERS.ERROR) {
    return status === 'error' || status === 'stop_timeout'
  }

  return ['completed', 'error', 'stopped', 'interrupted', 'stop_timeout'].includes(status)
}

function summarizeRunMessage(run = {}) {
  const locale = resolveNotificationLocale(run?.task || {})
  const errorMessage = String(run.errorMessage || '').trim()
  if (errorMessage) {
    return errorMessage
  }

  const response = String(run.responseMessage || '').trim()
  if (response) {
    return response
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 1200)
  }

  if (String(run.status || '') === 'stopped') {
    return text(locale, '本次运行已停止。', 'This run was stopped.')
  }

  return text(locale, '本次运行已结束，没有额外返回内容。', 'This run finished without any additional response.')
}

function getRunStatusLabel(run = {}, locale = TASK_NOTIFICATION_LOCALES.ZH_CN) {
  switch (String(run.status || '').trim()) {
    case 'completed':
      return text(locale, '成功', 'Completed')
    case 'error':
      return text(locale, '失败', 'Failed')
    case 'stopped':
      return text(locale, '已停止', 'Stopped')
    case 'interrupted':
      return text(locale, '已中断', 'Interrupted')
    default:
      return text(locale, '已结束', 'Finished')
  }
}

function buildNotificationSummary(task = {}, run = {}, options = {}) {
  const locale = resolveNotificationLocale(task)
  const taskTitle = String(task.displayTitle || task.title || task.autoTitle || task.slug || text(locale, '未命名任务', 'Untitled Task')).trim()
  const projectTitle = String(options.projectTitle || '').trim()
  const statusLabel = getRunStatusLabel(run, locale)
  const engineLabel = String(run.engine || task?.engine || 'codex').trim()
  const summary = summarizeRunMessage({ ...run, task })
  const lines = [
    `${text(locale, '任务', 'Task')}: ${taskTitle}`,
    ...(projectTitle ? [`${text(locale, '项目', 'Project')}: ${projectTitle}`] : []),
    `${text(locale, '状态', 'Status')}: ${statusLabel}`,
    `${text(locale, '引擎', 'Engine')}: ${engineLabel}`,
    `${text(locale, '时间', 'Time')}: ${new Date(run.finishedAt || run.updatedAt || Date.now()).toLocaleString(locale)}`,
    '',
    summary,
  ]

  if (options.detailUrl) {
    lines.push('', `${text(locale, '详情', 'Details')}: ${options.detailUrl}`)
  }

  return {
    title: text(locale, `PromptX 任务通知｜${taskTitle}`, `PromptX Task Notification | ${taskTitle}`),
    text: lines.join('\n').trim(),
    summary,
    locale,
  }
}

function getFeishuCardHeaderTemplate(run = {}) {
  const status = String(run.status || '').trim().toLowerCase()

  if (status === 'completed' || status === 'success') {
    return 'green'
  }

  if (status === 'running' || status === 'queued' || status === 'pending') {
    return 'blue'
  }

  return 'red'
}

function formatFeishuNotificationTime(value, locale = TASK_NOTIFICATION_LOCALES.ZH_CN) {
  const target = new Date(value || Date.now())
  if (Number.isNaN(target.getTime())) {
    return ''
  }

  const normalizedLocale = locale === TASK_NOTIFICATION_LOCALES.EN_US ? 'en-CA' : 'sv-SE'
  return target
    .toLocaleString(normalizedLocale, {
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
    .replace(',', '')
}

function normalizeNotificationLines(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function stripListMarker(line = '') {
  return String(line || '').replace(/^(\d+[\.\)]|[-*•])\s*/, '').trim()
}

function isLikelySectionTitle(line = '') {
  const value = String(line || '').trim()
  return /^(摘要|总结|概览|结果|变更|修改|更新|风险|问题|异常|错误|告警|下一步|建议|说明|Summary|Overview|Result|Changes|Risks?|Warnings?|Errors?|Next Steps?)[:：]?$/i.test(value)
}

function getFeishuSectionTitle(key, locale = TASK_NOTIFICATION_LOCALES.ZH_CN) {
  switch (key) {
    case 'summary':
      return text(locale, '摘要', 'Summary')
    case 'changes':
      return text(locale, '变更', 'Changes')
    case 'risks':
      return text(locale, '风险', 'Risks')
    case 'nextSteps':
      return text(locale, '下一步', 'Next Steps')
    case 'validation':
      return text(locale, '验证', 'Validation')
    default:
      return ''
  }
}

function buildFeishuSectionMarkdown(title, items = [], { bullet = false } = {}) {
  const normalizedItems = Array.isArray(items)
    ? items.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  if (!normalizedItems.length) {
    return ''
  }

  const body = bullet
    ? normalizedItems.map((item) => `- ${item}`).join('\n')
    : normalizedItems.join('\n\n')

  return `**${title}**\n${body}`
}

function parseFeishuSummarySections(summary = '', run = {}, locale = TASK_NOTIFICATION_LOCALES.ZH_CN) {
  const lines = normalizeNotificationLines(summary)
  const sections = {
    summary: [],
    changes: [],
    risks: [],
    nextSteps: [],
    validation: [],
  }
  let currentSection = 'summary'

  for (const line of lines) {
    const rawLine = String(line || '').trim()
    const normalizedLine = stripListMarker(line)
    const lowerLine = normalizedLine.toLowerCase()
    const isBulletLine = /^(\d+[\.\)]|[-*•])\s*/.test(rawLine)

    if (isLikelySectionTitle(normalizedLine)) {
      if (/^(变更|修改|更新|Changes?)$/i.test(normalizedLine)) {
        currentSection = 'changes'
      } else if (/^(风险|问题|异常|错误|告警|Risks?|Warnings?|Errors?)$/i.test(normalizedLine)) {
        currentSection = 'risks'
      } else if (/^(下一步|建议|Next Steps?)$/i.test(normalizedLine)) {
        currentSection = 'nextSteps'
      } else {
        currentSection = 'summary'
      }
      continue
    }

    if (/^(下一步|建议|todo|next step|next steps?)[:：]?$/i.test(normalizedLine)) {
      currentSection = 'nextSteps'
      continue
    }

    if (/^(下一步|建议|todo|next step|next steps?)[:：]?\s*/i.test(normalizedLine)) {
      currentSection = 'nextSteps'
      const content = normalizedLine.replace(/^(下一步|建议|todo|next step|next steps?)[:：]?\s*/i, '').trim()
      if (content) {
        sections.nextSteps.push(content)
      }
      continue
    }

    if (/^(风险|问题|异常|错误|告警|risk|warning|error)[:：]?$/i.test(normalizedLine)) {
      currentSection = 'risks'
      continue
    }

    if (/^(风险|问题|异常|错误|告警|risk|warning|error)[:：]?\s*/i.test(normalizedLine)) {
      currentSection = 'risks'
      const content = normalizedLine.replace(/^(风险|问题|异常|错误|告警|risk|warning|error)[:：]?\s*/i, '').trim()
      if (content) {
        sections.risks.push(content)
      }
      continue
    }

    if (/^(变更|修改|更新|changes?)[:：]?$/i.test(normalizedLine)) {
      currentSection = 'changes'
      continue
    }

    if (/^(变更|修改|更新|changes?)[:：]?\s*/i.test(normalizedLine)) {
      currentSection = 'changes'
      const content = normalizedLine.replace(/^(变更|修改|更新|changes?)[:：]?\s*/i, '').trim()
      if (content) {
        sections.changes.push(content)
      }
      continue
    }

    if (/^(摘要|总结|概览|结果|summary|overview|result)[:：]?$/i.test(normalizedLine)) {
      currentSection = 'summary'
      continue
    }

    if (/^(摘要|总结|概览|结果|summary|overview|result)[:：]?\s*/i.test(normalizedLine)) {
      currentSection = 'summary'
      const content = normalizedLine.replace(/^(摘要|总结|概览|结果|summary|overview|result)[:：]?\s*/i, '').trim()
      if (content) {
        sections.summary.push(content)
      }
      continue
    }

    if (/^(验证|验证已做|检查结果|validation|checks?)[:：]?$/i.test(normalizedLine)) {
      currentSection = 'validation'
      continue
    }

    if (/^(验证|验证已做|检查结果|validation|checks?)[:：]?\s*/i.test(normalizedLine)) {
      currentSection = 'validation'
      const content = normalizedLine.replace(/^(验证|验证已做|检查结果|validation|checks?)[:：]?\s*/i, '').trim()
      if (content) {
        sections.validation.push(content)
      }
      continue
    }

    if (/^(这次调整的效果|这次调整的效果是|处理结果|完成情况|本次变更|影响范围)[:：]?$/i.test(normalizedLine)) {
      currentSection = 'changes'
      continue
    }

    if (/(失败|错误|异常|中断|超时|warning|warn|error|failed|exception|timeout)/i.test(lowerLine)) {
      sections.risks.push(normalizedLine)
      continue
    }

    if (/^(新增|增加|修改|更新|删除|修复|优化|Added|Updated|Removed|Fixed|Improved)\b/i.test(normalizedLine)) {
      sections.changes.push(normalizedLine)
      continue
    }

    if (isBulletLine && currentSection !== 'summary') {
      sections[currentSection].push(normalizedLine)
      continue
    }

    if (sections.summary.length === 0) {
      sections.summary.push(normalizedLine)
      continue
    }

    if (currentSection !== 'summary') {
      sections[currentSection].push(normalizedLine)
      continue
    }

    sections.summary.push(normalizedLine)
  }

  if (!sections.summary.length) {
    if (hasEndedStatus(run)) {
      sections.summary.push(summarizeRunMessage({ ...run, task: run.task }))
    } else {
      sections.summary.push(text(locale, '本次运行已结束。', 'This run has finished.'))
    }
  }

  return sections
}

function buildFeishuNotificationCard(task = {}, run = {}, options = {}) {
  const locale = resolveNotificationLocale(task)
  const taskTitle = String(task.displayTitle || task.title || task.autoTitle || task.slug || text(locale, '未命名任务', 'Untitled Task')).trim()
  const projectTitle = String(options.projectTitle || '').trim()
  const statusLabel = getRunStatusLabel(run, locale)
  const engineLabel = String(run.engine || task?.engine || 'codex').trim()
  const finishedAt = formatFeishuNotificationTime(run.finishedAt || run.updatedAt || Date.now(), locale)
  const summary = summarizeRunMessage({ ...run, task })
  const summarySections = parseFeishuSummarySections(summary, { ...run, task }, locale)
  const detailUrl = String(options.detailUrl || '').trim()
  const headerTemplate = getFeishuCardHeaderTemplate(run)
  const detailLabel = text(locale, '打开任务', 'Open task')
  const metaFields = [
    {
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**${text(locale, '状态', 'Status')}**\n${statusLabel}`,
      },
    },
    {
      is_short: true,
      text: {
        tag: 'lark_md',
        content: `**${text(locale, '引擎', 'Engine')}**\n${engineLabel}`,
      },
    },
    ...(projectTitle
      ? [{
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**${text(locale, '项目', 'Project')}**\n${projectTitle}`,
          },
        }]
      : []),
  ]

  return {
    config: {
      wide_screen_mode: true,
      enable_forward: true,
    },
    header: {
      template: headerTemplate,
      title: {
        tag: 'plain_text',
        content: text(locale, 'PromptX 任务通知', 'PromptX Task Notification'),
      },
    },
    elements: [
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: `**${text(locale, '任务', 'Task')}**\n${taskTitle}`,
        },
      },
      {
        tag: 'div',
        fields: metaFields,
      },
      {
        tag: 'note',
        elements: [
          {
            tag: 'plain_text',
            content: `${text(locale, '时间', 'Time')}：${finishedAt}`,
          },
        ],
      },
      {
        tag: 'hr',
      },
      {
        tag: 'div',
        text: {
          tag: 'lark_md',
          content: buildFeishuSectionMarkdown(
            getFeishuSectionTitle('summary', locale),
            summarySections.summary
          ),
        },
      },
      ...(summarySections.changes.length
        ? [{
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: buildFeishuSectionMarkdown(
                getFeishuSectionTitle('changes', locale),
                summarySections.changes,
                { bullet: true }
              ),
            },
          }]
        : []),
      ...(summarySections.risks.length
        ? [{
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: buildFeishuSectionMarkdown(
                getFeishuSectionTitle('risks', locale),
                summarySections.risks,
                { bullet: true }
              ),
            },
          }]
        : []),
      ...(summarySections.nextSteps.length
        ? [{
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: buildFeishuSectionMarkdown(
                getFeishuSectionTitle('nextSteps', locale),
                summarySections.nextSteps,
                { bullet: true }
              ),
            },
          }]
        : []),
      ...(summarySections.validation.length
        ? [{
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: buildFeishuSectionMarkdown(
                getFeishuSectionTitle('validation', locale),
                summarySections.validation,
                { bullet: true }
              ),
            },
          }]
        : []),
      ...(detailUrl
        ? [{
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: {
                  tag: 'plain_text',
                  content: detailLabel,
                },
                type: 'primary',
                url: detailUrl,
              },
            ],
          }]
        : []),
    ],
  }
}

function appendSignedQuery(url, secret = '') {
  const targetUrl = String(url || '').trim()
  if (!secret) {
    return targetUrl
  }

  const timestamp = Date.now().toString()
  const stringToSign = `${timestamp}\n${secret}`
  const sign = encodeURIComponent(
    crypto
      .createHmac('sha256', secret)
      .update(stringToSign)
      .digest('base64')
  )

  const target = new URL(targetUrl)
  target.searchParams.set('timestamp', timestamp)
  target.searchParams.set('sign', sign)
  return target.toString()
}

function buildNotificationRequest(task = {}, run = {}, options = {}) {
  const notification = task.notification || {}
  const summary = buildNotificationSummary(task, run, options)
  const channelType = String(notification.channelType || TASK_NOTIFICATION_CHANNELS.DINGTALK).trim()
  const secret = String(notification.secret || '').trim()

  if (channelType === TASK_NOTIFICATION_CHANNELS.FEISHU) {
    const payload = {
      msg_type: 'interactive',
      card: buildFeishuNotificationCard(task, run, options),
    }

    if (secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const stringToSign = `${timestamp}\n${secret}`
      payload.timestamp = timestamp
      payload.sign = crypto
        .createHmac('sha256', stringToSign)
        .digest('base64')
    }

    return {
      url: notification.webhookUrl,
      payload,
    }
  }

  if (channelType === TASK_NOTIFICATION_CHANNELS.WEBHOOK) {
    return {
      url: notification.webhookUrl,
      payload: {
        task: {
          slug: task.slug,
          title: summary.title,
          projectTitle: String(options.projectTitle || '').trim(),
        },
        run: {
          id: run.id,
          status: run.status,
          engine: run.engine,
          finishedAt: run.finishedAt || run.updatedAt || '',
        },
        message: summary.text,
      },
    }
  }

  return {
    url: appendSignedQuery(notification.webhookUrl, secret),
    payload: {
      msgtype: 'markdown',
      markdown: {
        title: summary.title,
        text: summary.text,
      },
    },
  }
}

async function postNotification(requestOptions = {}, locale = TASK_NOTIFICATION_LOCALES.ZH_CN) {
  const response = await fetch(requestOptions.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestOptions.payload),
  })

  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(text(
      locale,
      `Webhook 返回 ${response.status}：${bodyText.slice(0, 200)}`,
      `Webhook returned ${response.status}: ${bodyText.slice(0, 200)}`
    ))
  }

  try {
    const payload = JSON.parse(bodyText)
    const businessCode = Number(payload?.code)
    const statusCode = Number(payload?.StatusCode)
    const errCode = Number(payload?.errcode)
    const message = String(
      payload?.msg
      || payload?.StatusMessage
      || payload?.errmsg
      || ''
    ).trim()

    if (Number.isFinite(businessCode) && businessCode !== 0) {
      throw new Error(message || text(locale, `Webhook 业务返回异常：code=${businessCode}`, `Webhook business response error: code=${businessCode}`))
    }
    if (Number.isFinite(statusCode) && statusCode !== 0) {
      throw new Error(message || text(locale, `Webhook 业务返回异常：StatusCode=${statusCode}`, `Webhook business response error: StatusCode=${statusCode}`))
    }
    if (Number.isFinite(errCode) && errCode !== 0) {
      throw new Error(message || text(locale, `Webhook 业务返回异常：errcode=${errCode}`, `Webhook business response error: errcode=${errCode}`))
    }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return bodyText.slice(0, 500)
    }
    throw error
  }

  return bodyText.slice(0, 500)
}

export function createTaskAutomationService(options = {}) {
  const {
    logger,
    getRunningCodexRunByTaskSlug = () => null,
    listAutomationEnabledTasks = () => [],
    updateTaskAutomationRuntime = () => null,
    updateTaskNotificationDelivery = () => null,
    createTaskRun = async () => null,
    getPromptxCodexSessionById = () => null,
    getTaskBySlug = () => null,
    getRunById = () => null,
    detailUrlBuilder = () => '',
  } = options

  let timer = null
  let ticking = false
  const processingTaskSlugs = new Set()
  const notifyingRunIds = new Set()

  async function triggerAutomationRun(task = {}) {
    const taskSlug = String(task.slug || '').trim()
    if (!taskSlug || processingTaskSlugs.has(taskSlug)) {
      return
    }

    processingTaskSlugs.add(taskSlug)
    const now = new Date()

    try {
      const cron = normalizeCronExpression(task?.automation?.cron || '')
      const nextTriggerAt = getNextCronOccurrence(cron, now).toISOString()
      const runningRun = getRunningCodexRunByTaskSlug(taskSlug)
      if (runningRun && task?.automation?.concurrencyPolicy === TASK_AUTOMATION_CONCURRENCY_POLICIES.SKIP) {
        updateTaskAutomationRuntime(taskSlug, {
          nextTriggerAt,
        })
        return
      }

      const sessionId = String(task.codexSessionId || '').trim()
      if (!sessionId) {
        updateTaskAutomationRuntime(taskSlug, {
          nextTriggerAt,
        })
        logger?.warn?.({ taskSlug }, '[automation] 未配置项目，跳过本次自动运行')
        return
      }

      const rawTaskUrl = detailUrlBuilder(taskSlug, { raw: true })
      const prompt = buildTaskPrompt(task, rawTaskUrl)
      const promptBlocks = buildTaskPromptBlocks(task, rawTaskUrl)
      if (!prompt) {
        updateTaskAutomationRuntime(taskSlug, {
          nextTriggerAt,
        })
        logger?.warn?.({ taskSlug }, '[automation] 任务内容为空，跳过本次自动运行')
        return
      }

      await createTaskRun({
        taskSlug,
        sessionId,
        prompt,
        promptBlocks,
      })

      updateTaskAutomationRuntime(taskSlug, {
        lastTriggeredAt: now.toISOString(),
        nextTriggerAt,
      })
      logger?.info?.({ taskSlug, nextTriggerAt }, '[automation] 已触发自动运行')
    } catch (error) {
      let fallbackNextTriggerAt = ''
      try {
        fallbackNextTriggerAt = getNextCronOccurrence(task?.automation?.cron || '', now).toISOString()
      } catch {
        fallbackNextTriggerAt = ''
      }
      updateTaskAutomationRuntime(taskSlug, {
        nextTriggerAt: fallbackNextTriggerAt,
      })
      logger?.error?.({ taskSlug, error: formatAutomationError(error) }, '[automation] 自动运行失败')
    } finally {
      processingTaskSlugs.delete(taskSlug)
    }
  }

  async function tick() {
    if (ticking) {
      return
    }

    ticking = true
    try {
      const now = new Date()
      const tasks = listAutomationEnabledTasks(200)

      for (const task of tasks) {
        const cron = String(task?.automation?.cron || '').trim()
        if (!cron) {
          continue
        }

        let nextTriggerAt = String(task?.automation?.nextTriggerAt || '').trim()
        try {
          if (!nextTriggerAt) {
            nextTriggerAt = getNextCronOccurrence(cron, now).toISOString()
            updateTaskAutomationRuntime(task.slug, { nextTriggerAt })
            continue
          }

          if (Date.parse(nextTriggerAt) > now.getTime()) {
            continue
          }

          await triggerAutomationRun(task)
        } catch (error) {
          logger?.error?.({ taskSlug: task.slug, error: formatAutomationError(error) }, '[automation] Cron 解析失败')
          const fallbackNextTriggerAt = ''
          updateTaskAutomationRuntime(task.slug, { nextTriggerAt: fallbackNextTriggerAt })
        }
      }
    } finally {
      ticking = false
    }
  }

  async function notifyRun(taskSlug = '', runId = '') {
    const normalizedTaskSlug = String(taskSlug || '').trim()
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedTaskSlug || !normalizedRunId || notifyingRunIds.has(normalizedRunId)) {
      return
    }

    const task = getTaskBySlug(normalizedTaskSlug)
    const run = getRunById(normalizedRunId)
    if (!task || !run || !shouldNotifyRun(task, run)) {
      return
    }

    notifyingRunIds.add(normalizedRunId)
    try {
      const session = getPromptxCodexSessionById(task.codexSessionId)
      const requestOptions = buildNotificationRequest(task, run, {
        detailUrl: detailUrlBuilder(task.slug),
        projectTitle: session?.title || '',
      })
      await postNotification(requestOptions, resolveNotificationLocale(task))
      updateTaskNotificationDelivery(task.slug, {
        lastStatus: 'success',
        lastError: '',
        lastSentAt: new Date().toISOString(),
      })
      logger?.info?.({ taskSlug: task.slug, runId: run.id }, '[automation] 已发送运行通知')
    } catch (error) {
      const locale = resolveNotificationLocale(task)
      updateTaskNotificationDelivery(task.slug, {
        lastStatus: 'error',
        lastError: clampText(error?.message || text(locale, '消息发送失败。', 'Failed to send the notification.'), 500),
        lastSentAt: new Date().toISOString(),
      })
      logger?.error?.({ taskSlug: task.slug, runId: run.id, error: error?.message || '' }, '[automation] 发送运行通知失败')
    } finally {
      notifyingRunIds.delete(normalizedRunId)
    }
  }

  function start() {
    if (timer) {
      return
    }

    timer = setInterval(() => {
      tick().catch(() => {})
    }, SCHEDULER_INTERVAL_MS)
    timer.unref?.()
    tick().catch(() => {})
  }

  function stop() {
    if (!timer) {
      return
    }

    clearInterval(timer)
    timer = null
  }

  return {
    notifyRun,
    start,
    stop,
    tick,
  }
}
