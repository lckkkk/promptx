<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Cpu, Eye, EyeOff, Info, LoaderCircle, Palette, Settings2, Wifi, X } from 'lucide-vue-next'
import DialogSideNav from './DialogSideNav.vue'
import ThemeToggle from './ThemeToggle.vue'
import {
  getMeta,
  getRelayConfig,
  reconnectRelay,
  getRuntimeDiagnostics,
  getSystemConfig,
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
})
const activeSection = ref('theme')
let relayCopyTimer = null
let systemCopyTimer = null
let systemDiagnosticsTimer = null

const settingsSections = [
  {
    id: 'theme',
    label: '主题',
    description: '界面风格与配色',
    icon: Palette,
  },
  {
    id: 'relay',
    label: '远程',
    description: 'Relay 与手机访问',
    icon: Wifi,
  },
  {
    id: 'system',
    label: '系统',
    description: 'Runner 与性能配置',
    icon: Cpu,
  },
  {
    id: 'about',
    label: '关于',
    description: '版本与说明',
    icon: Info,
  },
]

const relayStatusLabel = computed(() => {
  if (relayReconnecting.value) {
    return '重连中...'
  }
  if (relaySaving.value || relayToggleSaving.value) {
    return '保存中...'
  }
  if (relayLoading.value) {
    return '读取中...'
  }
  if (relayStatus.value?.reconnectPaused) {
    return '已暂停重连'
  }
  if (relayStatus.value?.connected) {
    return '已连接'
  }
  if ((relayStatus.value?.enabled ?? relayForm.enabled) && Number(relayStatus.value?.nextReconnectDelayMs || 0) > 0) {
    return '等待重连'
  }
  if (relayForm.enabled) {
    return '未连接'
  }
  return '未启用'
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
    return '-'
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    return normalized
  }

  return parsed.toLocaleString('zh-CN')
}

const runnerStopReasonRows = computed(() => ([
  {
    key: 'queued_cancelled',
    label: '排队前取消',
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.queued_cancelled) || 0),
  },
  {
    key: 'user_requested',
    label: '用户主动停止',
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.user_requested) || 0),
  },
  {
    key: 'user_requested_after_error',
    label: '停止后报错',
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.user_requested_after_error) || 0),
  },
  {
    key: 'stop_timeout',
    label: '停止超时',
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.stop_timeout) || 0),
  },
]))

const runnerStopTimeoutPhaseRows = computed(() => ([
  {
    key: 'runner_timeout_without_stop_request',
    label: '未记录 stop 请求',
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_timeout_without_stop_request) || 0),
  },
  {
    key: 'runner_timeout_before_cancel',
    label: 'cancel 前超时',
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_timeout_before_cancel) || 0),
  },
  {
    key: 'cli_not_exiting',
    label: 'CLI 不退出',
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.cli_not_exiting) || 0),
  },
  {
    key: 'os_kill_slow',
    label: 'OS kill 慢',
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.os_kill_slow) || 0),
  },
  {
    key: 'runner_finalize_after_exit',
    label: '退出后收尾慢',
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_finalize_after_exit) || 0),
  },
]))

async function loadMeta() {
  versionLoading.value = true
  versionError.value = ''

  try {
    const payload = await getMeta()
    const nextVersion = String(payload?.version || '').trim()
    version.value = nextVersion
    if (!nextVersion) {
      versionError.value = '当前服务暂未返回版本号，请确认已重启到最新版本。'
    }
  } catch (error) {
    version.value = ''
    versionError.value = error?.message || '版本信息读取失败。'
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
    relayError.value = error?.message || '远程访问配置读取失败。'
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
    systemError.value = error?.message || '系统配置读取失败。'
  } finally {
    systemLoading.value = false
  }
}

async function loadRuntimeDiagnostics() {
  systemDiagnosticsLoading.value = true
  systemDiagnosticsError.value = ''

  try {
    systemDiagnostics.value = await getRuntimeDiagnostics()
  } catch (error) {
    systemDiagnosticsError.value = error?.message || '系统诊断信息读取失败。'
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
      ? '远程访问配置已保存，PromptX 正在尝试连接 Relay。'
      : '远程访问已关闭。'
  } catch (error) {
    relayError.value = error?.message || '远程访问配置保存失败。'
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
    relaySuccess.value = '已触发重连，PromptX 正在重新建立 Relay 连接。'
    setTimeout(() => {
      loadRelayConfig()
    }, 1200)
  } catch (error) {
    relayError.value = error?.message || '触发 Relay 重连失败。'
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
    })
    syncSystemForm(payload?.config || {})
    systemManagedByEnv.runnerMaxConcurrentRuns = Boolean(payload?.managedByEnv?.runner?.maxConcurrentRuns)
    systemSuccess.value = '系统配置已保存，runner 并发上限已更新。'
    loadRuntimeDiagnostics()
  } catch (error) {
    systemError.value = error?.message || '系统配置保存失败。'
  } finally {
    systemSaving.value = false
  }
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
    relayError.value = '请先填写完整的 Relay 地址、设备 ID 和设备 Token，再启用远程访问。'
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
      ? '远程访问已启用，PromptX 正在尝试连接 Relay。'
      : '远程访问已关闭。'
  } catch (error) {
    relayForm.enabled = Boolean(relayStatus.value?.enabled)
    relayError.value = error?.message || '远程访问开关保存失败。'
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
    relayError.value = error?.message || 'Relay 诊断信息复制失败。'
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
    systemDiagnosticsError.value = error?.message || '系统诊断信息复制失败。'
  }
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

function handleKeydown(event) {
  if (!props.open) {
    return
  }

  if (event.key === 'Escape') {
    emit('close')
  }
}

watch(
  () => props.open,
  (open) => {
    document.body.classList.toggle('overflow-hidden', open)
    if (open) {
      window.addEventListener('keydown', handleKeydown)
      activeSection.value = 'theme'
      loadMeta()
      loadRelayConfig()
      loadSystemConfig()
      return
    }

    window.removeEventListener('keydown', handleKeydown)
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
  document.body.classList.remove('overflow-hidden')
  window.removeEventListener('keydown', handleKeydown)
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
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="theme-modal-backdrop fixed inset-0 z-[70] flex items-center justify-center px-4 py-6"
      @click.self="emit('close')"
    >
      <section class="panel settings-dialog-panel flex h-full w-full max-w-5xl flex-col overflow-hidden sm:h-[42rem] sm:max-h-[88vh]">
        <div class="theme-divider settings-dialog-header flex items-start justify-between gap-4 border-b px-5 py-4">
          <div>
            <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
              <Settings2 class="h-4 w-4" />
              <span>设置</span>
            </div>
          </div>

          <button
            type="button"
            class="theme-icon-button h-8 w-8 shrink-0"
            @click="emit('close')"
          >
            <X class="h-4 w-4" />
          </button>
        </div>

        <div class="settings-dialog-body min-h-0 flex flex-1 flex-col sm:flex-row">
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
                <div class="theme-heading text-base font-medium">主题</div>
                <p class="theme-muted-text mt-1 text-xs leading-5">这里先放界面主题，后面如果有排版、字号等偏好，也继续归到这一类。</p>
              </div>

              <section class="settings-section-card px-4 py-4">
                <ThemeToggle />
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
                    <span>远程访问 Relay</span>
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
                    <div class="text-sm font-medium text-[var(--theme-textPrimary)]">启用远程访问</div>
                    <p class="theme-muted-text mt-1 text-xs">关闭后，本机会主动断开当前 Relay 连接。</p>
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
                    <span class="theme-muted-text text-xs">Relay 地址</span>
                    <input
                      v-model="relayForm.relayUrl"
                      type="text"
                      placeholder="https://user1.promptx.example.com"
                      class="tool-input"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">设备 ID</span>
                    <input
                      v-model="relayForm.deviceId"
                      type="text"
                      placeholder="my-macbook"
                      class="tool-input"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">设备 Token</span>
                    <div class="relative">
                      <input
                        v-model="relayForm.deviceToken"
                        :type="relayTokenVisible ? 'text' : 'password'"
                        placeholder="请输入云端 Relay 的设备 token"
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
                      当前已暂停自动重连：{{ relayStatus.reconnectPausedReason }}
                    </p>
                    <p
                      v-if="relayManagedByEnv"
                      class="theme-status-warning theme-note-text"
                    >
                      当前 Relay 配置由环境变量接管，设置页仅展示实际值，修改环境变量后需重启服务。
                    </p>
                    <p v-if="relayError" class="theme-danger-text theme-note-text">{{ relayError }}</p>
                    <p v-else-if="relaySuccess" class="theme-status-success theme-note-text">{{ relaySuccess }}</p>
                    <p
                      v-else-if="relayStatus?.lastError"
                      class="theme-danger-text theme-note-text"
                    >
                      最近错误：{{ relayStatus.lastError }}
                    </p>
                    <p
                      v-else-if="relayStatus?.lastCloseReason"
                      class="theme-muted-text theme-note-text"
                    >
                      最近断开：{{ relayStatus.lastCloseReason }}<span v-if="relayStatus.lastCloseCode">（code {{ relayStatus.lastCloseCode }}）</span>
                    </p>
                    <p
                      v-else-if="relayStatus?.lastConnectedAt"
                      class="theme-muted-text theme-note-text"
                    >
                      最近连接：{{ new Date(relayStatus.lastConnectedAt).toLocaleString('zh-CN') }}
                    </p>
                    <p
                      v-if="relayStatus?.recentEvents?.length"
                      class="theme-muted-text theme-note-text"
                    >
                      最近事件：{{ relayStatus.recentEvents[0]?.type || 'unknown' }}
                    </p>
                    <p
                      v-if="relayCopied"
                      class="theme-status-success theme-note-text"
                    >
                      Relay 诊断信息已复制，可直接发给我排查。
                    </p>
                    <p v-if="showRelayDefaultHint" class="theme-muted-text theme-note-text">
                      建议公网 Relay 使用 HTTPS，并确保云端与本机使用同一个设备 Token；多租户时每个人填写自己的子域名地址。
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
                      <span>{{ relayReconnecting ? '重连中...' : '立即重连' }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relayReconnecting"
                      @click="handleCopyRelayDiagnostics"
                    >
                      <span>{{ relayCopied ? '已复制诊断信息' : '复制 Relay 诊断信息' }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relaySaving || relayToggleSaving || relayReconnecting || relayManagedByEnv"
                      @click="handleSaveRelay"
                    >
                      <LoaderCircle v-if="relaySaving" class="h-4 w-4 animate-spin" />
                      <span>{{ relaySaving ? '保存中...' : '保存远程访问配置' }}</span>
                    </button>
                  </div>
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
                  <span>系统配置</span>
                </div>
                <p class="theme-muted-text mt-1 text-xs leading-5">
                  这里同时放 runner 并发上限和运行诊断。后续排查卡顿、排队、stop 回收问题时，优先看下面这组实时统计。
                </p>
              </div>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">真实 agent 最大并发数</span>
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
                    超过这个数量的新 run 会进入 queued，等待 runner 空闲后再启动。
                  </p>
                </label>

                <div class="settings-form-footer flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0 space-y-1">
                    <p
                      v-if="systemManagedByEnv.runnerMaxConcurrentRuns"
                      class="theme-status-warning theme-note-text"
                    >
                      当前并发上限由环境变量 `PROMPTX_RUNNER_MAX_CONCURRENT_RUNS` 接管，设置页只展示实际值。
                    </p>
                    <p v-else-if="systemError" class="theme-danger-text theme-note-text">{{ systemError }}</p>
                    <p v-else-if="systemSuccess" class="theme-status-success theme-note-text">{{ systemSuccess }}</p>
                    <p v-else class="theme-muted-text theme-note-text">
                      `active` 代表真实占用并发槽位的 run，`queued` 代表排队中，`tracked` 代表 runner 内存里尚未结束的全部上下文。
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
                      <span>{{ systemSaving ? '保存中...' : '保存系统配置' }}</span>
                    </button>
                  </div>
                </div>
              </section>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div class="theme-heading text-sm font-medium">运行诊断</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">
                      自动每 5 秒刷新一次，可直接观察 runner、恢复器和清理任务的运行情况。
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
                      <span>{{ systemDiagnosticsLoading ? '刷新中...' : '刷新诊断' }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      @click="handleCopySystemDiagnostics"
                    >
                      <span>{{ systemCopied ? '已复制诊断信息' : '复制诊断信息' }}</span>
                    </button>
                  </div>
                </div>

                <div class="min-w-0 space-y-1">
                  <p v-if="systemDiagnosticsError" class="theme-danger-text theme-note-text">{{ systemDiagnosticsError }}</p>
                  <p v-else-if="systemCopied" class="theme-status-success theme-note-text">
                    系统诊断信息已复制，可直接发给我排查。
                  </p>
                  <p v-else class="theme-muted-text theme-note-text">
                    诊断口径已经和真实并发控制对齐：`active` 不再把 queued 误算进去。
                  </p>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">active</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.activeRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">真实占用并发槽位</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">tracked</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.trackedRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">runner 内存中的全部上下文</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">queued</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.queuedRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">等待启动的 run</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">maxConcurrent</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.config?.maxConcurrentRuns || systemForm.runnerMaxConcurrentRuns }}</div>
                    <p class="theme-muted-text text-xs">当前生效并发上限</p>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">completed</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalCompleted || 0 }}</div>
                    <p class="theme-muted-text text-xs">已完成 run</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">stopped</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalStopped || 0 }}</div>
                    <p class="theme-muted-text text-xs">已停止 run</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">error</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalErrored || 0 }}</div>
                    <p class="theme-muted-text text-xs">异常结束 run</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">stop_timeout</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalStopTimeout || 0 }}</div>
                    <p class="theme-muted-text text-xs">停止超时 run</p>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">event flush failures</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.eventFlushFailureCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">事件批量回写失败次数</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">recovered runs</div>
                    <div class="theme-heading text-lg font-medium">{{ recoveryDiagnostics?.metrics?.totalRecovered || 0 }}</div>
                    <p class="theme-muted-text text-xs">服务端回收的失联 run</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">last cleanup</div>
                    <div class="theme-heading text-sm font-medium">{{ formatDateTime(maintenanceDiagnostics?.lastCleanup?.finishedAt) }}</div>
                    <p class="theme-muted-text text-xs">最近一次维护清理完成时间</p>
                  </div>
                </div>

                <div class="grid gap-4 lg:grid-cols-2">
                  <div class="settings-form-card space-y-3 px-3 py-3">
                    <div class="theme-heading text-sm font-medium">基础状态</div>
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
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ gitDiffWorkerDiagnostics ? '可用' : '未知' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">db vacuum</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ formatDateTime(maintenanceDiagnostics?.lastVacuumAt) }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="settings-form-card space-y-3 px-3 py-3">
                    <div class="theme-heading text-sm font-medium">Stop 原因分类</div>
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
                  <div class="theme-heading text-sm font-medium">Stop Timeout 阶段</div>
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
                  <div class="theme-heading text-sm font-medium">runner 暂不可用</div>
                  <p class="theme-muted-text text-xs leading-5">
                    {{ systemDiagnostics?.runner?.message || '当前还没有拿到 runner diagnostics。' }}
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
                <div class="theme-heading text-base font-medium">关于</div>
                <p class="theme-muted-text mt-1 text-xs leading-5">这里先放版本信息，后面像更新日志、环境说明也可以继续往这里放。</p>
              </div>

              <section class="settings-section-card px-4 py-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="theme-heading text-sm font-medium">版本信息</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">
                      {{ versionError || '当前已安装的 PromptX 版本。' }}
                    </p>
                  </div>
                  <span class="theme-badge-strong rounded-sm border border-dashed px-2.5 py-1 text-xs font-medium">
                    {{ versionLoading ? '读取中...' : version ? `v${version}` : '不可用' }}
                  </span>
                </div>
              </section>
            </section>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>
