import { customAlphabet } from 'nanoid'
import {
  BLOCK_TYPES,
  TASK_AUTOMATION_CONCURRENCY_POLICIES,
  TASK_NOTIFICATION_CHANNELS,
  TASK_NOTIFICATION_MESSAGE_MODES,
  TASK_NOTIFICATION_TRIGGERS,
  buildRawTaskText,
  clampText,
  deriveTitleFromBlocks,
  getExpiryValue,
  normalizeTaskAutomationConcurrencyPolicy,
  normalizeTaskAutomationTimezone,
  normalizeTaskNotificationChannel,
  normalizeTaskNotificationLocale,
  normalizeTaskNotificationMessageMode,
  normalizeTaskNotificationTrigger,
  normalizeExpiry,
  normalizeVisibility,
  resolveExpiresAt,
  slugifyTitle,
  summarizeTask,
} from '../../../packages/shared/src/index.js'
import { all, get, run, transaction } from './db.js'
import { readStoredSystemConfig, writeStoredSystemConfig } from './systemConfig.js'
import { getNextCronOccurrence, normalizeCronExpression } from './taskAutomation.js'

const slugTail = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 6)
const tokenId = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 20)

function toNotificationProfile(row) {
  if (!row) {
    return null
  }

  return {
    id: Number(row.id),
    name: String(row.name || '').trim(),
    channelType: normalizeTaskNotificationChannel(row.channel_type),
    webhookUrl: String(row.webhook_url || ''),
    secret: String(row.secret || ''),
    triggerOn: normalizeTaskNotificationTrigger(row.trigger_on),
    locale: normalizeTaskNotificationLocale(row.locale),
    messageMode: normalizeTaskNotificationMessageMode(row.message_mode),
    createdAt: String(row.created_at || ''),
    updatedAt: String(row.updated_at || ''),
  }
}

function resolveTaskNotification(row, profile = null) {
  const profileId = Number(row.notification_profile_id) || null
  const resolvedProfile = profile && Number(profile.id) === profileId ? profile : null
  const enabled = Boolean(Number(row.notification_enabled) || 0)
  const channelType = resolvedProfile
    ? resolvedProfile.channelType
    : normalizeTaskNotificationChannel(row.notification_channel_type)
  const webhookUrl = resolvedProfile
    ? String(resolvedProfile.webhookUrl || '')
    : String(row.notification_webhook_url || '')
  const secret = resolvedProfile
    ? String(resolvedProfile.secret || '')
    : String(row.notification_secret || '')
  const triggerOn = resolvedProfile
    ? normalizeTaskNotificationTrigger(resolvedProfile.triggerOn)
    : normalizeTaskNotificationTrigger(row.notification_trigger_on)
  const locale = resolvedProfile
    ? normalizeTaskNotificationLocale(resolvedProfile.locale)
    : normalizeTaskNotificationLocale(row.notification_locale)
  const messageMode = resolvedProfile
    ? normalizeTaskNotificationMessageMode(resolvedProfile.messageMode)
    : normalizeTaskNotificationMessageMode(row.notification_message_mode)

  return {
    enabled: enabled && Boolean(profileId || webhookUrl),
    profileId,
    profileName: resolvedProfile?.name || '',
    profile: resolvedProfile
      ? {
          id: resolvedProfile.id,
          name: resolvedProfile.name,
        }
      : null,
    channelType,
    webhookUrl,
    secret,
    triggerOn,
    locale,
    messageMode,
    lastStatus: String(row.notification_last_status || ''),
    lastError: String(row.notification_last_error || ''),
    lastSentAt: String(row.notification_last_sent_at || ''),
  }
}

function toBlock(row) {
  return {
    id: Number(row.id),
    type: row.type,
    content: row.content,
    sortOrder: Number(row.sort_order),
    meta: JSON.parse(row.meta_json || '{}'),
  }
}

function toTask(row, blocks = [], options = {}) {
  const codexRunCount = Math.max(0, Number(options.codexRunCount) || 0)
  const displayTitle = row.title || row.auto_title || deriveTitleFromBlocks(blocks)
  const notification = resolveTaskNotification(row, options.notificationProfile || null)
  return {
    id: Number(row.id),
    slug: row.slug,
    sortOrder: Number(row.sort_order) || 0,
    title: row.title,
    autoTitle: row.auto_title || '',
    lastPromptPreview: row.last_prompt_preview || '',
    codexSessionId: row.codex_session_id || '',
    displayTitle,
    visibility: row.visibility,
    expiresAt: row.expires_at,
    expiry: getExpiryValue(row.expires_at),
    codexRunCount,
    automation: {
      enabled: Boolean(Number(row.automation_enabled) || 0),
      cron: String(row.automation_cron || ''),
      timezone: normalizeTaskAutomationTimezone(row.automation_timezone),
      concurrencyPolicy: normalizeTaskAutomationConcurrencyPolicy(row.automation_concurrency_policy),
      lastTriggeredAt: String(row.automation_last_triggered_at || ''),
      nextTriggerAt: String(row.automation_next_trigger_at || ''),
    },
    notification,
    latestCompletedRunFinishedAt: String(row.latest_completed_run_finished_at || ''),
    unread: Boolean(row.unread),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blocks,
    todoItems: parseTaskTodoItems(row.todo_items_json),
  }
}

function mapTaskAutomationSummary(row) {
  return {
    enabled: Boolean(Number(row.automation_enabled) || 0),
    cron: String(row.automation_cron || ''),
    nextTriggerAt: String(row.automation_next_trigger_at || ''),
  }
}

function mapTaskNotificationSummary(row) {
  const notification = resolveTaskNotification(row)
  return {
    enabled: notification.enabled,
    profileId: notification.profileId,
    profileName: notification.profileName,
    channelType: notification.channelType,
    triggerOn: notification.triggerOn,
    locale: notification.locale,
    lastStatus: notification.lastStatus,
    lastSentAt: notification.lastSentAt,
  }
}

function normalizeAutomationInput(input = {}, fallback = {}) {
  const enabled = Boolean(input?.enabled)
  const cron = enabled ? normalizeCronExpression(clampText(input?.cron || '', 80).trim()) : ''
  let nextTriggerAt = ''

  if (enabled && cron) {
    nextTriggerAt = getNextCronOccurrence(cron, new Date()).toISOString()
  }

  return {
    enabled,
    cron,
    timezone: normalizeTaskAutomationTimezone(input?.timezone || fallback.timezone),
    concurrencyPolicy: normalizeTaskAutomationConcurrencyPolicy(input?.concurrencyPolicy || fallback.concurrencyPolicy),
    lastTriggeredAt: clampText(input?.lastTriggeredAt || fallback.lastTriggeredAt || '', 40).trim(),
    nextTriggerAt,
  }
}

function normalizeNotificationInput(input = {}, fallback = {}) {
  const fallbackProfileId = Number(fallback.profileId) || null
  const rawProfileId = Object.prototype.hasOwnProperty.call(input || {}, 'profileId')
    ? input?.profileId
    : fallbackProfileId
  const profileId = rawProfileId === null || rawProfileId === '' || typeof rawProfileId === 'undefined'
    ? null
    : Math.max(1, Number(rawProfileId) || 0) || null
  const enabled = Boolean(input?.enabled) && Boolean(profileId)
  return {
    enabled,
    profileId,
    channelType: normalizeTaskNotificationChannel(input?.channelType || fallback.channelType),
    webhookUrl: enabled ? clampText(input?.webhookUrl || '', 2000).trim() : '',
    secret: enabled ? clampText(input?.secret || '', 200).trim() : '',
    triggerOn: normalizeTaskNotificationTrigger(input?.triggerOn || fallback.triggerOn),
    locale: normalizeTaskNotificationLocale(input?.locale || fallback.locale),
    messageMode: normalizeTaskNotificationMessageMode(input?.messageMode || fallback.messageMode),
    lastStatus: clampText(input?.lastStatus || fallback.lastStatus || '', 32).trim(),
    lastError: clampText(input?.lastError || fallback.lastError || '', 500).trim(),
    lastSentAt: clampText(input?.lastSentAt || fallback.lastSentAt || '', 40).trim(),
  }
}

function normalizeNotificationProfileName(value = '') {
  const name = clampText(value || '', 80).trim()
  if (!name) {
    throw new Error('通知配置名称不能为空。')
  }
  return name
}

function normalizeNotificationProfileInput(input = {}, fallback = {}) {
  const webhookUrl = clampText(input?.webhookUrl || fallback.webhookUrl || '', 2000).trim()
  if (!webhookUrl) {
    throw new Error('Webhook 地址不能为空。')
  }

  return {
    name: normalizeNotificationProfileName(input?.name || fallback.name || ''),
    channelType: normalizeTaskNotificationChannel(input?.channelType || fallback.channelType),
    webhookUrl,
    secret: clampText(input?.secret || fallback.secret || '', 200).trim(),
    triggerOn: normalizeTaskNotificationTrigger(input?.triggerOn || fallback.triggerOn),
    locale: normalizeTaskNotificationLocale(input?.locale || fallback.locale),
    messageMode: normalizeTaskNotificationMessageMode(input?.messageMode || fallback.messageMode),
  }
}

function ensureSlug(title) {
  const base = slugifyTitle(title)
  let slug = `${base}-${slugTail()}`
  while (get('SELECT 1 FROM tasks WHERE slug = ?', [slug])) {
    slug = `${base}-${slugTail()}`
  }
  return slug
}

function isExpired(task) {
  return Boolean(task.expiresAt && new Date(task.expiresAt).getTime() <= Date.now())
}

function loadBlocks(taskId) {
  return all(
    `SELECT id, type, content, sort_order, meta_json
     FROM blocks
     WHERE task_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [taskId]
  ).map(toBlock)
}

function loadBlocksForTasks(taskIds = []) {
  if (!taskIds.length) {
    return new Map()
  }

  const placeholders = taskIds.map(() => '?').join(', ')
  const rows = all(
    `SELECT task_id, type, content, sort_order, id
     FROM blocks
     WHERE task_id IN (${placeholders})
     ORDER BY task_id ASC, sort_order ASC, id ASC`,
    taskIds
  )

  const grouped = new Map()
  rows.forEach((row) => {
    const taskId = Number(row.task_id)
    if (!grouped.has(taskId)) {
      grouped.set(taskId, [])
    }
    grouped.get(taskId).push({
      type: row.type,
      content: row.content,
    })
  })

  return grouped
}

function loadListMetadata(taskIds = []) {
  if (!taskIds.length) {
    return {
      blockCountByTaskId: new Map(),
      firstTextByTaskId: new Map(),
    }
  }

  const placeholders = taskIds.map(() => '?').join(', ')
  const countRows = all(
    `SELECT task_id, COUNT(*) AS block_count
     FROM blocks
     WHERE task_id IN (${placeholders})
     GROUP BY task_id`,
    taskIds
  )
  const firstTextRows = all(
    `SELECT task_id, content
     FROM (
       SELECT
         task_id,
         content,
         ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY sort_order ASC, id ASC) AS row_num
       FROM blocks
       WHERE task_id IN (${placeholders})
         AND type IN (?, ?)
         AND TRIM(content) != ''
     ) ranked
     WHERE row_num = 1`,
    [...taskIds, BLOCK_TYPES.TEXT, BLOCK_TYPES.IMPORTED_TEXT]
  )

  return {
    blockCountByTaskId: new Map(
      countRows.map((row) => [Number(row.task_id), Number(row.block_count)])
    ),
    firstTextByTaskId: new Map(
      firstTextRows.map((row) => [Number(row.task_id), row.content || ''])
    ),
  }
}

function getCodexRunCountByTaskSlug(taskSlug = '') {
  return Math.max(
    0,
    Number(
      get(
        `SELECT COUNT(*) AS count
         FROM codex_runs
         WHERE task_slug = ?`,
        [String(taskSlug || '').trim()]
      )?.count || 0
    )
  )
}

function loadCodexRunCounts(taskSlugs = []) {
  const normalizedSlugs = [...new Set(taskSlugs.map((slug) => String(slug || '').trim()).filter(Boolean))]
  if (!normalizedSlugs.length) {
    return new Map()
  }

  const placeholders = normalizedSlugs.map(() => '?').join(', ')
  const rows = all(
    `SELECT task_slug, COUNT(*) AS count
     FROM codex_runs
     WHERE task_slug IN (${placeholders})
     GROUP BY task_slug`,
    normalizedSlugs
  )

  return new Map(
    rows.map((row) => [String(row.task_slug || '').trim(), Math.max(0, Number(row.count) || 0)])
  )
}

function loadNotificationProfilesByIds(profileIds = []) {
  const normalizedIds = [...new Set(
    profileIds
      .map((value) => Math.max(1, Number(value) || 0))
      .filter(Boolean)
  )]

  if (!normalizedIds.length) {
    return new Map()
  }

  const placeholders = normalizedIds.map(() => '?').join(', ')
  const rows = all(
    `SELECT id, name, channel_type, webhook_url, secret, trigger_on, locale, message_mode, created_at, updated_at
     FROM notification_profiles
     WHERE id IN (${placeholders})`,
    normalizedIds
  )

  return new Map(rows.map((row) => [Number(row.id), toNotificationProfile(row)]))
}

function collectImagePaths(blocks = []) {
  return blocks
    .filter((block) => block.type === BLOCK_TYPES.IMAGE && block.content)
    .map((block) => block.content)
}

function mapTaskSummary(row, firstText = '', blockCount = 0, codexRunCount = 0, notificationProfile = null) {
  const textBlock = firstText
    ? [{ type: BLOCK_TYPES.TEXT, content: firstText }]
    : []
  const notification = resolveTaskNotification(row, notificationProfile)

  return {
    slug: row.slug,
    sortOrder: Number(row.sort_order) || 0,
    title: row.title || '',
    autoTitle: row.auto_title || deriveTitleFromBlocks(textBlock) || '',
    lastPromptPreview: row.last_prompt_preview || '',
    codexSessionId: row.codex_session_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visibility: row.visibility,
    expiresAt: row.expires_at,
    preview: summarizeTask({ blocks: textBlock }),
    codexRunCount: Math.max(0, Number(codexRunCount) || 0),
    todoCount: parseTaskTodoItems(row.todo_items_json).length,
    blockCount,
    automation: mapTaskAutomationSummary(row),
    notification: {
      ...mapTaskNotificationSummary(row),
      profileId: notification.profileId,
      profileName: notification.profileName,
    },
    latestCompletedRunFinishedAt: String(row.latest_completed_run_finished_at || ''),
    unread: Boolean(row.unread),
  }
}

function loadLatestTerminalRunFinishedAtByTaskSlug(taskSlugs = []) {
  const normalizedTaskSlugs = [...new Set(
    (taskSlugs || [])
      .map((slug) => String(slug || '').trim())
      .filter(Boolean)
  )]

  if (!normalizedTaskSlugs.length) {
    return new Map()
  }

  const placeholders = normalizedTaskSlugs.map(() => '?').join(', ')
  const terminalStatuses = ['completed', 'error', 'stopped', 'interrupted', 'stop_timeout']
  const statusPlaceholders = terminalStatuses.map(() => '?').join(', ')
  const rows = all(
    `SELECT
       task_slug,
       MAX(COALESCE(NULLIF(finished_at, ''), updated_at, created_at)) AS latest_finished_at
     FROM codex_runs
     WHERE task_slug IN (${placeholders})
       AND status IN (${statusPlaceholders})
     GROUP BY task_slug`,
    [...normalizedTaskSlugs, ...terminalStatuses]
  )

  return new Map(rows.map((row) => [
    String(row.task_slug || '').trim(),
    String(row.latest_finished_at || '').trim(),
  ]))
}

function loadTaskReadStateByTaskSlug(taskSlugs = [], userId = 'default') {
  const normalizedTaskSlugs = [...new Set(
    (taskSlugs || [])
      .map((slug) => String(slug || '').trim())
      .filter(Boolean)
  )]
  const normalizedUserId = String(userId || 'default').trim() || 'default'

  if (!normalizedTaskSlugs.length) {
    return new Map()
  }

  const placeholders = normalizedTaskSlugs.map(() => '?').join(', ')
  const rows = all(
    `SELECT task_slug, last_read_run_finished_at
     FROM task_read_states
     WHERE user_id = ?
       AND task_slug IN (${placeholders})`,
    [normalizedUserId, ...normalizedTaskSlugs]
  )

  return new Map(rows.map((row) => [
    String(row.task_slug || '').trim(),
    String(row.last_read_run_finished_at || '').trim(),
  ]))
}

function decorateTaskRowsWithUnreadState(rows = [], userId = 'default') {
  const taskSlugs = (rows || []).map((row) => String(row?.slug || '').trim()).filter(Boolean)
  const latestFinishedAtByTaskSlug = loadLatestTerminalRunFinishedAtByTaskSlug(taskSlugs)
  const lastReadAtByTaskSlug = loadTaskReadStateByTaskSlug(taskSlugs, userId)

  return (rows || []).map((row) => {
    const taskSlug = String(row?.slug || '').trim()
    const latestCompletedRunFinishedAt = latestFinishedAtByTaskSlug.get(taskSlug) || ''
    const lastReadRunFinishedAt = lastReadAtByTaskSlug.get(taskSlug) || ''

    return {
      ...row,
      latest_completed_run_finished_at: latestCompletedRunFinishedAt,
      unread: Boolean(
        latestCompletedRunFinishedAt
        && (
          !lastReadRunFinishedAt
          || latestCompletedRunFinishedAt > lastReadRunFinishedAt
        )
      ),
    }
  })
}

function normalizeBlockInput(block = {}) {
  const type =
    block.type === BLOCK_TYPES.IMAGE
      ? BLOCK_TYPES.IMAGE
      : block.type === BLOCK_TYPES.IMPORTED_TEXT
        ? BLOCK_TYPES.IMPORTED_TEXT
        : BLOCK_TYPES.TEXT
  const content = clampText(
    block.content || '',
    type === BLOCK_TYPES.IMAGE ? 1000 : 50000
  )
  const meta =
    type === BLOCK_TYPES.IMPORTED_TEXT
      ? {
          fileName: clampText(block.meta?.fileName || '', 180),
          collapsed: Boolean(block.meta?.collapsed),
        }
      : {}

  return {
    id: Number.isInteger(Number(block.id)) ? Number(block.id) : null,
    type,
    content,
    meta,
    metaJson: JSON.stringify(meta),
  }
}

function normalizeTaskTodoBlockInput(block = {}) {
  const normalized = normalizeBlockInput(block)
  return {
    type: normalized.type,
    content: normalized.content,
    meta: normalized.meta,
  }
}

function normalizeTaskTodoItemInput(item = {}, index = 0) {
  const blocks = Array.isArray(item?.blocks)
    ? item.blocks.map(normalizeTaskTodoBlockInput).filter((block) => String(block.content || '').trim() || block.type === BLOCK_TYPES.IMAGE)
    : []

  return {
    id: clampText(item?.id || `todo-${Date.now()}-${index}`, 80).trim() || `todo-${Date.now()}-${index}`,
    createdAt: clampText(item?.createdAt || new Date().toISOString(), 40).trim() || new Date().toISOString(),
    blocks,
  }
}

function normalizeTaskTodoItemsInput(items = []) {
  if (!Array.isArray(items)) {
    return []
  }

  return items
    .map((item, index) => normalizeTaskTodoItemInput(item, index))
    .filter((item) => item.blocks.length)
    .slice(0, 100)
}

function areNormalizedBlocksEqual(currentBlocks = [], nextBlocks = []) {
  if (currentBlocks.length !== nextBlocks.length) {
    return false
  }

  return currentBlocks.every((block, index) => {
    const nextBlock = nextBlocks[index]
    if (!nextBlock) {
      return false
    }

    return block.type === nextBlock.type
      && block.content === nextBlock.content
      && Number(block.sortOrder) === index
      && JSON.stringify(block.meta || {}) === nextBlock.metaJson
  })
}

function parseTaskTodoItems(rawValue = '[]') {
  try {
    return normalizeTaskTodoItemsInput(JSON.parse(String(rawValue || '[]')))
  } catch {
    return []
  }
}

export function listNotificationProfiles(userId = 'default') {
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  return all(
    `SELECT id, name, channel_type, webhook_url, secret, trigger_on, locale, message_mode, created_at, updated_at
     FROM notification_profiles
     WHERE user_id = ?
     ORDER BY updated_at DESC, id DESC`,
    [normalizedUserId]
  ).map(toNotificationProfile)
}

export function getNotificationProfileById(profileId, userId = null) {
  const normalizedId = Math.max(1, Number(profileId) || 0)
  if (!normalizedId) {
    return null
  }

  const row = userId
    ? get(
        `SELECT id, name, channel_type, webhook_url, secret, trigger_on, locale, message_mode, created_at, updated_at
         FROM notification_profiles
         WHERE id = ? AND user_id = ?`,
        [normalizedId, String(userId || 'default').trim() || 'default']
      )
    : get(
        `SELECT id, name, channel_type, webhook_url, secret, trigger_on, locale, message_mode, created_at, updated_at
         FROM notification_profiles
         WHERE id = ?`,
        [normalizedId]
      )

  return toNotificationProfile(row)
}

export function createNotificationProfile(input = {}, userId = 'default') {
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  const profile = normalizeNotificationProfileInput(input)
  const now = new Date().toISOString()

  const duplicate = get(
    `SELECT id
     FROM notification_profiles
     WHERE user_id = ? AND name = ?`,
    [normalizedUserId, profile.name]
  )
  if (duplicate) {
    throw new Error('同名通知配置已存在。')
  }

  run(
    `INSERT INTO notification_profiles (
      user_id, name, channel_type, webhook_url, secret, trigger_on, locale, message_mode, created_at, updated_at
    )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalizedUserId,
      profile.name,
      profile.channelType,
      profile.webhookUrl,
      profile.secret,
      profile.triggerOn,
      profile.locale,
      profile.messageMode,
      now,
      now,
    ]
  )

  const created = get(
    `SELECT id
     FROM notification_profiles
     WHERE user_id = ? AND name = ?`,
    [normalizedUserId, profile.name]
  )
  return getNotificationProfileById(created?.id, normalizedUserId)
}

export function updateNotificationProfile(profileId, input = {}, userId = 'default') {
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  const existing = get(
    `SELECT id, name, channel_type, webhook_url, secret, trigger_on, locale, message_mode
     FROM notification_profiles
     WHERE id = ? AND user_id = ?`,
    [Math.max(1, Number(profileId) || 0), normalizedUserId]
  )
  if (!existing) {
    return { error: 'not_found' }
  }

  const profile = normalizeNotificationProfileInput(input, {
    name: existing.name,
    channelType: existing.channel_type,
    webhookUrl: existing.webhook_url,
    secret: existing.secret,
    triggerOn: existing.trigger_on,
    locale: existing.locale,
    messageMode: existing.message_mode,
  })

  const duplicate = get(
    `SELECT id
     FROM notification_profiles
     WHERE user_id = ? AND name = ? AND id != ?`,
    [normalizedUserId, profile.name, Number(existing.id)]
  )
  if (duplicate) {
    throw new Error('同名通知配置已存在。')
  }

  run(
    `UPDATE notification_profiles
     SET name = ?, channel_type = ?, webhook_url = ?, secret = ?, trigger_on = ?, locale = ?, message_mode = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      profile.name,
      profile.channelType,
      profile.webhookUrl,
      profile.secret,
      profile.triggerOn,
      profile.locale,
      profile.messageMode,
      new Date().toISOString(),
      Number(existing.id),
      normalizedUserId,
    ]
  )

  return getNotificationProfileById(existing.id, normalizedUserId)
}

export function deleteNotificationProfile(profileId, userId = 'default') {
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  const normalizedId = Math.max(1, Number(profileId) || 0)
  const existing = get(
    `SELECT id
     FROM notification_profiles
     WHERE id = ? AND user_id = ?`,
    [normalizedId, normalizedUserId]
  )
  if (!existing) {
    return { error: 'not_found' }
  }

  const usage = Math.max(
    0,
    Number(
      get(
        `SELECT COUNT(*) AS count
         FROM tasks
         WHERE user_id = ? AND notification_profile_id = ?`,
        [normalizedUserId, normalizedId]
      )?.count || 0
    )
  )

  if (usage > 0) {
    return { error: 'in_use', usageCount: usage }
  }

  run(
    `DELETE FROM notification_profiles
     WHERE id = ? AND user_id = ?`,
    [normalizedId, normalizedUserId]
  )

  const systemConfig = readStoredSystemConfig()
  if (Number(systemConfig?.notification?.defaultProfileId) === normalizedId) {
    writeStoredSystemConfig({
      ...systemConfig,
      notification: {
        ...(systemConfig.notification || {}),
        defaultProfileId: null,
      },
    })
  }

  return { ok: true }
}

export function listTasks(limit = 30, userId = 'default') {
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  const rows = decorateTaskRowsWithUnreadState(all(
    `SELECT id, slug, sort_order, title, auto_title, last_prompt_preview, todo_items_json, codex_session_id,
            automation_enabled, automation_cron, automation_timezone, automation_concurrency_policy, automation_last_triggered_at, automation_next_trigger_at,
            notification_enabled, notification_profile_id, notification_channel_type, notification_webhook_url, notification_secret, notification_trigger_on, notification_locale, notification_message_mode, notification_last_status, notification_last_error, notification_last_sent_at,
            visibility, expires_at, created_at, updated_at
     FROM tasks
     WHERE user_id = ?
     ORDER BY sort_order ASC, created_at DESC, id DESC
     LIMIT ?`,
    [normalizedUserId, Math.max(1, Number(limit) || 30)]
  ), normalizedUserId)

  const taskIds = rows.map((row) => Number(row.id))
  const {
    blockCountByTaskId,
    firstTextByTaskId,
  } = loadListMetadata(taskIds)
  const codexRunCountBySlug = loadCodexRunCounts(rows.map((row) => row.slug))
  const notificationProfilesById = loadNotificationProfilesByIds(rows.map((row) => row.notification_profile_id))

  return rows.map((row) =>
    mapTaskSummary(
      row,
      firstTextByTaskId.get(Number(row.id)) || '',
      blockCountByTaskId.get(Number(row.id)) || 0,
      codexRunCountBySlug.get(String(row.slug || '').trim()) || 0,
      notificationProfilesById.get(Number(row.notification_profile_id)) || null
    )
  )
}

export function getTaskBySlug(slug, userId = null) {
  const normalizedUserId = userId ? String(userId).trim() : null
  const rawRow = normalizedUserId
    ? get(
        `SELECT id, slug, sort_order, title, auto_title, last_prompt_preview, todo_items_json, codex_session_id,
                automation_enabled, automation_cron, automation_timezone, automation_concurrency_policy, automation_last_triggered_at, automation_next_trigger_at,
                notification_enabled, notification_profile_id, notification_channel_type, notification_webhook_url, notification_secret, notification_trigger_on, notification_locale, notification_message_mode, notification_last_status, notification_last_error, notification_last_sent_at,
                visibility, expires_at, created_at, updated_at
         FROM tasks
         WHERE slug = ? AND user_id = ?`,
        [slug, normalizedUserId]
      )
    : get(
        `SELECT id, slug, sort_order, title, auto_title, last_prompt_preview, todo_items_json, codex_session_id,
                automation_enabled, automation_cron, automation_timezone, automation_concurrency_policy, automation_last_triggered_at, automation_next_trigger_at,
                notification_enabled, notification_profile_id, notification_channel_type, notification_webhook_url, notification_secret, notification_trigger_on, notification_locale, notification_message_mode, notification_last_status, notification_last_error, notification_last_sent_at,
                visibility, expires_at, created_at, updated_at
         FROM tasks
         WHERE slug = ?`,
        [slug]
      )

  if (!rawRow) {
    return null
  }

  const row = normalizedUserId
    ? decorateTaskRowsWithUnreadState([rawRow], normalizedUserId)[0]
    : rawRow

  const notificationProfile = Number(row.notification_profile_id)
    ? getNotificationProfileById(row.notification_profile_id)
    : null
  const task = toTask(row, loadBlocks(row.id), {
    codexRunCount: getCodexRunCountByTaskSlug(row.slug),
    notificationProfile,
  })
  return isExpired(task) ? { ...task, expired: true } : task
}

export function markTaskRead(taskSlug = '', userId = 'default', finishedAt = '') {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  if (!normalizedTaskSlug) {
    return null
  }

  const task = getTaskBySlug(normalizedTaskSlug, normalizedUserId)
  if (!task || task.expired) {
    return null
  }

  const latestCompletedRunFinishedAt = String(
    finishedAt
    || loadLatestTerminalRunFinishedAtByTaskSlug([normalizedTaskSlug]).get(normalizedTaskSlug)
    || ''
  ).trim()
  const now = new Date().toISOString()

  run(
    `INSERT INTO task_read_states (user_id, task_slug, last_read_run_finished_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, task_slug) DO UPDATE SET
       last_read_run_finished_at = excluded.last_read_run_finished_at,
       updated_at = excluded.updated_at`,
    [normalizedUserId, normalizedTaskSlug, latestCompletedRunFinishedAt, now, now]
  )

  return {
    taskSlug: normalizedTaskSlug,
    lastReadRunFinishedAt: latestCompletedRunFinishedAt,
  }
}

export function createTask(input = {}, userId = 'default') {
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  const systemConfig = readStoredSystemConfig()
  const defaultNotificationProfileId = Number(systemConfig?.notification?.defaultProfileId) || null
  const now = new Date().toISOString()
  const title = clampText(input.title || '', 140)
  const autoTitle = clampText(input.autoTitle || '', 140)
  const lastPromptPreview = clampText(input.lastPromptPreview || '', 280)
  const todoItemsJson = JSON.stringify(normalizeTaskTodoItemsInput(input.todoItems))
  const codexSessionId = clampText(input.codexSessionId || '', 120)
  const automation = normalizeAutomationInput(input.automation)
  const hasExplicitNotification = Object.prototype.hasOwnProperty.call(input || {}, 'notification')
  const defaultNotificationProfile = defaultNotificationProfileId
    ? getNotificationProfileById(defaultNotificationProfileId, normalizedUserId)
    : null
  const notification = hasExplicitNotification
    ? normalizeNotificationInput(input.notification)
    : defaultNotificationProfile
      ? normalizeNotificationInput({
          enabled: true,
          profileId: defaultNotificationProfileId,
        })
      : normalizeNotificationInput(input.notification)
  const notificationProfile = notification.profileId
    ? getNotificationProfileById(notification.profileId, normalizedUserId)
    : null
  if (notification.enabled && !notificationProfile) {
    throw new Error('所选通知配置不存在。')
  }
  const visibility = normalizeVisibility(input.visibility)
  const expiresAt = resolveExpiresAt(normalizeExpiry(input.expiry || 'none'))
  const slug = ensureSlug(title)
  const editToken = tokenId()
  const topSortOrder = Number(get('SELECT MIN(sort_order) AS value FROM tasks WHERE user_id = ?', [normalizedUserId])?.value)
  const sortOrder = Number.isFinite(topSortOrder) ? topSortOrder - 1 : 0

  transaction(() => {
    run(
      `INSERT INTO tasks (
        slug, edit_token, sort_order, title, auto_title, last_prompt_preview, todo_items_json, codex_session_id,
        automation_enabled, automation_cron, automation_timezone, automation_concurrency_policy, automation_last_triggered_at, automation_next_trigger_at,
        notification_enabled, notification_profile_id, notification_channel_type, notification_webhook_url, notification_secret, notification_trigger_on, notification_locale, notification_message_mode, notification_last_status, notification_last_error, notification_last_sent_at,
        visibility, expires_at, created_at, updated_at, user_id
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
      [
        slug,
        editToken,
        sortOrder,
        title,
        autoTitle,
        lastPromptPreview,
        todoItemsJson,
        codexSessionId,
        automation.enabled ? 1 : 0,
        automation.cron,
        automation.timezone,
        automation.concurrencyPolicy,
        automation.lastTriggeredAt,
        automation.nextTriggerAt,
        notification.enabled ? 1 : 0,
        notification.profileId,
        notification.channelType,
        notification.webhookUrl,
        notification.secret,
        notification.triggerOn,
        notification.locale,
        notification.messageMode,
        notification.lastStatus,
        notification.lastError,
        notification.lastSentAt,
        visibility,
        expiresAt,
        now,
        now,
        normalizedUserId,
      ]
    )
  })

  return {
    ...getTaskBySlug(slug),
    editToken,
  }
}

export function updateTask(slug, input = {}, userId = null) {
  const normalizedUserId = userId ? String(userId).trim() : null
  const whereClause = normalizedUserId ? 'WHERE slug = ? AND user_id = ?' : 'WHERE slug = ?'
  const whereParams = normalizedUserId ? [slug, normalizedUserId] : [slug]
  const existing = get(
    `SELECT id, edit_token, title, auto_title, last_prompt_preview, todo_items_json, codex_session_id,
            automation_enabled, automation_cron, automation_timezone, automation_concurrency_policy, automation_last_triggered_at, automation_next_trigger_at,
            notification_enabled, notification_profile_id, notification_channel_type, notification_webhook_url, notification_secret, notification_trigger_on, notification_locale, notification_message_mode, notification_last_status, notification_last_error, notification_last_sent_at,
            visibility, expires_at
     FROM tasks
     ${whereClause}`,
    whereParams
  )
  if (!existing) {
    return { error: 'not_found' }
  }

  const title = Object.prototype.hasOwnProperty.call(input, 'title')
    ? clampText(input.title || '', 140)
    : String(existing.title || '')
  const autoTitle = Object.prototype.hasOwnProperty.call(input, 'autoTitle')
    ? clampText(input.autoTitle || '', 140)
    : String(existing.auto_title || '')
  const lastPromptPreview = Object.prototype.hasOwnProperty.call(input, 'lastPromptPreview')
    ? clampText(input.lastPromptPreview || '', 280)
    : String(existing.last_prompt_preview || '')
  const todoItemsJson = Object.prototype.hasOwnProperty.call(input, 'todoItems')
    ? JSON.stringify(normalizeTaskTodoItemsInput(input.todoItems))
    : String(existing.todo_items_json || '[]')
  const codexSessionId = Object.prototype.hasOwnProperty.call(input, 'codexSessionId')
    ? clampText(input.codexSessionId || '', 120)
    : String(existing.codex_session_id || '')
  const visibility = Object.prototype.hasOwnProperty.call(input, 'visibility')
    ? normalizeVisibility(input.visibility)
    : normalizeVisibility(existing.visibility)
  const expiresAt = Object.prototype.hasOwnProperty.call(input, 'expiry')
    ? resolveExpiresAt(normalizeExpiry(input.expiry || 'none'))
    : existing.expires_at
  const automation = Object.prototype.hasOwnProperty.call(input, 'automation')
    ? normalizeAutomationInput(input.automation, {
        enabled: existing.automation_enabled,
        cron: existing.automation_cron,
        timezone: existing.automation_timezone,
        concurrencyPolicy: existing.automation_concurrency_policy,
        lastTriggeredAt: existing.automation_last_triggered_at,
        nextTriggerAt: existing.automation_next_trigger_at,
      })
    : normalizeAutomationInput({
        enabled: existing.automation_enabled,
        cron: existing.automation_cron,
        timezone: existing.automation_timezone,
        concurrencyPolicy: existing.automation_concurrency_policy,
        lastTriggeredAt: existing.automation_last_triggered_at,
        nextTriggerAt: existing.automation_next_trigger_at,
      })
  const notification = Object.prototype.hasOwnProperty.call(input, 'notification')
    ? normalizeNotificationInput(input.notification, {
        enabled: existing.notification_enabled,
        profileId: existing.notification_profile_id,
        channelType: existing.notification_channel_type,
        webhookUrl: existing.notification_webhook_url,
        secret: existing.notification_secret,
        triggerOn: existing.notification_trigger_on,
        locale: existing.notification_locale,
        messageMode: existing.notification_message_mode,
        lastStatus: existing.notification_last_status,
        lastError: existing.notification_last_error,
        lastSentAt: existing.notification_last_sent_at,
      })
    : normalizeNotificationInput({
        enabled: existing.notification_enabled,
        profileId: existing.notification_profile_id,
        channelType: existing.notification_channel_type,
        webhookUrl: existing.notification_webhook_url,
        secret: existing.notification_secret,
        triggerOn: existing.notification_trigger_on,
        locale: existing.notification_locale,
        messageMode: existing.notification_message_mode,
        lastStatus: existing.notification_last_status,
        lastError: existing.notification_last_error,
        lastSentAt: existing.notification_last_sent_at,
      })
  const updatedAt = new Date().toISOString()
  const notificationProfile = notification.profileId
    ? getNotificationProfileById(notification.profileId, normalizedUserId || undefined)
    : null
  if (notification.enabled && !notificationProfile) {
    throw new Error('所选通知配置不存在。')
  }
  const hasBlocks = Array.isArray(input.blocks)
  const blocks = hasBlocks ? input.blocks.map(normalizeBlockInput) : []
  const currentBlocks = loadBlocks(existing.id)
  const currentBlockMap = new Map(currentBlocks.map((block) => [block.id, block]))
  const taskChanged =
    title !== String(existing.title || '')
    || autoTitle !== String(existing.auto_title || '')
    || lastPromptPreview !== String(existing.last_prompt_preview || '')
    || todoItemsJson !== String(existing.todo_items_json || '[]')
    || codexSessionId !== String(existing.codex_session_id || '')
    || visibility !== normalizeVisibility(existing.visibility)
    || expiresAt !== existing.expires_at
    || Number(automation.enabled ? 1 : 0) !== Number(existing.automation_enabled || 0)
    || automation.cron !== String(existing.automation_cron || '')
    || automation.timezone !== normalizeTaskAutomationTimezone(existing.automation_timezone)
    || automation.concurrencyPolicy !== normalizeTaskAutomationConcurrencyPolicy(existing.automation_concurrency_policy)
    || automation.lastTriggeredAt !== String(existing.automation_last_triggered_at || '')
    || automation.nextTriggerAt !== String(existing.automation_next_trigger_at || '')
    || Number(notification.enabled ? 1 : 0) !== Number(existing.notification_enabled || 0)
    || Number(notification.profileId || 0) !== Number(existing.notification_profile_id || 0)
    || notification.channelType !== String(existing.notification_channel_type || '')
    || notification.webhookUrl !== String(existing.notification_webhook_url || '')
    || notification.secret !== String(existing.notification_secret || '')
    || notification.triggerOn !== String(existing.notification_trigger_on || '')
    || notification.locale !== normalizeTaskNotificationLocale(existing.notification_locale)
    || notification.messageMode !== normalizeTaskNotificationMessageMode(existing.notification_message_mode)
    || notification.lastStatus !== String(existing.notification_last_status || '')
    || notification.lastError !== String(existing.notification_last_error || '')
    || notification.lastSentAt !== String(existing.notification_last_sent_at || '')
    || (hasBlocks && !areNormalizedBlocksEqual(currentBlocks, blocks))

  if (!taskChanged) {
    return {
      ...getTaskBySlug(slug),
      changed: false,
    }
  }

  transaction(() => {
    run(
      `UPDATE tasks
       SET title = ?, auto_title = ?, last_prompt_preview = ?, todo_items_json = ?, codex_session_id = ?,
           automation_enabled = ?, automation_cron = ?, automation_timezone = ?, automation_concurrency_policy = ?, automation_last_triggered_at = ?, automation_next_trigger_at = ?,
           notification_enabled = ?, notification_profile_id = ?, notification_channel_type = ?, notification_webhook_url = ?, notification_secret = ?, notification_trigger_on = ?, notification_locale = ?, notification_message_mode = ?, notification_last_status = ?, notification_last_error = ?, notification_last_sent_at = ?,
           visibility = ?, expires_at = ?, updated_at = ?
       WHERE slug = ?`,
      [
        title,
        autoTitle,
        lastPromptPreview,
        todoItemsJson,
        codexSessionId,
        automation.enabled ? 1 : 0,
        automation.cron,
        automation.timezone,
        automation.concurrencyPolicy,
        automation.lastTriggeredAt,
        automation.nextTriggerAt,
        notification.enabled ? 1 : 0,
        notification.profileId,
        notification.channelType,
        notification.webhookUrl,
        notification.secret,
        notification.triggerOn,
        notification.locale,
        notification.messageMode,
        notification.lastStatus,
        notification.lastError,
        notification.lastSentAt,
        visibility,
        expiresAt,
        updatedAt,
        slug,
      ]
    )

    if (!hasBlocks) {
      return
    }

    const incomingIds = new Set()

    blocks.forEach((block, index) => {
      const currentBlock = block.id ? currentBlockMap.get(block.id) : null

      if (currentBlock) {
        incomingIds.add(currentBlock.id)

        const currentMetaJson = JSON.stringify(currentBlock.meta || {})
        const unchanged =
          currentBlock.type === block.type
          && currentBlock.content === block.content
          && currentBlock.sortOrder === index
          && currentMetaJson === block.metaJson

        if (!unchanged) {
          run(
            `UPDATE blocks
             SET type = ?, content = ?, sort_order = ?, meta_json = ?
             WHERE id = ? AND task_id = ?`,
            [block.type, block.content, index, block.metaJson, currentBlock.id, existing.id]
          )
        }
        return
      }

      run(
        `INSERT INTO blocks (task_id, type, content, sort_order, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [existing.id, block.type, block.content, index, block.metaJson, updatedAt]
      )
    })

    currentBlocks.forEach((block) => {
      if (!incomingIds.has(block.id)) {
        run('DELETE FROM blocks WHERE id = ? AND task_id = ?', [block.id, existing.id])
      }
    })
  })

  return {
    ...getTaskBySlug(slug),
    changed: true,
  }
}

export function deleteTask(slug, userId = null) {
  const normalizedUserId = userId ? String(userId).trim() : null
  const whereClause = normalizedUserId ? 'WHERE slug = ? AND user_id = ?' : 'WHERE slug = ?'
  const whereParams = normalizedUserId ? [slug, normalizedUserId] : [slug]
  const row = get(`SELECT id, edit_token FROM tasks ${whereClause}`, whereParams)
  if (!row) {
    return { error: 'not_found' }
  }

  const blocks = loadBlocks(row.id)
  const removedAssets = collectImagePaths(blocks)

  transaction(() => {
    run('DELETE FROM tasks WHERE slug = ?', [slug])
  })

  return { ok: true, removedAssets }
}

export function purgeExpiredTasks(now = new Date().toISOString()) {
  const rows = all(
    `SELECT id
     FROM tasks
     WHERE expires_at IS NOT NULL
       AND expires_at <= ?`,
    [now]
  )

  if (!rows.length) {
    return { removedAssets: [], removedCount: 0 }
  }

  const taskIds = rows.map((row) => Number(row.id))
  const blocksByTaskId = loadBlocksForTasks(taskIds)
  const removedAssets = taskIds.flatMap((taskId) =>
    collectImagePaths(blocksByTaskId.get(taskId) || [])
  )

  const placeholders = taskIds.map(() => '?').join(', ')
  transaction(() => {
    run(`DELETE FROM tasks WHERE id IN (${placeholders})`, taskIds)
  })

  return {
    removedAssets,
    removedCount: taskIds.length,
  }
}

export function buildTaskExports(task) {
  return {
    raw: buildRawTaskText(task),
  }
}

export function canEditTask(slug, userId = null) {
  const normalizedUserId = userId ? String(userId).trim() : null
  if (normalizedUserId) {
    return Boolean(get('SELECT 1 FROM tasks WHERE slug = ? AND user_id = ?', [slug, normalizedUserId]))
  }
  return Boolean(get('SELECT 1 FROM tasks WHERE slug = ?', [slug]))
}

export function updateTaskCodexSession(slug, codexSessionId = '', userId = null) {
  const normalizedUserId = userId ? String(userId).trim() : null
  const whereClause = normalizedUserId ? 'WHERE slug = ? AND user_id = ?' : 'WHERE slug = ?'
  const whereParams = normalizedUserId ? [slug, normalizedUserId] : [slug]
  const existing = get(`SELECT slug FROM tasks ${whereClause}`, whereParams)
  if (!existing) {
    return null
  }

  const normalizedSessionId = String(codexSessionId || '').trim()
  const updatedAt = new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE tasks
       SET codex_session_id = ?, updated_at = ?
       WHERE slug = ?`,
      [normalizedSessionId, updatedAt, slug]
    )
  })

  return getTaskBySlug(slug)
}

export function reorderTasks(taskSlugs = [], userId = 'default') {
  const normalizedUserId = String(userId || 'default').trim() || 'default'
  const requestedSlugs = [...new Set(
    (Array.isArray(taskSlugs) ? taskSlugs : [])
      .map((slug) => String(slug || '').trim())
      .filter(Boolean)
  )]

  if (!requestedSlugs.length) {
    throw new Error('缺少任务排序数据。')
  }

  const currentRows = all(
    `SELECT slug
     FROM tasks
     WHERE user_id = ?
     ORDER BY sort_order ASC, created_at DESC, id DESC`,
    [normalizedUserId]
  )
  const currentOrder = currentRows.map((row) => String(row.slug || '').trim()).filter(Boolean)
  const existingSlugSet = new Set(currentOrder)
  const nextOrderedSlugs = requestedSlugs.filter((slug) => existingSlugSet.has(slug))

  if (!nextOrderedSlugs.length) {
    throw new Error('没有可排序的任务。')
  }

  const remainingSlugs = currentOrder.filter((slug) => !nextOrderedSlugs.includes(slug))
  const finalOrder = [...nextOrderedSlugs, ...remainingSlugs]
  const changed = finalOrder.some((slug, index) => slug !== currentOrder[index])

  if (!changed) {
    return {
      changed: false,
      items: listTasks(Math.max(finalOrder.length, 1), normalizedUserId),
    }
  }

  transaction(() => {
    finalOrder.forEach((slug, index) => {
      run('UPDATE tasks SET sort_order = ? WHERE slug = ?', [index, slug])
    })
  })

  return {
    changed: true,
    items: listTasks(Math.max(finalOrder.length, 1), normalizedUserId),
  }
}

export function clearTaskCodexSessionReferences(codexSessionId = '', userId = null) {
  const normalizedSessionId = String(codexSessionId || '').trim()
  const normalizedUserId = userId ? String(userId).trim() : null
  if (!normalizedSessionId) {
    return []
  }

  const matchedRows = normalizedUserId
    ? all(
        `SELECT slug
         FROM tasks
         WHERE codex_session_id = ? AND user_id = ?`,
        [normalizedSessionId, normalizedUserId]
      )
    : all(
        `SELECT slug
         FROM tasks
         WHERE codex_session_id = ?`,
        [normalizedSessionId]
      )
  const matchedTaskSlugs = matchedRows
    .map((row) => String(row?.slug || '').trim())
    .filter(Boolean)

  if (!matchedTaskSlugs.length) {
    return []
  }

  transaction(() => {
    if (normalizedUserId) {
      run(
        `UPDATE tasks
         SET codex_session_id = ''
         WHERE codex_session_id = ? AND user_id = ?`,
        [normalizedSessionId, normalizedUserId]
      )
    } else {
      run(
        `UPDATE tasks
         SET codex_session_id = ''
         WHERE codex_session_id = ?`,
        [normalizedSessionId]
      )
    }
  })

  return matchedTaskSlugs
}

export function listTaskSlugsByCodexSessionId(codexSessionId = '', userId = null) {
  const normalizedSessionId = String(codexSessionId || '').trim()
  const normalizedUserId = userId ? String(userId).trim() : null
  if (!normalizedSessionId) {
    return []
  }

  return (
    normalizedUserId
      ? all(
          `SELECT slug
           FROM tasks
           WHERE codex_session_id = ? AND user_id = ?
           ORDER BY sort_order ASC, created_at DESC, id DESC`,
          [normalizedSessionId, normalizedUserId]
        )
      : all(
          `SELECT slug
           FROM tasks
           WHERE codex_session_id = ?
           ORDER BY sort_order ASC, created_at DESC, id DESC`,
          [normalizedSessionId]
        )
  )
    .map((row) => String(row?.slug || '').trim())
    .filter(Boolean)
}

export function listAutomationEnabledTasks(limit = 200) {
  const rows = all(
    `SELECT id, slug, title, auto_title, last_prompt_preview, codex_session_id,
            automation_enabled, automation_cron, automation_timezone, automation_concurrency_policy, automation_last_triggered_at, automation_next_trigger_at,
            notification_enabled, notification_profile_id, notification_channel_type, notification_webhook_url, notification_secret, notification_trigger_on, notification_locale, notification_message_mode, notification_last_status, notification_last_error, notification_last_sent_at,
            visibility, expires_at, created_at, updated_at
     FROM tasks
     WHERE automation_enabled = 1
       AND TRIM(automation_cron) != ''
     ORDER BY updated_at DESC
     LIMIT ?`,
    [Math.max(1, Number(limit) || 200)]
  )

  const notificationProfilesById = loadNotificationProfilesByIds(rows.map((row) => row.notification_profile_id))
  return rows.map((row) => toTask(row, loadBlocks(row.id), {
    codexRunCount: getCodexRunCountByTaskSlug(row.slug),
    notificationProfile: notificationProfilesById.get(Number(row.notification_profile_id)) || null,
  }))
}

export function updateTaskAutomationRuntime(slug, patch = {}) {
  const existing = get(
    `SELECT slug, automation_last_triggered_at, automation_next_trigger_at
     FROM tasks
     WHERE slug = ?`,
    [slug]
  )
  if (!existing) {
    return null
  }

  const lastTriggeredAt = Object.prototype.hasOwnProperty.call(patch, 'lastTriggeredAt')
    ? clampText(patch.lastTriggeredAt || '', 40).trim()
    : String(existing.automation_last_triggered_at || '')
  const nextTriggerAt = Object.prototype.hasOwnProperty.call(patch, 'nextTriggerAt')
    ? clampText(patch.nextTriggerAt || '', 40).trim()
    : String(existing.automation_next_trigger_at || '')

  run(
    `UPDATE tasks
     SET automation_last_triggered_at = ?, automation_next_trigger_at = ?
     WHERE slug = ?`,
    [lastTriggeredAt, nextTriggerAt, slug]
  )

  return getTaskBySlug(slug)
}

export function updateTaskNotificationDelivery(slug, patch = {}) {
  const existing = get(
    `SELECT slug, notification_last_status, notification_last_error, notification_last_sent_at
     FROM tasks
     WHERE slug = ?`,
    [slug]
  )
  if (!existing) {
    return null
  }

  const status = Object.prototype.hasOwnProperty.call(patch, 'lastStatus')
    ? clampText(patch.lastStatus || '', 32).trim()
    : String(existing.notification_last_status || '')
  const errorMessage = Object.prototype.hasOwnProperty.call(patch, 'lastError')
    ? clampText(patch.lastError || '', 500).trim()
    : String(existing.notification_last_error || '')
  const sentAt = Object.prototype.hasOwnProperty.call(patch, 'lastSentAt')
    ? clampText(patch.lastSentAt || '', 40).trim()
    : String(existing.notification_last_sent_at || '')

  run(
    `UPDATE tasks
     SET notification_last_status = ?, notification_last_error = ?, notification_last_sent_at = ?
     WHERE slug = ?`,
    [status, errorMessage, sentAt, slug]
  )

  return getTaskBySlug(slug)
}
