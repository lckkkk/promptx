import process from 'node:process'
import WebSocket from 'ws'

import {
  buildRelayWebSocketUrl,
  createRelayRequestId,
  decodeChunk,
  encodeChunk,
  sanitizeProxyHeaders,
} from './relayProtocol.js'

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 65_000
const DEFAULT_SLEEP_RESUME_THRESHOLD_MS = 45_000
const MAX_RECENT_EVENTS = 200
const REQUEST_CANCEL_REASON = 'relay_request_cancelled'
const NON_RETRYABLE_CLOSE_REASONS = new Set([
  'invalid_tenant',
  'invalid_token',
  'invalid_device',
])

function createDisabledStatus() {
  return {
    enabled: false,
    connected: false,
    relayUrl: '',
    websocketUrl: '',
    deviceId: '',
    lastConnectedAt: '',
    lastDisconnectedAt: '',
    lastHeartbeatAt: '',
    lastCloseCode: 0,
    lastCloseReason: '',
    lastCloseReasonCode: '',
    lastError: '',
    lastErrorKey: '',
    lastErrorParams: null,
    reconnectCount: 0,
    reconnectPaused: false,
    reconnectPausedReason: '',
    reconnectPausedReasonCode: '',
    nextReconnectDelayMs: 0,
    recentEvents: [],
  }
}

function normalizeCloseReason(reason = '') {
  const normalized = String(reason || '').trim()
  if (!normalized) {
    return ''
  }

  const reasonMap = {
    invalid_tenant: '当前 Relay 域名未匹配到租户',
    invalid_token: '设备令牌不匹配',
    invalid_device: '设备 ID 不匹配',
    missing_hello: '缺少设备认证报文',
    missing_auth: '设备认证超时',
    replaced_by_new_connection: '已被新的设备连接替换',
    config_updated: '配置已更新，正在重连',
    heartbeat_timeout: '心跳超时，连接已失效',
  }

  return reasonMap[normalized] || normalized
}

function parseCloseReason(reason = '') {
  const rawReason = Buffer.isBuffer(reason)
    ? reason.toString('utf8').trim()
    : String(reason || '').trim()

  return {
    rawReason,
    closeReason: normalizeCloseReason(rawReason),
  }
}

function getReconnectDelayMs(reconnectCount = 0) {
  const normalizedCount = Math.max(1, Number(reconnectCount) || 1)
  return DEFAULT_RECONNECT_DELAYS_MS[Math.min(normalizedCount - 1, DEFAULT_RECONNECT_DELAYS_MS.length - 1)]
}

function readRelayClientConfig({
  relayUrl = process.env.PROMPTX_RELAY_URL,
  deviceId = process.env.PROMPTX_RELAY_DEVICE_ID,
  deviceToken = process.env.PROMPTX_RELAY_DEVICE_TOKEN,
  enabled = process.env.PROMPTX_RELAY_ENABLED,
  localBaseUrl = process.env.PROMPTX_RELAY_LOCAL_BASE_URL,
} = {}) {
  const normalizedRelayUrl = String(relayUrl || '').trim()
  const normalizedDeviceId = String(deviceId || '').trim()
  const normalizedDeviceToken = String(deviceToken || '').trim()
  const hasExplicitEnabled = typeof enabled === 'boolean'
    || (typeof enabled !== 'undefined' && String(enabled || '').trim() !== '')
  const normalizedEnabled = hasExplicitEnabled ? String(enabled).trim().toLowerCase() : ''
  const shouldEnable = hasExplicitEnabled
    ? !['0', 'false', 'off', 'no'].includes(normalizedEnabled)
    : Boolean(normalizedRelayUrl && normalizedDeviceId && normalizedDeviceToken)

  return {
    enabled: shouldEnable && Boolean(normalizedRelayUrl && normalizedDeviceId && normalizedDeviceToken),
    relayUrl: normalizedRelayUrl,
    websocketUrl: buildRelayWebSocketUrl(normalizedRelayUrl),
    deviceId: normalizedDeviceId,
    deviceToken: normalizedDeviceToken,
    localBaseUrl: String(localBaseUrl || 'http://127.0.0.1:3000').trim() || 'http://127.0.0.1:3000',
  }
}

function createRelayClient({
  relayUrl,
  deviceId,
  deviceToken,
  localBaseUrl,
  logger = console,
  appVersion = '0.0.0',
  createWebSocket = (url) => new WebSocket(url),
  reconnectDelayStrategy = getReconnectDelayMs,
  healthCheckIntervalMs = DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  sleepResumeThresholdMs = DEFAULT_SLEEP_RESUME_THRESHOLD_MS,
  getNow = () => Date.now(),
} = {}) {
  let config = readRelayClientConfig({
    relayUrl,
    deviceId,
    deviceToken,
    localBaseUrl,
  })

  const status = {
    ...createDisabledStatus(),
    enabled: config.enabled,
    relayUrl: config.relayUrl,
    websocketUrl: config.websocketUrl,
    deviceId: config.deviceId,
  }

  let socket = null
  let stopped = false
  let reconnectTimer = null
  let healthCheckTimer = null
  let requestMap = new Map()
  let authenticated = false
  let pendingReconnectSource = ''
  let lastHealthCheckTickAt = 0
  let connectionSequence = 0

  function updateStatus(patch = {}) {
    Object.assign(status, patch)
  }

  function appendRecentEvent(type, extra = {}) {
    const nextEvent = {
      at: new Date(getNow()).toISOString(),
      type: String(type || '').trim() || 'unknown',
      ...extra,
    }
    status.recentEvents = [nextEvent, ...status.recentEvents].slice(0, MAX_RECENT_EVENTS)
    return nextEvent
  }

  function syncStatusFromConfig() {
    updateStatus({
      enabled: config.enabled,
      relayUrl: config.relayUrl,
      websocketUrl: config.websocketUrl,
      deviceId: config.deviceId,
    })
  }

  function getLogContext(extra = {}) {
    return {
      relayUrl: config.relayUrl,
      websocketUrl: config.websocketUrl,
      deviceId: config.deviceId,
      ...extra,
    }
  }

  function logInfo(message, extra) {
    if (extra) {
      logger.info?.(extra, message)
      return
    }
    logger.info?.(message)
  }

  function logWarn(message, extra) {
    if (extra) {
      logger.warn?.(extra, message)
      return
    }
    logger.warn?.(message)
  }

  function logError(message, extra) {
    if (extra) {
      logger.error?.(extra, message)
      return
    }
    logger.error?.(message)
  }

  function nowIso() {
    return new Date(getNow()).toISOString()
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function clearHealthCheckTimer() {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer)
      healthCheckTimer = null
    }
  }

  function resetReconnectState() {
    updateStatus({
      reconnectCount: 0,
      reconnectPaused: false,
      reconnectPausedReason: '',
      nextReconnectDelayMs: 0,
    })
  }

  function getHeartbeatAgeMs(now = getNow()) {
    const lastHeartbeatAt = Date.parse(status.lastHeartbeatAt || status.lastConnectedAt || '')
    if (!Number.isFinite(lastHeartbeatAt)) {
      return Number.POSITIVE_INFINITY
    }
    return Math.max(0, now - lastHeartbeatAt)
  }

  function shouldPauseReconnect(rawReason = '') {
    return NON_RETRYABLE_CLOSE_REASONS.has(String(rawReason || '').trim())
  }

  function pauseReconnect(rawReason = '') {
    const reason = normalizeCloseReason(rawReason)
    updateStatus({
      reconnectPaused: true,
      reconnectPausedReason: reason || String(rawReason || '').trim(),
      reconnectPausedReasonCode: String(rawReason || '').trim(),
      nextReconnectDelayMs: 0,
    })
    appendRecentEvent('reconnect_paused', {
      reason: reason || String(rawReason || '').trim() || 'unknown',
      reasonCode: String(rawReason || '').trim() || 'unknown',
    })
    logWarn('[relay] 检测到不可重试错误，已暂停自动重连', getLogContext({
      reason: reason || String(rawReason || '').trim() || 'unknown',
    }))
  }

  syncStatusFromConfig()

  function sendFrame(payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return false
    }

    socket.send(JSON.stringify(payload))
    return true
  }

  async function forwardLocalResponse(requestId, response) {
    sendFrame({
      type: 'response.start',
      requestId,
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeProxyHeaders(response.headers, ['content-encoding']),
    })

    if (response.body) {
      for await (const chunk of response.body) {
        sendFrame({
          type: 'response.body',
          requestId,
          chunk: encodeChunk(chunk),
        })
      }
    } else {
      const bodyBuffer = Buffer.from(await response.arrayBuffer())
      if (bodyBuffer.length) {
        sendFrame({
          type: 'response.body',
          requestId,
          chunk: encodeChunk(bodyBuffer),
        })
      }
    }

    sendFrame({
      type: 'response.end',
      requestId,
    })
  }

  async function dispatchLocalRequest(record) {
    const bodyBuffer = Buffer.concat(record.bodyChunks)
    const controller = new AbortController()
    record.controller = controller
    requestMap.set(record.requestId, record)

    try {
      const targetUrl = new URL(record.path, config.localBaseUrl)
      const response = await fetch(targetUrl, {
        method: record.method,
        headers: sanitizeProxyHeaders(record.headers, ['cookie']),
        body: ['GET', 'HEAD'].includes(record.method) || !bodyBuffer.length ? undefined : bodyBuffer,
        signal: controller.signal,
      })

      await forwardLocalResponse(record.requestId, response)
    } catch (error) {
      const errorCode = error?.name === 'AbortError' ? REQUEST_CANCEL_REASON : 'relay_local_request_failed'
      sendFrame({
        type: 'response.error',
        requestId: record.requestId,
        code: errorCode,
        message: error?.message || '本地 PromptX 请求失败。',
      })
      appendRecentEvent('local_request_failed', {
        requestId: record.requestId,
        path: record.path,
        method: record.method,
        error: error?.message || String(error || ''),
      })
      logWarn('[relay] 本地请求转发失败', getLogContext({
        requestId: record.requestId,
        path: record.path,
        method: record.method,
        error: error?.message || String(error || ''),
      }))
    } finally {
      requestMap.delete(record.requestId)
    }
  }

  function handleIncomingFrame(rawPayload = '') {
    let payload
    try {
      payload = JSON.parse(String(rawPayload || ''))
    } catch {
      return
    }

    if (payload.type === 'request.start') {
      requestMap.set(payload.requestId, {
        requestId: String(payload.requestId || createRelayRequestId()),
        method: String(payload.method || 'GET').toUpperCase(),
        path: String(payload.path || '/'),
        headers: payload.headers || {},
        bodyChunks: [],
        controller: null,
      })
      return
    }

    if (payload.type === 'request.body') {
      const record = requestMap.get(payload.requestId)
      if (!record) {
        return
      }
      record.bodyChunks.push(decodeChunk(payload.chunk))
      return
    }

    if (payload.type === 'request.end') {
      const record = requestMap.get(payload.requestId)
      if (!record) {
        return
      }
      dispatchLocalRequest(record).catch((error) => {
        sendFrame({
          type: 'response.error',
          requestId: record.requestId,
          code: 'relay_dispatch_failed',
          message: error?.message || 'Relay 转发失败。',
        })
        appendRecentEvent('dispatch_failed', {
          requestId: record.requestId,
          path: record.path,
          method: record.method,
          error: error?.message || String(error || ''),
        })
        logError('[relay] 请求派发失败', getLogContext({
          requestId: record.requestId,
          path: record.path,
          method: record.method,
          error: error?.message || String(error || ''),
        }))
        requestMap.delete(record.requestId)
      })
      return
    }

    if (payload.type === 'request.cancel') {
      const record = requestMap.get(payload.requestId)
      record?.controller?.abort()
    }
  }

  function connectWithRetry(source = 'start') {
    return connect().catch((error) => {
      updateStatus({
        lastError: error?.message || 'Relay 连接失败。',
        lastErrorKey: 'connect_failed',
        lastErrorParams: null,
      })
      appendRecentEvent('connect_failed', {
        source,
        reconnectCount: Number(status.reconnectCount || 0),
        error: error?.message || String(error || ''),
      })
      logError('[relay] 连接失败', getLogContext({
        source,
        reconnectCount: Number(status.reconnectCount || 0),
        error: error?.message || String(error || ''),
      }))
      scheduleReconnect({ source })
    })
  }

  function scheduleReconnect({ source = 'close' } = {}) {
    if (stopped || reconnectTimer || !config.enabled || status.reconnectPaused) {
      return
    }

    const nextReconnectCount = Number(status.reconnectCount || 0) + 1
    const reconnectInMs = Math.max(100, Number(reconnectDelayStrategy(nextReconnectCount)) || getReconnectDelayMs(nextReconnectCount))
    updateStatus({
      reconnectCount: nextReconnectCount,
      nextReconnectDelayMs: reconnectInMs,
    })
    appendRecentEvent('reconnect_scheduled', {
      reconnectInMs,
      reconnectCount: nextReconnectCount,
      authenticated,
      source,
    })
    logWarn('[relay] 已计划重连', getLogContext({
      reconnectInMs,
      reconnectCount: nextReconnectCount,
      authenticated,
      source,
    }))

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connectWithRetry(`reconnect:${source}`)
    }, reconnectInMs)
    reconnectTimer.unref?.()
  }

  function triggerReconnect(source = 'manual') {
    if (stopped || !config.enabled) {
      return false
    }

    clearReconnectTimer()
    updateStatus({
      reconnectPaused: false,
      reconnectPausedReason: '',
      reconnectPausedReasonCode: '',
      nextReconnectDelayMs: 0,
      lastError: '',
      lastErrorKey: '',
      lastErrorParams: null,
    })
    pendingReconnectSource = source
    appendRecentEvent('reconnect_requested', {
      source,
      socketReadyState: socket?.readyState ?? 3,
    })
    logInfo('[relay] 收到重连请求', getLogContext({
      source,
      socketReadyState: socket?.readyState ?? 3,
    }))

    if (!socket || socket.readyState === WebSocket.CLOSED) {
      pendingReconnectSource = ''
      connectWithRetry(source)
      return true
    }

    try {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.terminate()
      } else {
        socket.close(1012, `${source}_reconnect`)
      }
    } catch {
      socket = null
      authenticated = false
      pendingReconnectSource = ''
      connectWithRetry(source)
    }

    return true
  }

  function runHealthCheck() {
    if (stopped || !config.enabled) {
      return
    }

    const now = getNow()
    const previousTickAt = lastHealthCheckTickAt
    lastHealthCheckTickAt = now

    if (previousTickAt > 0) {
      const elapsedSinceLastTick = now - previousTickAt
      if (elapsedSinceLastTick > sleepResumeThresholdMs) {
        appendRecentEvent('system_resume_detected', {
          elapsedMs: elapsedSinceLastTick,
        })
        logInfo('[relay] 检测到系统挂起/恢复，开始检查连接健康状态', getLogContext({
          elapsedMs: elapsedSinceLastTick,
          socketReadyState: socket?.readyState ?? 3,
          connected: status.connected,
        }))
      }
    }

    if (socket?.readyState === WebSocket.OPEN && authenticated) {
      const heartbeatAgeMs = getHeartbeatAgeMs(now)
      if (heartbeatAgeMs > heartbeatTimeoutMs) {
        appendRecentEvent('heartbeat_stale', {
          heartbeatAgeMs,
          heartbeatTimeoutMs,
        })
        logWarn('[relay] 心跳已过期，准备主动重连', getLogContext({
          heartbeatAgeMs,
          heartbeatTimeoutMs,
        }))
        triggerReconnect('heartbeat_timeout')
        return
      }
    }

    if (!socket && !reconnectTimer && !status.connected && !status.reconnectPaused) {
      scheduleReconnect({ source: 'health_check_idle' })
    }
  }

  async function connect() {
    if (!config.enabled) {
      return
    }
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return
    }

    appendRecentEvent('connect_start')
    logInfo('[relay] 开始连接', getLogContext())
    const currentSocket = createWebSocket(config.websocketUrl)
    const connectionId = ++connectionSequence
    socket = currentSocket
    authenticated = false

    currentSocket.on('open', () => {
      if (socket !== currentSocket) {
        return
      }
      appendRecentEvent('ws_open')
      sendFrame({
        type: 'hello',
        deviceId: config.deviceId,
        deviceToken: config.deviceToken,
        version: appVersion,
      })
      logInfo('[relay] WebSocket 已建立，等待设备认证', getLogContext({
        connectionId,
      }))
    })

    currentSocket.on('message', (payload, isBinary) => {
      if (socket !== currentSocket) {
        return
      }
      if (isBinary) {
        return
      }

      let message = null
      try {
        message = JSON.parse(payload.toString('utf8'))
      } catch {
        return
      }

      if (message?.type === 'hello.ack') {
        authenticated = true
        resetReconnectState()
        updateStatus({
          connected: true,
          lastConnectedAt: nowIso(),
          lastHeartbeatAt: nowIso(),
          lastCloseCode: 0,
          lastCloseReason: '',
          lastError: '',
          lastCloseReasonCode: '',
          lastErrorKey: '',
          lastErrorParams: null,
        })
        appendRecentEvent('auth_ok', {
          tenantKey: String(message?.tenantKey || '').trim(),
          reconnectCount: Number(status.reconnectCount || 0),
          connectionId,
        })
        logInfo('[relay] 设备认证成功，连接已就绪', getLogContext({
          tenantKey: String(message?.tenantKey || '').trim(),
          reconnectCount: Number(status.reconnectCount || 0),
          connectionId,
        }))
        return
      }

      handleIncomingFrame(JSON.stringify(message))
    })

    currentSocket.on('ping', () => {
      if (socket !== currentSocket) {
        return
      }
      updateStatus({
        lastHeartbeatAt: nowIso(),
      })
    })

    currentSocket.on('pong', () => {
      if (socket !== currentSocket) {
        return
      }
      updateStatus({
        lastHeartbeatAt: nowIso(),
      })
    })

    currentSocket.on('close', (code, reason) => {
      if (socket !== currentSocket) {
        appendRecentEvent('stale_close_ignored', {
          code: Number(code || 0),
          reason: parseCloseReason(reason).closeReason || '',
          connectionId,
        })
        logInfo('[relay] 已忽略旧连接的 close 事件', getLogContext({
          code: Number(code || 0),
          connectionId,
        }))
        return
      }

      const wasAuthenticated = authenticated
      const reconnectSource = pendingReconnectSource
      pendingReconnectSource = ''
      const { rawReason, closeReason } = parseCloseReason(reason)
      const rawReasonCode = String(rawReason || '').trim()
      const nextError = closeReason && closeReason !== '配置已更新，正在重连'
        ? `${wasAuthenticated ? 'Relay 已断开' : 'Relay 连接被拒绝'}：${closeReason}`
        : (!wasAuthenticated && code && code !== 1000 ? `Relay 连接已关闭（code=${code}）` : '')
      const nextErrorKey = closeReason && closeReason !== '配置已更新，正在重连'
        ? (wasAuthenticated ? 'disconnected' : 'rejected')
        : (!wasAuthenticated && code && code !== 1000 ? 'closed_with_code' : '')
      const nextErrorParams = nextErrorKey === 'closed_with_code'
        ? { code: Number(code || 0) }
        : (nextErrorKey ? { reasonCode: rawReasonCode || closeReason || '', code: Number(code || 0) } : null)

      updateStatus({
        connected: false,
        lastDisconnectedAt: nowIso(),
        lastCloseCode: Number(code || 0),
        lastCloseReason: closeReason,
        lastCloseReasonCode: rawReasonCode,
        ...(nextError
          ? { lastError: nextError, lastErrorKey: nextErrorKey, lastErrorParams: nextErrorParams }
          : { lastErrorKey: '', lastErrorParams: null }),
      })
      appendRecentEvent('close', {
        code: Number(code || 0),
        reason: closeReason || '',
        rawReason: rawReason || '',
        authenticated: wasAuthenticated,
        reconnectSource: reconnectSource || '',
        connectionId,
      })
      socket = null
      authenticated = false
      logWarn('[relay] 连接已关闭', getLogContext({
        code: Number(code || 0),
        reason: closeReason || 'none',
        authenticated: wasAuthenticated,
        reconnectSource: reconnectSource || '',
        connectionId,
      }))

      if (reconnectSource) {
        connectWithRetry(reconnectSource)
        return
      }

      if (shouldPauseReconnect(rawReason)) {
        pauseReconnect(rawReason)
        return
      }

      scheduleReconnect({ source: rawReason || 'close' })
    })

    currentSocket.on('error', (error) => {
      if (socket !== currentSocket) {
        return
      }
      updateStatus({
        lastError: error?.message || 'Relay 连接失败。',
        lastErrorKey: 'connect_failed',
        lastErrorParams: null,
      })
      appendRecentEvent('error', {
        error: error?.message || String(error || ''),
        connectionId,
      })
      logWarn('[relay] 连接异常', getLogContext({
        error: error?.message || String(error || ''),
        connectionId,
      }))
    })
  }

  return {
    start() {
      stopped = false
      clearReconnectTimer()
      clearHealthCheckTimer()
      if (!config.enabled) {
        syncStatusFromConfig()
        appendRecentEvent('disabled')
        logInfo('[relay] 当前未启用，跳过连接', getLogContext())
        return
      }

      lastHealthCheckTickAt = getNow()
      healthCheckTimer = setInterval(() => {
        runHealthCheck()
      }, Math.max(20, Number(healthCheckIntervalMs) || DEFAULT_HEALTH_CHECK_INTERVAL_MS))
      healthCheckTimer.unref?.()

      connectWithRetry('start')
    },
    stop() {
      stopped = true
      clearReconnectTimer()
      clearHealthCheckTimer()
      requestMap.forEach((record) => {
        record.controller?.abort()
      })
      requestMap = new Map()
      pendingReconnectSource = ''
      socket?.close()
      socket = null
      authenticated = false
      updateStatus({
        connected: false,
        nextReconnectDelayMs: 0,
        lastErrorKey: '',
        lastErrorParams: null,
      })
      appendRecentEvent('stopped')
      logInfo('[relay] 已停止', getLogContext())
    },
    updateConfig(nextConfig = {}) {
      const previousEnabled = config.enabled
      config = readRelayClientConfig({
        ...config,
        ...nextConfig,
      })
      syncStatusFromConfig()
      updateStatus({
        lastError: '',
        lastErrorKey: '',
        lastErrorParams: null,
        reconnectPaused: false,
        reconnectPausedReason: '',
        reconnectPausedReasonCode: '',
        nextReconnectDelayMs: 0,
      })
      appendRecentEvent('config_updated', {
        previousEnabled,
        nextEnabled: config.enabled,
      })
      logInfo('[relay] 配置已更新', getLogContext({
        previousEnabled,
        nextEnabled: config.enabled,
      }))

      if (!config.enabled) {
        this.stop()
        return
      }

      if (!previousEnabled) {
        this.start()
        return
      }

      if (socket) {
        socket.close(1012, 'config_updated')
      } else {
        this.start()
      }
    },
    reconnect() {
      return triggerReconnect('manual')
    },
    getStatus() {
      return {
        ...status,
        recentEvents: Array.isArray(status.recentEvents) ? [...status.recentEvents] : [],
        socketReadyState: socket?.readyState ?? 3,
        pendingRequestCount: requestMap.size,
      }
    },
  }
}

export {
  createDisabledStatus,
  createRelayClient,
  getReconnectDelayMs,
  readRelayClientConfig,
}
