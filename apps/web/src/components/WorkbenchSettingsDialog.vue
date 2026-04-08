<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Cpu, Bell, Eye, EyeOff, Info, LoaderCircle, Palette, Save, Settings2, Trash2, Wifi } from 'lucide-vue-next'
import {
  TASK_NOTIFICATION_CHANNEL_OPTIONS,
  TASK_NOTIFICATION_LOCALE_OPTIONS,
  TASK_NOTIFICATION_MESSAGE_MODE_OPTIONS,
  TASK_NOTIFICATION_TRIGGER_OPTIONS,
} from '@promptx/shared'
import DialogShell from './DialogShell.vue'
import DialogSideNav from './DialogSideNav.vue'
import ThemeToggle from './ThemeToggle.vue'
import WorkbenchSelect from './WorkbenchSelect.vue'
import { formatDateTime as formatLocaleDateTime, useI18n } from '../composables/useI18n.js'
import {
  createNotificationProfile,
  deleteNotificationProfile,
  getMeta,
  getRelayConfig,
  reconnectRelay,
  getRuntimeDiagnostics,
  getSystemConfig,
  listNotificationProfiles,
  updateNotificationProfile,
  updateRelayConfig,
  updateSystemConfig,
} from '../lib/api.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close'])
const { locale, localeOptions, setLocale, t } = useI18n()
const version = ref('')
const versionLoading = ref(false)
const versionError = ref('')
const relayLoading = ref(false)
const relaySaving = ref(false)
const relayReconnecting = ref(false)
const relayError = ref('')
const relaySuccess = ref('')
const systemLoading = ref(false)
const systemSaving = ref(false)
const systemError = ref('')
const systemSuccess = ref('')
const systemDiagnosticsLoading = ref(false)
const systemDiagnosticsError = ref('')
const systemDiagnostics = ref(null)
const notificationProfiles = ref([])
const notificationProfilesLoading = ref(false)
const notificationProfilesError = ref('')
const notificationProfileSaving = ref(false)
const notificationProfileDeleting = ref(false)
const relayStatus = ref(null)
const relayManagedByEnv = ref(false)
const systemManagedByEnv = reactive({
  runnerMaxConcurrentRuns: false,
})
const relayToggleSaving = ref(false)
const relayTokenVisible = ref(false)
const relayCopied = ref(false)
const systemCopied = ref(false)
const relayForm = reactive({
  enabled: false,
  relayUrl: '',
  deviceId: '',
  deviceToken: '',
})
const systemForm = reactive({
  runnerMaxConcurrentRuns: 3,
  defaultNotificationProfileId: '',
  workspaceRootPath: '',
})
const profileForm = reactive({
  id: '',
  name: '',
  channelType: 'dingtalk',
  webhookUrl: '',
  secret: '',
  triggerOn: 'completed',
  locale: 'zh-CN',
  messageMode: 'summary',
})
const activeSection = ref('theme')
let relayCopyTimer = null
let systemCopyTimer = null
let systemDiagnosticsTimer = null

const settingsSections = computed(() => ([
  {
    id: 'theme',
    label: t('theme.title'),
    description: t('theme.sectionDescription'),
    icon: Palette,
  },
  {
    id: 'relay',
    label: t('settingsDialog.relay.sectionLabel'),
    description: t('settingsDialog.relay.sectionDescription'),
    icon: Wifi,
  },
  {
    id: 'notification',
    label: t('settingsDialog.notification.sectionLabel'),
    description: t('settingsDialog.notification.sectionDescription'),
    icon: Bell,
  },
  {
    id: 'system',
    label: t('settingsDialog.system.sectionLabel'),
    description: t('settingsDialog.system.sectionDescription'),
    icon: Cpu,
  },
  {
    id: 'about',
    label: t('settingsDialog.about.sectionLabel'),
    description: t('settingsDialog.about.sectionDescription'),
    icon: Info,
  },
]))

function resolvePayloadMessage(payload = null, fallbackKey = '') {
  const messageKey = String(payload?.messageKey || '').trim()
  if (messageKey) {
    const translated = t(messageKey)
    if (translated && translated !== messageKey) {
      return translated
    }
  }

  return String(payload?.message || '').trim() || (fallbackKey ? t(fallbackKey) : '')
}

function resolveRelayReason(code = '', fallback = '') {
  const normalizedCode = String(code || '').trim()
  if (normalizedCode) {
    const key = `settingsDialog.relay.reason.${normalizedCode}`
    const translated = t(key)
    if (translated !== key) {
      return translated
    }
  }

  return String(fallback || '').trim() || t('common.notAvailable')
}

function resolveRelayEventLabel(event = null) {
  const type = String(event?.type || '').trim() || 'unknown'
  const key = `settingsDialog.relay.event.${type}`
  const translated = t(key)
  return translated !== key ? translated : type
}

function resolveRelayErrorText(status = null) {
  const errorKey = String(status?.lastErrorKey || '').trim()
  const params = status?.lastErrorParams && typeof status.lastErrorParams === 'object'
    ? status.lastErrorParams
    : {}

  if (errorKey === 'connect_failed') {
    return t('settingsDialog.relay.error.connect_failed')
  }
  if (errorKey === 'disconnected') {
    return t('settingsDialog.relay.error.disconnected', {
      reason: resolveRelayReason(params.reasonCode, status?.lastCloseReason),
    })
  }
  if (errorKey === 'rejected') {
    return t('settingsDialog.relay.error.rejected', {
      reason: resolveRelayReason(params.reasonCode, status?.lastCloseReason),
    })
  }
  if (errorKey === 'closed_with_code') {
    return t('settingsDialog.relay.error.closedWithCode', {
      code: params.code || status?.lastCloseCode || 0,
    })
  }

  return String(status?.lastError || '').trim()
}

const relayStatusLabel = computed(() => {
  if (relayReconnecting.value) {
    return t('settingsDialog.relay.status.reconnecting')
  }
  if (relaySaving.value || relayToggleSaving.value) {
    return t('settingsDialog.relay.status.saving')
  }
  if (relayLoading.value) {
    return t('settingsDialog.relay.status.loading')
  }
  if (relayStatus.value?.reconnectPaused) {
    return t('settingsDialog.relay.status.paused')
  }
  if (relayStatus.value?.connected) {
    return t('settingsDialog.relay.status.connected')
  }
  if ((relayStatus.value?.enabled ?? relayForm.enabled) && Number(relayStatus.value?.nextReconnectDelayMs || 0) > 0) {
    return t('settingsDialog.relay.status.waitingReconnect')
  }
  if (relayForm.enabled) {
    return t('settingsDialog.relay.status.disconnected')
  }
  return t('settingsDialog.relay.status.disabled')
})

const relayStatusClass = computed(() => {
  if (relayStatus.value?.reconnectPaused) {
    return 'theme-status-danger'
  }
  if (relayStatus.value?.connected) {
    return 'theme-status-success'
  }
  if (relayForm.enabled) {
    return 'theme-status-warning'
  }
  return 'theme-status-neutral'
})

const showRelayDefaultHint = computed(() => (
  !relayManagedByEnv.value
  && !relayError.value
  && !relaySuccess.value
  && !relayStatus.value?.lastError
  && !relayStatus.value?.lastCloseReason
  && !relayStatus.value?.lastConnectedAt
))

const relayDiagnosticsText = computed(() => {
  const maskedToken = relayForm.deviceToken
    ? `${'*'.repeat(Math.max(0, relayForm.deviceToken.length - 4))}${relayForm.deviceToken.slice(-4)}`
    : ''

  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'local-settings',
    config: {
      enabled: relayForm.enabled,
      relayUrl: relayForm.relayUrl,
      deviceId: relayForm.deviceId,
      deviceTokenMasked: maskedToken,
      managedByEnv: relayManagedByEnv.value,
    },
    status: relayStatus.value || null,
  }, null, 2)
})

const runnerDiagnostics = computed(() => systemDiagnostics.value?.runner?.runner || null)
const runnerDiagnosticsOk = computed(() => Boolean(systemDiagnostics.value?.runner?.ok && runnerDiagnostics.value))
const runnerMetrics = computed(() => runnerDiagnostics.value?.metrics || null)
const recoveryDiagnostics = computed(() => systemDiagnostics.value?.recovery || null)
const maintenanceDiagnostics = computed(() => systemDiagnostics.value?.maintenance || null)
const gitDiffWorkerDiagnostics = computed(() => systemDiagnostics.value?.gitDiffWorker || null)

const systemDiagnosticsText = computed(() => JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'local-settings',
  config: {
    runner: {
      maxConcurrentRuns: systemForm.runnerMaxConcurrentRuns,
      managedByEnv: systemManagedByEnv.runnerMaxConcurrentRuns,
    },
  },
  diagnostics: systemDiagnostics.value || null,
}, null, 2))

function formatDateTime(value) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return t('common.notAvailable')
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    return normalized
  }

  return formatLocaleDateTime(parsed.toISOString(), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const runnerStopReasonRows = computed(() => ([
  {
    key: 'queued_cancelled',
    label: t('settingsDialog.system.stopReasons.queued_cancelled'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.queued_cancelled) || 0),
  },
  {
    key: 'user_requested',
    label: t('settingsDialog.system.stopReasons.user_requested'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.user_requested) || 0),
  },
  {
    key: 'user_requested_after_error',
    label: t('settingsDialog.system.stopReasons.user_requested_after_error'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.user_requested_after_error) || 0),
  },
  {
    key: 'stop_timeout',
    label: t('settingsDialog.system.stopReasons.stop_timeout'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.stop_timeout) || 0),
  },
]))

const runnerStopTimeoutPhaseRows = computed(() => ([
  {
    key: 'runner_timeout_without_stop_request',
    label: t('settingsDialog.system.stopTimeoutPhases.runner_timeout_without_stop_request'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_timeout_without_stop_request) || 0),
  },
  {
    key: 'runner_timeout_before_cancel',
    label: t('settingsDialog.system.stopTimeoutPhases.runner_timeout_before_cancel'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_timeout_before_cancel) || 0),
  },
  {
    key: 'cli_not_exiting',
    label: t('settingsDialog.system.stopTimeoutPhases.cli_not_exiting'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.cli_not_exiting) || 0),
  },
  {
    key: 'os_kill_slow',
    label: t('settingsDialog.system.stopTimeoutPhases.os_kill_slow'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.os_kill_slow) || 0),
  },
  {
    key: 'runner_finalize_after_exit',
    label: t('settingsDialog.system.stopTimeoutPhases.runner_finalize_after_exit'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_finalize_after_exit) || 0),
  },
]))

const localeFieldOptions = computed(() => localeOptions.value.map((item) => ({
  value: item.value,
  label: item.value === 'zh-CN' ? t('locale.zhHans') : t('locale.enUs'),
  englishLabel: item.englishLabel,
})))
const notificationChannelOptions = computed(() => TASK_NOTIFICATION_CHANNEL_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'dingtalk'
    ? t('taskDialog.sections.notification.channelDingtalk')
    : option.value === 'feishu'
      ? t('taskDialog.sections.notification.channelFeishu')
      : option.value === 'webhook'
        ? t('taskDialog.sections.notification.channelWebhook')
        : option.label,
})))
const notificationTriggerOptions = computed(() => TASK_NOTIFICATION_TRIGGER_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'completed'
    ? t('taskDialog.sections.notification.triggerCompleted')
    : option.value === 'success'
      ? t('taskDialog.sections.notification.triggerSuccess')
      : option.value === 'error'
        ? t('taskDialog.sections.notification.triggerError')
        : option.label,
})))
const notificationMessageModeOptions = computed(() => TASK_NOTIFICATION_MESSAGE_MODE_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'summary'
    ? t('taskDialog.sections.notification.messageSummary')
    : option.label,
})))
const notificationLocaleOptions = computed(() => TASK_NOTIFICATION_LOCALE_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'zh-CN'
    ? t('taskDialog.sections.notification.localeZhCn')
    : option.value === 'en-US'
      ? t('taskDialog.sections.notification.localeEnUs')
      : option.label,
})))
const notificationProfileOptions = computed(() => (
  notificationProfiles.value.map((profile) => ({
    value: String(profile.id),
    label: profile.name,
  }))
))
const selectedNotificationProfile = computed(() => (
  notificationProfiles.value.find((profile) => String(profile.id) === String(profileForm.id || '')) || null
))

async function loadMeta() {
  versionLoading.value = true
  versionError.value = ''

  try {
    const payload = await getMeta()
    const nextVersion = String(payload?.version || '').trim()
    version.value = nextVersion
    if (!nextVersion) {
      versionError.value = t('settingsDialog.about.versionPending')
    }
  } catch (error) {
    version.value = ''
    versionError.value = error?.message || t('settingsDialog.about.versionLoadFailed')
  } finally {
    versionLoading.value = false
  }
}

function syncRelayForm(payload = {}) {
  relayForm.enabled = Boolean(payload?.enabled)
  relayForm.relayUrl = String(payload?.relayUrl || '')
  relayForm.deviceId = String(payload?.deviceId || '')
  relayForm.deviceToken = String(payload?.deviceToken || '')
}

function syncSystemForm(payload = {}) {
  systemForm.runnerMaxConcurrentRuns = Math.max(1, Number(payload?.runner?.maxConcurrentRuns) || 3)
  systemForm.defaultNotificationProfileId = payload?.notification?.defaultProfileId ? String(payload.notification.defaultProfileId) : ''
  systemForm.workspaceRootPath = String(payload?.workspace?.rootPath || '')
}

function resetNotificationProfileForm() {
  profileForm.id = ''
  profileForm.name = ''
  profileForm.channelType = 'dingtalk'
  profileForm.webhookUrl = ''
  profileForm.secret = ''
  profileForm.triggerOn = 'completed'
  profileForm.locale = String(locale.value || 'zh-CN')
  profileForm.messageMode = 'summary'
}

function applyNotificationProfileToForm(profile = null) {
  if (!profile) {
    resetNotificationProfileForm()
    return
  }

  profileForm.id = String(profile.id || '')
  profileForm.name = String(profile.name || '')
  profileForm.channelType = String(profile.channelType || 'dingtalk')
  profileForm.webhookUrl = String(profile.webhookUrl || '')
  profileForm.secret = String(profile.secret || '')
  profileForm.triggerOn = String(profile.triggerOn || 'completed')
  profileForm.locale = String(profile.locale || locale.value || 'zh-CN')
  profileForm.messageMode = String(profile.messageMode || 'summary')
}

function buildNotificationProfilePayload() {
  return {
    name: profileForm.name,
    channelType: profileForm.channelType,
    webhookUrl: profileForm.webhookUrl,
    secret: profileForm.secret,
    triggerOn: profileForm.triggerOn,
    locale: profileForm.locale,
    messageMode: profileForm.messageMode,
  }
}

async function loadRelayConfig() {
  relayLoading.value = true
  relayError.value = ''
  relaySuccess.value = ''

  try {
    const payload = await getRelayConfig()
    syncRelayForm(payload?.config || {})
    relayManagedByEnv.value = Boolean(payload?.managedByEnv)
    relayStatus.value = payload?.relay || null
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayConfigLoadFailed')
    relayStatus.value = null
  } finally {
    relayLoading.value = false
  }
}

async function loadSystemConfig() {
  systemLoading.value = true
  systemError.value = ''
  systemSuccess.value = ''

  try {
    const payload = await getSystemConfig()
    syncSystemForm(payload?.config || {})
    systemManagedByEnv.runnerMaxConcurrentRuns = Boolean(payload?.managedByEnv?.runner?.maxConcurrentRuns)
    loadRuntimeDiagnostics()
  } catch (error) {
    systemError.value = error?.message || t('settingsDialog.system.systemConfigLoadFailed')
  } finally {
    systemLoading.value = false
  }
}

async function loadNotificationProfileOptions() {
  notificationProfilesLoading.value = true
  notificationProfilesError.value = ''

  try {
    const payload = await listNotificationProfiles()
    notificationProfiles.value = Array.isArray(payload?.items) ? payload.items : []

    if (profileForm.id) {
      applyNotificationProfileToForm(selectedNotificationProfile.value)
    } else if (notificationProfiles.value.length) {
      const defaultProfile = notificationProfiles.value.find((item) => String(item.id) === String(systemForm.defaultNotificationProfileId || ''))
      applyNotificationProfileToForm(defaultProfile || notificationProfiles.value[0])
    } else {
      applyNotificationProfileToForm(null)
    }
  } catch (error) {
    notificationProfilesError.value = error?.message || t('taskDialog.sections.notification.profileLoadFailed')
    notificationProfiles.value = []
    applyNotificationProfileToForm(null)
  } finally {
    notificationProfilesLoading.value = false
  }
}

async function loadRuntimeDiagnostics() {
  systemDiagnosticsLoading.value = true
  systemDiagnosticsError.value = ''

  try {
    systemDiagnostics.value = await getRuntimeDiagnostics()
  } catch (error) {
    systemDiagnosticsError.value = error?.message || t('settingsDialog.system.systemDiagnosticsLoadFailed')
  } finally {
    systemDiagnosticsLoading.value = false
  }
}

async function handleSaveRelay() {
  relaySaving.value = true
  relayError.value = ''
  relaySuccess.value = ''

  try {
    const payload = await updateRelayConfig({
      enabled: relayForm.enabled,
      relayUrl: relayForm.relayUrl,
      deviceId: relayForm.deviceId,
      deviceToken: relayForm.deviceToken,
    })
    syncRelayForm(payload?.config || {})
    relayManagedByEnv.value = Boolean(payload?.managedByEnv)
    relayStatus.value = payload?.relay || null
    relaySuccess.value = relayForm.enabled
      ? t('settingsDialog.relay.relayConfigSavedEnabled')
      : t('settingsDialog.relay.relayConfigSavedDisabled')
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayConfigSaveFailed')
  } finally {
    relaySaving.value = false
  }
}

async function handleReconnectRelay() {
  relayReconnecting.value = true
  relayError.value = ''
  relaySuccess.value = ''

  try {
    const payload = await reconnectRelay()
    relayStatus.value = payload?.relay || null
    relaySuccess.value = t('settingsDialog.relay.relayReconnectTriggered')
    setTimeout(() => {
      loadRelayConfig()
    }, 1200)
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayReconnectFailed')
  } finally {
    relayReconnecting.value = false
  }
}

async function handleSaveSystem() {
  systemSaving.value = true
  systemError.value = ''
  systemSuccess.value = ''

  try {
    const payload = await updateSystemConfig({
      runner: {
        maxConcurrentRuns: systemForm.runnerMaxConcurrentRuns,
      },
      notification: {
        defaultProfileId: systemForm.defaultNotificationProfileId || null,
      },
      workspace: {
        rootPath: systemForm.workspaceRootPath,
      },
    })
    syncSystemForm(payload?.config || {})
    systemManagedByEnv.runnerMaxConcurrentRuns = Boolean(payload?.managedByEnv?.runner?.maxConcurrentRuns)
    systemSuccess.value = t('settingsDialog.system.systemConfigSaved')
    loadRuntimeDiagnostics()
  } catch (error) {
    systemError.value = error?.message || t('settingsDialog.system.systemConfigSaveFailed')
  } finally {
    systemSaving.value = false
  }
}

async function handleSaveNotificationProfile() {
  if (notificationProfileSaving.value || notificationProfileDeleting.value) {
    return
  }

  notificationProfileSaving.value = true
  notificationProfilesError.value = ''
  systemError.value = ''
  systemSuccess.value = ''

  try {
    let profile
    if (profileForm.id) {
      profile = await updateNotificationProfile(profileForm.id, buildNotificationProfilePayload())
    } else {
      profile = await createNotificationProfile(buildNotificationProfilePayload())
    }

    await loadNotificationProfileOptions()
    applyNotificationProfileToForm(profile)
    systemForm.defaultNotificationProfileId = systemForm.defaultNotificationProfileId || String(profile.id || '')
    systemSuccess.value = t('settingsDialog.notification.profileSaved')
  } catch (error) {
    notificationProfilesError.value = error?.message || t('taskDialog.sections.notification.profileSaveFailed')
  } finally {
    notificationProfileSaving.value = false
  }
}

async function handleDeleteNotificationProfile() {
  if (!profileForm.id || notificationProfileDeleting.value || notificationProfileSaving.value) {
    return
  }

  notificationProfileDeleting.value = true
  notificationProfilesError.value = ''
  systemError.value = ''
  systemSuccess.value = ''

  try {
    const deletingProfileId = String(profileForm.id)
    await deleteNotificationProfile(deletingProfileId)
    if (String(systemForm.defaultNotificationProfileId || '') === deletingProfileId) {
      systemForm.defaultNotificationProfileId = ''
      await handleSaveSystem()
    }
    await loadNotificationProfileOptions()
    systemSuccess.value = t('settingsDialog.notification.profileDeleted')
  } catch (error) {
    notificationProfilesError.value = error?.message || t('taskDialog.sections.notification.profileDeleteFailed')
  } finally {
    notificationProfileDeleting.value = false
  }
}

async function handleSetDefaultNotificationProfile(profileId = '') {
  systemForm.defaultNotificationProfileId = String(profileId || '').trim()
  await handleSaveSystem()
}

function hasCompleteRelayFields() {
  return Boolean(
    String(relayForm.relayUrl || '').trim()
    && String(relayForm.deviceId || '').trim()
    && String(relayForm.deviceToken || '').trim()
  )
}

async function handleToggleRelayEnabled() {
  if (relayManagedByEnv.value) {
    return
  }

  relayError.value = ''
  relaySuccess.value = ''

  if (relayForm.enabled && !hasCompleteRelayFields()) {
    relayForm.enabled = false
    relayError.value = t('settingsDialog.relay.relayFieldsRequired')
    return
  }

  relayToggleSaving.value = true
  try {
    const payload = await updateRelayConfig({
      enabled: relayForm.enabled,
      relayUrl: relayForm.relayUrl,
      deviceId: relayForm.deviceId,
      deviceToken: relayForm.deviceToken,
    })
    syncRelayForm(payload?.config || {})
    relayManagedByEnv.value = Boolean(payload?.managedByEnv)
    relayStatus.value = payload?.relay || null
    relaySuccess.value = relayForm.enabled
      ? t('settingsDialog.relay.relayEnabledSaved')
      : t('settingsDialog.relay.relayConfigSavedDisabled')
  } catch (error) {
    relayForm.enabled = Boolean(relayStatus.value?.enabled)
    relayError.value = error?.message || t('settingsDialog.relay.relayToggleFailed')
  } finally {
    relayToggleSaving.value = false
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

async function handleCopyRelayDiagnostics() {
  try {
    await copyText(relayDiagnosticsText.value)
    relayCopied.value = true
    if (relayCopyTimer) {
      clearTimeout(relayCopyTimer)
    }
    relayCopyTimer = setTimeout(() => {
      relayCopied.value = false
      relayCopyTimer = null
    }, 2000)
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayDiagnosticsCopyFailed')
  }
}

async function handleCopySystemDiagnostics() {
  try {
    await copyText(systemDiagnosticsText.value)
    systemCopied.value = true
    if (systemCopyTimer) {
      clearTimeout(systemCopyTimer)
    }
    systemCopyTimer = setTimeout(() => {
      systemCopied.value = false
      systemCopyTimer = null
    }, 2000)
  } catch (error) {
    systemDiagnosticsError.value = error?.message || t('settingsDialog.system.systemDiagnosticsCopyFailed')
  }
}

function handleLocaleChange(nextLocale) {
  setLocale(nextLocale)
}

function stopSystemDiagnosticsPolling() {
  if (systemDiagnosticsTimer) {
    clearInterval(systemDiagnosticsTimer)
    systemDiagnosticsTimer = null
  }
}

function startSystemDiagnosticsPolling() {
  stopSystemDiagnosticsPolling()
  if (!props.open || activeSection.value !== 'system') {
    return
  }

  loadRuntimeDiagnostics()
  systemDiagnosticsTimer = setInterval(() => {
    loadRuntimeDiagnostics()
  }, 5000)
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeSection.value = 'theme'
      loadMeta()
      loadRelayConfig()
      loadSystemConfig()
      loadNotificationProfileOptions()
      return
    }
  },
  { immediate: true }
)

watch(
  [() => props.open, activeSection],
  ([open, section]) => {
    if (open && section === 'system') {
      startSystemDiagnosticsPolling()
      return
    }

    stopSystemDiagnosticsPolling()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (relayCopyTimer) {
    clearTimeout(relayCopyTimer)
    relayCopyTimer = null
  }
  if (systemCopyTimer) {
    clearTimeout(systemCopyTimer)
    systemCopyTimer = null
  }
  stopSystemDiagnosticsPolling()
})

watch(selectedNotificationProfile, (profile) => {
  if (profile) {
    applyNotificationProfileToForm(profile)
  }
})
</script>

<template>
  <DialogShell
    :open="open"
    backdrop-class="z-[70] items-end justify-center px-0 py-0 sm:items-center sm:px-4 sm:py-6"
    panel-class="settings-dialog-panel h-full max-w-5xl sm:h-[42rem] sm:max-h-[88vh]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body min-h-0 flex flex-1 flex-col sm:flex-row"
    @close="emit('close')"
  >
    <template #title>
      <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
        <Settings2 class="h-4 w-4" />
        <span>{{ t('common.settings') }}</span>
      </div>
    </template>

    <DialogSideNav
      v-model="activeSection"
      :sections="settingsSections"
    />

    <div class="settings-dialog-content min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <section
              v-if="activeSection === 'theme'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading text-base font-medium">{{ t('theme.title') }}</div>
                <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('theme.sectionDescription') }}</p>
              </div>

              <section class="settings-section-card px-4 py-4">
                <ThemeToggle />
              </section>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <div>
                  <div class="theme-heading text-sm font-medium">{{ t('locale.title') }}</div>
                  <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('locale.description') }}</p>
                </div>

                <label class="block space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('locale.field') }}</span>
                  <WorkbenchSelect
                    :model-value="locale"
                    :options="localeFieldOptions"
                    :get-option-value="(option) => option.value"
                    @update:model-value="handleLocaleChange"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                    <template #option="{ option, selected, select }">
                      <button
                        type="button"
                        class="workbench-select-option theme-filter-idle w-full rounded-sm border border-dashed px-3 py-2 text-left text-sm"
                        @click="select()"
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="min-w-0">
                            <div class="truncate text-[var(--theme-textPrimary)]">{{ option.label }}</div>
                            <div class="theme-muted-text mt-1 truncate text-xs">{{ option.englishLabel }}</div>
                          </div>
                          <span v-if="selected" class="theme-status-success rounded-sm border border-dashed px-2 py-0.5 text-[10px]">{{ t('common.enabled') }}</span>
                        </div>
                      </button>
                    </template>
                  </WorkbenchSelect>
                </label>

                <p class="theme-muted-text theme-note-text">{{ t('locale.immediateHint') }}</p>
              </section>
            </section>

            <section
              v-else-if="activeSection === 'relay'"
              class="space-y-4"
            >
              <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                      <Wifi class="h-4 w-4" />
                    <span>{{ t('settingsDialog.relay.title') }}</span>
                  </div>
                </div>
                <span
                  class="rounded-sm border border-dashed px-2.5 py-1 text-xs font-medium"
                  :class="relayStatusClass"
                >
                  {{ relayStatusLabel }}
                </span>
              </div>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <label class="settings-form-card flex items-center justify-between gap-3 px-3 py-2">
                  <div>
                    <div class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ t('settingsDialog.relay.enableTitle') }}</div>
                    <p class="theme-muted-text mt-1 text-xs">{{ t('settingsDialog.relay.enableDescription') }}</p>
                  </div>
                  <input
                    v-model="relayForm.enabled"
                    type="checkbox"
                    class="h-4 w-4"
                    :disabled="relayManagedByEnv"
                    @change="handleToggleRelayEnabled"
                  />
                </label>

                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="space-y-1.5 sm:col-span-2">
                    <span class="theme-muted-text text-xs">{{ t('settingsDialog.relay.relayUrl') }}</span>
                    <input
                      v-model="relayForm.relayUrl"
                      type="text"
                      placeholder="https://user1.promptx.example.com"
                      class="tool-input"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">{{ t('settingsDialog.relay.deviceId') }}</span>
                    <input
                      v-model="relayForm.deviceId"
                      type="text"
                      placeholder="my-macbook"
                      class="tool-input"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">{{ t('settingsDialog.relay.deviceToken') }}</span>
                    <div class="relative">
                      <input
                        v-model="relayForm.deviceToken"
                        :type="relayTokenVisible ? 'text' : 'password'"
                        :placeholder="t('settingsDialog.relay.deviceTokenPlaceholder')"
                        class="tool-input pr-10"
                        :disabled="relayManagedByEnv"
                      >
                      <button
                        type="button"
                        class="theme-icon-button absolute inset-y-1 right-1 flex h-auto w-8 items-center justify-center"
                        :disabled="relayManagedByEnv"
                        @click="relayTokenVisible = !relayTokenVisible"
                      >
                        <Eye v-if="!relayTokenVisible" class="h-4 w-4" />
                        <EyeOff v-else class="h-4 w-4" />
                      </button>
                    </div>
                  </label>
                </div>

                <div class="settings-form-footer flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0 space-y-1">
                    <p
                      v-if="relayStatus?.reconnectPausedReason"
                      class="theme-danger-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.pausedReconnect', { reason: resolveRelayReason(relayStatus.reconnectPausedReasonCode, relayStatus.reconnectPausedReason) }) }}
                    </p>
                    <p
                      v-if="relayManagedByEnv"
                      class="theme-status-warning theme-note-text"
                    >
                      {{ t('settingsDialog.relay.managedByEnv') }}
                    </p>
                    <p v-if="relayError" class="theme-danger-text theme-note-text">{{ relayError }}</p>
                    <p v-else-if="relaySuccess" class="theme-status-success theme-note-text">{{ relaySuccess }}</p>
                    <p
                      v-else-if="relayStatus?.lastError"
                      class="theme-danger-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.lastError', { value: resolveRelayErrorText(relayStatus) }) }}
                    </p>
                    <p
                      v-else-if="relayStatus?.lastCloseReason"
                      class="theme-muted-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.lastClosed', { reason: resolveRelayReason(relayStatus.lastCloseReasonCode, relayStatus.lastCloseReason), code: relayStatus.lastCloseCode }) }}
                    </p>
                    <p
                      v-else-if="relayStatus?.lastConnectedAt"
                      class="theme-muted-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.lastConnected', { value: formatDateTime(relayStatus.lastConnectedAt) }) }}
                    </p>
                    <p
                      v-if="relayStatus?.recentEvents?.length"
                      class="theme-muted-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.recentEvent', { value: resolveRelayEventLabel(relayStatus.recentEvents[0]) }) }}
                    </p>
                    <p
                      v-if="relayCopied"
                      class="theme-status-success theme-note-text"
                    >
                      {{ t('settingsDialog.relay.copied') }}
                    </p>
                    <p v-if="showRelayDefaultHint" class="theme-muted-text theme-note-text">
                      {{ t('settingsDialog.relay.defaultHint') }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relaySaving || relayToggleSaving || relayReconnecting || !(relayStatus?.enabled ?? relayForm.enabled)"
                      @click="handleReconnectRelay"
                    >
                      <LoaderCircle v-if="relayReconnecting" class="h-4 w-4 animate-spin" />
                      <span>{{ relayReconnecting ? t('settingsDialog.relay.reconnecting') : t('settingsDialog.relay.reconnectNow') }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relayReconnecting"
                      @click="handleCopyRelayDiagnostics"
                    >
                      <span>{{ relayCopied ? t('settingsDialog.relay.diagnosticsCopied') : t('settingsDialog.relay.copyDiagnostics') }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relaySaving || relayToggleSaving || relayReconnecting || relayManagedByEnv"
                      @click="handleSaveRelay"
                    >
                      <LoaderCircle v-if="relaySaving" class="h-4 w-4 animate-spin" />
                      <span>{{ relaySaving ? t('common.saving') : t('settingsDialog.relay.saveConfig') }}</span>
                    </button>
                  </div>
                </div>
              </section>
            </section>

            <section
              v-else-if="activeSection === 'notification'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                  <Bell class="h-4 w-4" />
                  <span>{{ t('settingsDialog.notification.title') }}</span>
                </div>
                <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('settingsDialog.notification.intro') }}</p>
              </div>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('settingsDialog.notification.defaultProfile') }}</span>
                  <WorkbenchSelect
                    v-model="systemForm.defaultNotificationProfileId"
                    :options="notificationProfileOptions"
                    :disabled="notificationProfilesLoading || systemSaving"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('settingsDialog.notification.defaultProfilePlaceholder') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                  <p class="theme-muted-text text-xs leading-5">{{ t('settingsDialog.notification.defaultProfileHint') }}</p>
                </label>

                <div class="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                    :disabled="systemSaving"
                    @click="handleSaveSystem"
                  >
                    <LoaderCircle v-if="systemSaving" class="h-4 w-4 animate-spin" />
                    <span>{{ systemSaving ? t('common.saving') : t('settingsDialog.notification.saveDefault') }}</span>
                  </button>
                </div>

                <div class="theme-divider rounded-sm border border-dashed px-3 py-3">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.notification.profileListTitle') }}</div>
                      <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('settingsDialog.notification.profileListIntro') }}</p>
                    </div>
                    <button
                      type="button"
                      class="tool-button px-3 py-2 text-xs"
                      :disabled="notificationProfileSaving || notificationProfileDeleting"
                      @click="applyNotificationProfileToForm(null)"
                    >
                      {{ t('taskDialog.sections.notification.newProfile') }}
                    </button>
                  </div>

                  <div class="mt-3 space-y-2">
                    <button
                      v-for="profile in notificationProfiles"
                      :key="profile.id"
                      type="button"
                      class="settings-form-card w-full rounded-sm border px-3 py-3 text-left"
                      @click="applyNotificationProfileToForm(profile)"
                    >
                      <div class="flex items-center justify-between gap-3">
                        <div class="min-w-0">
                          <div class="truncate text-sm font-medium text-[var(--theme-textPrimary)]">{{ profile.name }}</div>
                          <div class="theme-muted-text mt-1 truncate text-xs">
                            {{ profile.channelType }} · {{ profile.triggerOn }} · {{ profile.locale }}
                          </div>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                          <span
                            v-if="String(systemForm.defaultNotificationProfileId || '') === String(profile.id)"
                            class="theme-status-success rounded-sm border border-dashed px-2 py-0.5 text-[10px]"
                          >
                            {{ t('settingsDialog.notification.defaultBadge') }}
                          </span>
                          <button
                            type="button"
                            class="tool-button px-2.5 py-1.5 text-[11px]"
                            @click.stop="handleSetDefaultNotificationProfile(profile.id)"
                          >
                            {{ t('settingsDialog.notification.setDefault') }}
                          </button>
                        </div>
                      </div>
                    </button>
                  </div>

                  <div class="mt-4 grid gap-4 sm:grid-cols-2">
                    <label class="space-y-1.5 sm:col-span-2">
                      <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.profileName') }}</span>
                      <input
                        v-model="profileForm.name"
                        type="text"
                        class="tool-input"
                        :placeholder="t('taskDialog.sections.notification.profileNamePlaceholder')"
                        :disabled="notificationProfileSaving || notificationProfileDeleting"
                      />
                    </label>

                    <label class="space-y-1.5">
                      <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.channelType') }}</span>
                      <WorkbenchSelect
                        v-model="profileForm.channelType"
                        :options="notificationChannelOptions"
                        :disabled="notificationProfileSaving || notificationProfileDeleting"
                        :get-option-value="(option) => option.value"
                      >
                        <template #trigger="{ selectedOption }">
                          <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                            {{ selectedOption?.label || t('common.select') }}
                          </div>
                        </template>
                      </WorkbenchSelect>
                    </label>

                    <label class="space-y-1.5">
                      <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.triggerOn') }}</span>
                      <WorkbenchSelect
                        v-model="profileForm.triggerOn"
                        :options="notificationTriggerOptions"
                        :disabled="notificationProfileSaving || notificationProfileDeleting"
                        :get-option-value="(option) => option.value"
                      >
                        <template #trigger="{ selectedOption }">
                          <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                            {{ selectedOption?.label || t('common.select') }}
                          </div>
                        </template>
                      </WorkbenchSelect>
                    </label>

                    <label class="space-y-1.5 sm:col-span-2">
                      <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.webhookUrl') }}</span>
                      <input
                        v-model="profileForm.webhookUrl"
                        type="text"
                        class="tool-input"
                        :placeholder="t('taskDialog.sections.notification.webhookUrlPlaceholder')"
                        :disabled="notificationProfileSaving || notificationProfileDeleting"
                      />
                    </label>

                    <label class="space-y-1.5">
                      <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.secret') }}</span>
                      <input
                        v-model="profileForm.secret"
                        type="text"
                        class="tool-input"
                        :placeholder="t('taskDialog.sections.notification.secretPlaceholder')"
                        :disabled="notificationProfileSaving || notificationProfileDeleting"
                      />
                    </label>

                    <label class="space-y-1.5">
                      <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.locale') }}</span>
                      <WorkbenchSelect
                        v-model="profileForm.locale"
                        :options="notificationLocaleOptions"
                        :disabled="notificationProfileSaving || notificationProfileDeleting"
                        :get-option-value="(option) => option.value"
                      >
                        <template #trigger="{ selectedOption }">
                          <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                            {{ selectedOption?.label || t('common.select') }}
                          </div>
                        </template>
                      </WorkbenchSelect>
                    </label>

                    <label class="space-y-1.5 sm:col-span-2">
                      <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.messageMode') }}</span>
                      <WorkbenchSelect
                        v-model="profileForm.messageMode"
                        :options="notificationMessageModeOptions"
                        :disabled="notificationProfileSaving || notificationProfileDeleting"
                        :get-option-value="(option) => option.value"
                      >
                        <template #trigger="{ selectedOption }">
                          <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                            {{ selectedOption?.label || t('common.select') }}
                          </div>
                        </template>
                      </WorkbenchSelect>
                    </label>
                  </div>

                  <div class="mt-3 flex flex-col gap-2 sm:flex-row sm:justify-end">
                    <button
                      type="button"
                      class="tool-button inline-flex items-center justify-center gap-2 px-3 py-2 text-xs"
                      :disabled="notificationProfileSaving || notificationProfileDeleting || !profileForm.id"
                      @click="handleDeleteNotificationProfile"
                    >
                      <LoaderCircle v-if="notificationProfileDeleting" class="h-4 w-4 animate-spin" />
                      <Trash2 v-else class="h-4 w-4" />
                      <span>{{ t('taskDialog.sections.notification.deleteProfile') }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button tool-button-primary inline-flex items-center justify-center gap-2 px-3 py-2 text-xs"
                      :disabled="notificationProfileSaving || notificationProfileDeleting"
                      @click="handleSaveNotificationProfile"
                    >
                      <LoaderCircle v-if="notificationProfileSaving" class="h-4 w-4 animate-spin" />
                      <Save v-else class="h-4 w-4" />
                      <span>{{ profileForm.id ? t('taskDialog.sections.notification.saveProfile') : t('taskDialog.sections.notification.createProfile') }}</span>
                    </button>
                  </div>

                  <p v-if="notificationProfilesError" class="theme-danger-text mt-3 text-sm">
                    {{ notificationProfilesError }}
                  </p>
                  <p v-else-if="systemSuccess" class="theme-status-success mt-3 text-sm">
                    {{ systemSuccess }}
                  </p>
                </div>
              </section>
            </section>

            <section
              v-else-if="activeSection === 'system'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                  <Cpu class="h-4 w-4" />
                  <span>{{ t('settingsDialog.system.title') }}</span>
                </div>
                <p class="theme-muted-text mt-1 text-xs leading-5">
                  {{ t('settingsDialog.system.intro') }}
                </p>
              </div>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">项目根目录</span>
                  <input
                    v-model="systemForm.workspaceRootPath"
                    type="text"
                    class="tool-input"
                    placeholder="留空则使用系统用户目录（~/）"
                    :disabled="systemLoading || systemSaving"
                  >
                  <p class="theme-muted-text text-xs leading-5">
                    新建项目时，文件目录浏览将从此路径开始。例如 /Users/me/projects 或 /workspace。
                  </p>
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('settingsDialog.system.maxConcurrentRuns') }}</span>
                  <input
                    v-model.number="systemForm.runnerMaxConcurrentRuns"
                    type="number"
                    min="1"
                    max="16"
                    step="1"
                    class="tool-input"
                    :disabled="systemManagedByEnv.runnerMaxConcurrentRuns || systemLoading || systemSaving"
                  >
                  <p class="theme-muted-text text-xs leading-5">
                    {{ t('settingsDialog.system.maxConcurrentRunsHint') }}
                  </p>
                </label>

                <div class="settings-form-footer flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0 space-y-1">
                    <p
                      v-if="systemManagedByEnv.runnerMaxConcurrentRuns"
                      class="theme-status-warning theme-note-text"
                    >
                      {{ t('settingsDialog.system.managedByEnv') }}
                    </p>
                    <p v-else-if="systemError" class="theme-danger-text theme-note-text">{{ systemError }}</p>
                    <p v-else-if="systemSuccess" class="theme-status-success theme-note-text">{{ systemSuccess }}</p>
                    <p v-else class="theme-muted-text theme-note-text">
                      {{ t('settingsDialog.system.diagnosticsHint') }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="systemManagedByEnv.runnerMaxConcurrentRuns || systemLoading || systemSaving"
                      @click="handleSaveSystem"
                    >
                      <LoaderCircle v-if="systemSaving" class="h-4 w-4 animate-spin" />
                      <span>{{ systemSaving ? t('common.saving') : t('settingsDialog.system.saveConfig') }}</span>
                    </button>
                  </div>
                </div>
              </section>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.runtimeDiagnostics') }}</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">
                      {{ t('settingsDialog.system.runtimeDiagnosticsHint') }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="systemDiagnosticsLoading"
                      @click="loadRuntimeDiagnostics"
                    >
                      <LoaderCircle v-if="systemDiagnosticsLoading" class="h-4 w-4 animate-spin" />
                      <span>{{ systemDiagnosticsLoading ? t('settingsDialog.system.refreshingDiagnostics') : t('settingsDialog.system.refreshDiagnostics') }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      @click="handleCopySystemDiagnostics"
                    >
                      <span>{{ systemCopied ? t('settingsDialog.system.diagnosticsCopied') : t('settingsDialog.system.copyDiagnostics') }}</span>
                    </button>
                  </div>
                </div>

                <div class="min-w-0 space-y-1">
                  <p v-if="systemDiagnosticsError" class="theme-danger-text theme-note-text">{{ systemDiagnosticsError }}</p>
                  <p v-else-if="systemCopied" class="theme-status-success theme-note-text">
                    {{ t('settingsDialog.system.diagnosticsCopiedHint') }}
                  </p>
                  <p v-else class="theme-muted-text theme-note-text">
                    {{ t('settingsDialog.system.diagnosticsHint') }}
                  </p>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">active</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.activeRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.active') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">tracked</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.trackedRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.tracked') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">queued</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.queuedRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.queued') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">maxConcurrent</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.config?.maxConcurrentRuns || systemForm.runnerMaxConcurrentRuns }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.maxConcurrent') }}</p>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">completed</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalCompleted || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.completed') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">stopped</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalStopped || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.stopped') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">error</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalErrored || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.error') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">stop_timeout</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalStopTimeout || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.stopTimeout') }}</p>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">event flush failures</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.eventFlushFailureCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.eventWriteFailures') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">recovered runs</div>
                    <div class="theme-heading text-lg font-medium">{{ recoveryDiagnostics?.metrics?.totalRecovered || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.recoveredRuns') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">last cleanup</div>
                    <div class="theme-heading text-sm font-medium">{{ formatDateTime(maintenanceDiagnostics?.lastCleanup?.finishedAt) }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.lastMaintenanceAt') }}</p>
                  </div>
                </div>

                <div class="grid gap-4 lg:grid-cols-2">
                  <div class="settings-form-card space-y-3 px-3 py-3">
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.baseStatus') }}</div>
                    <div class="space-y-2 text-xs">
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">runner baseUrl</span>
                        <span class="truncate text-right text-[var(--theme-textPrimary)]">{{ systemDiagnostics?.runner?.baseUrl || '-' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">runner startedAt</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ formatDateTime(runnerDiagnostics?.startedAt) }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">last sweep</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ formatDateTime(recoveryDiagnostics?.metrics?.lastSweepFinishedAt) }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">git diff worker</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ gitDiffWorkerDiagnostics ? t('settingsDialog.system.available') : t('settingsDialog.system.unknown') }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">db vacuum</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ formatDateTime(maintenanceDiagnostics?.lastVacuumAt) }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="settings-form-card space-y-3 px-3 py-3">
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.stopReasonTitle') }}</div>
                    <div class="space-y-2 text-xs">
                      <div
                        v-for="item in runnerStopReasonRows"
                        :key="item.key"
                        class="flex items-center justify-between gap-3"
                      >
                        <span class="theme-muted-text">{{ item.label }}</span>
                        <span class="text-[var(--theme-textPrimary)]">{{ item.value }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="settings-form-card space-y-3 px-3 py-3"
                >
                  <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.stopTimeoutPhaseTitle') }}</div>
                  <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 text-xs">
                    <div
                      v-for="item in runnerStopTimeoutPhaseRows"
                      :key="item.key"
                      class="flex items-center justify-between gap-3 rounded-sm border border-dashed border-[var(--theme-borderMuted)] px-2.5 py-2"
                    >
                      <span class="theme-muted-text">{{ item.label }}</span>
                      <span class="text-[var(--theme-textPrimary)]">{{ item.value }}</span>
                    </div>
                  </div>
                </div>

                <div
                  v-if="!runnerDiagnosticsOk && !systemDiagnosticsLoading"
                  class="settings-form-card space-y-2 px-3 py-3"
                >
                  <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.runnerUnavailable') }}</div>
                  <p class="theme-muted-text text-xs leading-5">
                    {{ resolvePayloadMessage(systemDiagnostics?.runner, 'settingsDialog.system.runnerUnavailableDescription') }}
                  </p>
                  <p class="theme-muted-text text-xs leading-5">
                    baseUrl: {{ systemDiagnostics?.runner?.baseUrl || '-' }}
                  </p>
                </div>
              </section>
            </section>

            <section
              v-else
              class="space-y-4"
            >
              <div>
                <div class="theme-heading text-base font-medium">{{ t('settingsDialog.about.title') }}</div>
                <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('settingsDialog.about.intro') }}</p>
              </div>

              <section class="settings-section-card px-4 py-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.about.versionTitle') }}</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">
                      {{ versionError || t('settingsDialog.about.versionDescription') }}
                    </p>
                  </div>
                  <span class="theme-badge-strong rounded-sm border border-dashed px-2.5 py-1 text-xs font-medium">
                    {{ versionLoading ? t('common.loading') : version ? `v${version}` : t('common.unavailable') }}
                  </span>
                </div>
              </section>
            </section>
    </div>
  </DialogShell>
</template>
