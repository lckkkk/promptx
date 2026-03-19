import process from 'node:process'
import WebSocket from 'ws'

import {
  buildRelayWebSocketUrl,
  createRelayRequestId,
  decodeChunk,
  encodeChunk,
  sanitizeProxyHeaders,
} from './relayProtocol.js'

const DEFAULT_RECONNECT_DELAY_MS = 3_000
const REQUEST_CANCEL_REASON = 'relay_request_cancelled'

function createDisabledStatus() {
  return {
    enabled: false,
    connected: false,
    relayUrl: '',
    websocketUrl: '',
    deviceId: '',
    lastConnectedAt: '',
    lastDisconnectedAt: '',
    lastError: '',
  }
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
  let requestMap = new Map()

  function updateStatus(patch = {}) {
    Object.assign(status, patch)
  }

  function syncStatusFromConfig() {
    updateStatus({
      enabled: config.enabled,
      relayUrl: config.relayUrl,
      websocketUrl: config.websocketUrl,
      deviceId: config.deviceId,
    })
  }

  syncStatusFromConfig()

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
        requestMap.delete(record.requestId)
      })
      return
    }

    if (payload.type === 'request.cancel') {
      const record = requestMap.get(payload.requestId)
      record?.controller?.abort()
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer || !config.enabled) {
      return
    }

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect().catch(() => {})
    }, DEFAULT_RECONNECT_DELAY_MS)
  }

  async function connect() {
    if (!config.enabled) {
      return
    }
    if (stopped || socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return
    }

    socket = new WebSocket(config.websocketUrl)

    socket.on('open', () => {
      updateStatus({
        connected: true,
        lastConnectedAt: new Date().toISOString(),
        lastError: '',
      })

      sendFrame({
        type: 'hello',
        deviceId: config.deviceId,
        deviceToken: config.deviceToken,
        version: appVersion,
      })
      logInfo(`[relay] 已连接 ${config.relayUrl}`)
    })

    socket.on('message', (payload, isBinary) => {
      if (isBinary) {
        return
      }
      handleIncomingFrame(payload.toString('utf8'))
    })

    socket.on('close', () => {
      updateStatus({
        connected: false,
        lastDisconnectedAt: new Date().toISOString(),
      })
      socket = null
      scheduleReconnect()
    })

    socket.on('error', (error) => {
      updateStatus({
        lastError: error?.message || 'Relay 连接失败。',
      })
      logWarn('[relay] 连接异常', {
        error: error?.message || String(error || ''),
      })
    })
  }

  return {
    start() {
      stopped = false
      if (!config.enabled) {
        syncStatusFromConfig()
        return
      }
      connect().catch((error) => {
        updateStatus({
          lastError: error?.message || 'Relay 连接失败。',
        })
        logError('[relay] 初次连接失败', {
          error: error?.message || String(error || ''),
        })
        scheduleReconnect()
      })
    },
    stop() {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      requestMap.forEach((record) => {
        record.controller?.abort()
      })
      requestMap = new Map()
      socket?.close()
      socket = null
      updateStatus({
        connected: false,
      })
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
      })

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
    getStatus() {
      return { ...status }
    },
  }
}

export {
  createDisabledStatus,
  createRelayClient,
  readRelayClientConfig,
}
