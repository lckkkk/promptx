export function createApiError(messageKey, message, statusCode = 400, extras = {}) {
  const error = new Error(String(message || '请求失败。'))
  error.statusCode = Math.max(400, Number(statusCode) || 400)
  if (messageKey) {
    error.messageKey = String(messageKey)
  }
  Object.assign(error, extras)
  return error
}

export function getApiErrorPayload(error, fallback = {}) {
  const payload = error?.payload && typeof error.payload === 'object' ? error.payload : {}
  const messageKey = String(
    error?.messageKey
    || payload?.messageKey
    || fallback.messageKey
    || ''
  ).trim()
  const message = String(
    error?.message
    || payload?.message
    || fallback.message
    || '请求失败。'
  ).trim() || '请求失败。'

  return messageKey
    ? { ...payload, messageKey, message }
    : { ...payload, message }
}
