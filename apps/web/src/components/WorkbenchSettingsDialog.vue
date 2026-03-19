<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Info, LoaderCircle, Palette, Settings2, Wifi, X } from 'lucide-vue-next'
import ThemeToggle from './ThemeToggle.vue'
import { getMeta, getRelayConfig, updateRelayConfig } from '../lib/api.js'

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
const relayError = ref('')
const relaySuccess = ref('')
const relayStatus = ref(null)
const relayManagedByEnv = ref(false)
const relayToggleSaving = ref(false)
const relayForm = reactive({
  enabled: false,
  relayUrl: '',
  deviceId: '',
  deviceToken: '',
})
const activeSection = ref('theme')

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
    id: 'about',
    label: '关于',
    description: '版本与说明',
    icon: Info,
  },
]

const relayStatusLabel = computed(() => {
  if (relaySaving.value || relayToggleSaving.value) {
    return '保存中...'
  }
  if (relayLoading.value) {
    return '读取中...'
  }
  if (relayStatus.value?.connected) {
    return '已连接'
  }
  if (relayForm.enabled) {
    return '未连接'
  }
  return '未启用'
})

const relayStatusClass = computed(() => {
  if (relayStatus.value?.connected) {
    return 'theme-status-success'
  }
  if (relayForm.enabled) {
    return 'theme-status-warning'
  }
  return 'theme-status-neutral'
})

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
      return
    }

    window.removeEventListener('keydown', handleKeydown)
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  document.body.classList.remove('overflow-hidden')
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 px-4 py-6 backdrop-blur-sm"
      @click.self="emit('close')"
    >
      <section class="panel flex h-full w-full max-w-5xl flex-col overflow-hidden sm:h-[42rem] sm:max-h-[88vh]">
        <div class="theme-divider flex items-start justify-between gap-4 border-b px-5 py-4">
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

        <div class="min-h-0 flex flex-1 flex-col sm:flex-row">
          <aside class="theme-divider border-b px-3 py-3 sm:w-60 sm:shrink-0 sm:border-b-0 sm:border-r sm:px-4 sm:py-4">
            <nav class="flex gap-2 overflow-x-auto sm:flex-col sm:overflow-visible">
              <button
                v-for="section in settingsSections"
                :key="section.id"
                type="button"
                class="flex min-w-0 items-start gap-3 rounded-sm border px-3 py-3 text-left transition sm:w-full"
                :class="activeSection === section.id
                  ? 'border-[var(--theme-accent)] bg-[var(--theme-accentSoft)] text-[var(--theme-textPrimary)]'
                  : 'border-dashed border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelMuted)] hover:border-[var(--theme-borderStrong)] hover:bg-[var(--theme-appPanelStrong)]'"
                @click="activeSection = section.id"
              >
                <component :is="section.icon" class="mt-0.5 h-4 w-4 shrink-0" />
                <div class="min-w-0">
                  <div class="text-sm font-medium">{{ section.label }}</div>
                  <p class="theme-muted-text mt-1 hidden text-xs leading-5 sm:block">{{ section.description }}</p>
                </div>
              </button>
            </nav>
          </aside>

          <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <section
              v-if="activeSection === 'theme'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading text-base font-medium">主题</div>
                <p class="theme-muted-text mt-1 text-xs leading-5">这里先放界面主题，后面如果有排版、字号等偏好，也继续归到这一类。</p>
              </div>

              <section class="rounded-sm border border-dashed border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelMuted)] px-4 py-4">
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
                  <p class="theme-muted-text mt-1 text-xs leading-5">
                    配好后，本机 PromptX 会主动连接你的公网 Relay，手机可通过该地址访问。
                  </p>
                </div>
                <span
                  class="rounded-sm border border-dashed px-2.5 py-1 text-xs font-medium"
                  :class="relayStatusClass"
                >
                  {{ relayStatusLabel }}
                </span>
              </div>

              <section class="space-y-4 rounded-sm border border-dashed border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelMuted)] px-4 py-4">
                <label class="flex items-center justify-between gap-3 rounded-sm border border-dashed border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelStrong)] px-3 py-2">
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
                      placeholder="https://relay.example.com"
                      class="w-full rounded-sm border border-[var(--theme-inputBorder)] bg-[var(--theme-inputBg)] px-3 py-2 text-sm text-[var(--theme-textPrimary)] outline-none transition focus:border-[var(--theme-borderStrong)]"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">设备 ID</span>
                    <input
                      v-model="relayForm.deviceId"
                      type="text"
                      placeholder="my-macbook"
                      class="w-full rounded-sm border border-[var(--theme-inputBorder)] bg-[var(--theme-inputBg)] px-3 py-2 text-sm text-[var(--theme-textPrimary)] outline-none transition focus:border-[var(--theme-borderStrong)]"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">设备 Token</span>
                    <input
                      v-model="relayForm.deviceToken"
                      type="password"
                      placeholder="请输入云端 Relay 的设备 token"
                      class="w-full rounded-sm border border-[var(--theme-inputBorder)] bg-[var(--theme-inputBg)] px-3 py-2 text-sm text-[var(--theme-textPrimary)] outline-none transition focus:border-[var(--theme-borderStrong)]"
                      :disabled="relayManagedByEnv"
                    >
                  </label>
                </div>

                <div class="flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0 space-y-1">
                    <p
                      v-if="relayManagedByEnv"
                      class="theme-status-warning text-xs leading-5"
                    >
                      当前 Relay 配置由环境变量接管，设置页仅展示实际值，修改环境变量后需重启服务。
                    </p>
                    <p v-if="relayError" class="theme-danger-text text-xs leading-5">{{ relayError }}</p>
                    <p v-else-if="relaySuccess" class="theme-status-success text-xs leading-5">{{ relaySuccess }}</p>
                    <p
                      v-else-if="relayStatus?.lastError"
                      class="theme-danger-text text-xs leading-5"
                    >
                      最近错误：{{ relayStatus.lastError }}
                    </p>
                    <p
                      v-else-if="relayStatus?.lastConnectedAt"
                      class="theme-muted-text text-xs leading-5"
                    >
                      最近连接：{{ new Date(relayStatus.lastConnectedAt).toLocaleString('zh-CN') }}
                    </p>
                    <p v-else class="theme-muted-text text-xs leading-5">
                      建议公网 Relay 使用 HTTPS，并确保云端与本机使用同一个设备 Token。
                    </p>
                  </div>

                  <button
                    type="button"
                    class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                    :disabled="relayLoading || relaySaving || relayToggleSaving || relayManagedByEnv"
                    @click="handleSaveRelay"
                  >
                    <LoaderCircle v-if="relaySaving" class="h-4 w-4 animate-spin" />
                    <span>{{ relaySaving ? '保存中...' : '保存远程访问配置' }}</span>
                  </button>
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

              <section class="rounded-sm border border-dashed border-[var(--theme-borderDefault)] bg-[var(--theme-appPanelMuted)] px-4 py-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="theme-heading text-sm font-medium">版本信息</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">
                      {{ versionError || '当前已安装的 PromptX 版本。' }}
                    </p>
                  </div>
                  <span class="rounded-sm border border-dashed border-[var(--theme-borderStrong)] bg-[var(--theme-appPanelStrong)] px-2.5 py-1 text-xs font-medium text-[var(--theme-textSecondary)]">
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
