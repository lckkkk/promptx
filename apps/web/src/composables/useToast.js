import { onBeforeUnmount, ref } from 'vue'

const DEFAULT_TOAST_TYPE = 'success'

function normalizeToastPayload(payload, fallbackDuration) {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const message = String(payload.message || '').trim()
    return {
      message,
      type: String(payload.type || DEFAULT_TOAST_TYPE).trim() || DEFAULT_TOAST_TYPE,
      duration: Number(payload.duration) > 0 ? Number(payload.duration) : fallbackDuration,
    }
  }

  return {
    message: String(payload || '').trim(),
    type: DEFAULT_TOAST_TYPE,
    duration: fallbackDuration,
  }
}

export function useToast(duration = 2200) {
  const toastMessage = ref('')
  const toastType = ref(DEFAULT_TOAST_TYPE)
  let toastTimer = null

  function clearToast() {
    if (toastTimer) {
      window.clearTimeout(toastTimer)
      toastTimer = null
    }
    toastMessage.value = ''
    toastType.value = DEFAULT_TOAST_TYPE
  }

  function flashToast(payload, nextDuration = duration) {
    const normalized = normalizeToastPayload(payload, nextDuration)
    if (!normalized.message) {
      clearToast()
      return
    }

    toastMessage.value = normalized.message
    toastType.value = normalized.type
    if (toastTimer) {
      window.clearTimeout(toastTimer)
    }
    toastTimer = window.setTimeout(() => {
      toastMessage.value = ''
      toastType.value = DEFAULT_TOAST_TYPE
      toastTimer = null
    }, normalized.duration)
  }

  onBeforeUnmount(() => {
    if (toastTimer) {
      window.clearTimeout(toastTimer)
    }
  })

  return {
    toastMessage,
    toastType,
    flashToast,
    clearToast,
  }
}
