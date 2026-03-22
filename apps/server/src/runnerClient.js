import { buildInternalAuthHeaders } from './internalAuth.js'

const DEFAULT_RUNNER_HTTP_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.PROMPTX_RUNNER_HTTP_TIMEOUT_MS) || 5000
)

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '')
}

function getDefaultRunnerBaseUrl() {
  const host = String(process.env.PROMPTX_RUNNER_HOST || process.env.RUNNER_HOST || '127.0.0.1').trim() || '127.0.0.1'
  const port = Math.max(1, Number(process.env.PROMPTX_RUNNER_PORT || process.env.RUNNER_PORT || 3002))
  return `http://${host}:${port}`
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
    controller.abort(new Error(`runner request timed out after ${timeoutMs}ms`))
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

export function createRunnerClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.PROMPTX_RUNNER_BASE_URL || getDefaultRunnerBaseUrl())
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || DEFAULT_RUNNER_HTTP_TIMEOUT_MS)

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
        throw createHttpError(504, { message: `runner 请求超时（>${timeoutMs}ms）。` }, 'runner 请求超时。')
      }
      throw createHttpError(503, { message: error.message || '无法连接 runner 服务。' }, '无法连接 runner 服务。')
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
    startRun(payload = {}) {
      return requestJson('/internal/runs/start', {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    stopRun(runId, payload = {}) {
      return requestJson(`/internal/runs/${encodeURIComponent(String(runId || '').trim())}/stop`, {
        method: 'POST',
        body: JSON.stringify(payload),
      })
    },
    getRun(runId) {
      return requestJson(`/internal/runs/${encodeURIComponent(String(runId || '').trim())}`)
    },
    getDiagnostics() {
      return requestJson('/internal/diagnostics')
    },
  }
}
