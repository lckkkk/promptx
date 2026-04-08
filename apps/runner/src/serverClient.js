import { buildInternalAuthHeaders } from './internalAuth.js'

const DEFAULT_SERVER_BASE_URL = `http://${process.env.PROMPTX_SERVER_HOST || '127.0.0.1'}:${Math.max(
  1,
  Number(process.env.PROMPTX_SERVER_PORT || process.env.PORT || 9301)
)}`
const DEFAULT_SERVER_HTTP_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.PROMPTX_SERVER_HTTP_TIMEOUT_MS) || 5000
)

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '')
}

function createHttpError(status, payload, fallbackMessage) {
  const error = new Error(String(payload?.message || fallbackMessage || `HTTP ${status}`))
  error.statusCode = status
  error.payload = payload
  return error
}

function createRequestAbortController(timeoutMs, upstreamSignal) {
  const controller = new AbortController()
  let timeoutTriggered = false

  const timer = setTimeout(() => {
    timeoutTriggered = true
    controller.abort(new Error(`server request timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref?.()

  if (upstreamSignal) {
    if (upstreamSignal.aborted) {
      controller.abort(upstreamSignal.reason)
    } else {
      upstreamSignal.addEventListener('abort', () => {
        controller.abort(upstreamSignal.reason)
      }, { once: true })
    }
  }

  return {
    signal: controller.signal,
    wasTimeout() {
      return timeoutTriggered
    },
    cleanup() {
      clearTimeout(timer)
    },
  }
}

export function createServerClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.PROMPTX_SERVER_BASE_URL || DEFAULT_SERVER_BASE_URL)
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_SERVER_HTTP_TIMEOUT_MS)

  async function requestJson(pathname, init = {}) {
    const abortController = createRequestAbortController(timeoutMs, init.signal)
    let response
    try {
      response = await fetch(`${baseUrl}${pathname}`, {
        ...init,
        signal: abortController.signal,
        headers: buildInternalAuthHeaders({
          Accept: 'application/json',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...(init.headers || {}),
        }),
      })
    } catch (error) {
      abortController.cleanup()
      if (abortController.wasTimeout()) {
        throw createHttpError(504, { message: `server 请求超时（>${timeoutMs}ms）。` }, 'server 请求超时。')
      }
      throw createHttpError(503, { message: error.message || '无法连接 server 服务。' }, '无法连接 server 服务。')
    }

    const text = await response.text()
    abortController.cleanup()
    const payload = text ? (() => {
      try {
        return JSON.parse(text)
      } catch {
        return { message: text }
      }
    })() : {}

    if (!response.ok) {
      throw createHttpError(response.status, payload, `${pathname} 请求失败`)
    }

    return payload
  }

  return {
    baseUrl,
    timeoutMs,
    postEvents(items = [], metadata = {}) {
      return requestJson('/internal/runner-events', {
        method: 'POST',
        body: JSON.stringify({
          ...metadata,
          items,
        }),
      })
    },
    postStatus(payload = {}) {
      return requestJson('/internal/runner-status', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    getSystemConfig() {
      return requestJson('/internal/system-config')
    },
  }
}
