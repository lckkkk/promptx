import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { WebSocketServer } from 'ws'

import { serverRootDir } from './appPaths.js'
import {
  chunkBuffer,
  constantTimeEqual,
  createRelayRequestId,
  decodeChunk,
  encodeChunk,
  parseCookieHeader,
  sanitizeProxyHeaders,
} from './relayProtocol.js'

const DEFAULT_RELAY_PORT = 3030
const DEFAULT_RELAY_HOST = '0.0.0.0'
const DEFAULT_COOKIE_NAME = 'promptx_relay_access'
const DEVICE_AUTH_TIMEOUT_MS = 5_000

function normalizeRelayHost(value = '') {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  const firstValue = raw.split(',')[0]?.trim() || ''
  if (!firstValue) {
    return ''
  }

  try {
    const withProtocol = /^[a-z]+:\/\//i.test(firstValue) ? firstValue : `http://${firstValue}`
    return String(new URL(withProtocol).hostname || '').trim().toLowerCase().replace(/\.$/, '')
  } catch {
    return firstValue.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')
  }
}

function normalizeRelayTenantConfig(input = {}, index = 0) {
  const hosts = [
    ...(Array.isArray(input?.hosts) ? input.hosts : []),
    input?.host,
    input?.publicUrl,
  ]
    .map((item) => normalizeRelayHost(item))
    .filter(Boolean)
    .filter((item, itemIndex, items) => items.indexOf(item) === itemIndex)

  const key = String(
    input?.key
    || input?.slug
    || (hosts[0] ? hosts[0].split('.')[0] : '')
    || `tenant-${index + 1}`
  ).trim()

  return {
    key,
    hosts,
    expectedDeviceId: String(input?.deviceId || input?.expectedDeviceId || '').trim(),
    deviceToken: String(input?.deviceToken || '').trim(),
    accessToken: String(input?.accessToken || '').trim(),
  }
}

function readRelayTenantsFromFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || '').trim())
  const payload = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
  const tenantItems = Array.isArray(payload) ? payload : payload?.tenants
  if (!Array.isArray(tenantItems) || !tenantItems.length) {
    throw new Error('PROMPTX_RELAY_TENANTS_FILE 中未找到 tenants 配置。')
  }

  return {
    source: resolvedPath,
    tenants: tenantItems.map((item, index) => normalizeRelayTenantConfig(item, index)),
  }
}

function readRelayTenantsFromEnv() {
  const tenant = normalizeRelayTenantConfig({
    key: process.env.PROMPTX_RELAY_TENANT_KEY || 'default',
    host: process.env.PROMPTX_RELAY_PUBLIC_URL,
    expectedDeviceId: process.env.PROMPTX_RELAY_DEVICE_ID,
    deviceToken: process.env.PROMPTX_RELAY_DEVICE_TOKEN,
    accessToken: process.env.PROMPTX_RELAY_ACCESS_TOKEN,
  })

  return {
    source: 'env',
    tenants: [tenant],
  }
}

function readRelayServerConfig() {
  const tenantsFile = String(process.env.PROMPTX_RELAY_TENANTS_FILE || '').trim()
  const tenantConfig = tenantsFile ? readRelayTenantsFromFile(tenantsFile) : readRelayTenantsFromEnv()
  const keySet = new Set()
  const hostSet = new Set()

  tenantConfig.tenants.forEach((tenant) => {
    if (!tenant.key) {
      throw new Error('Relay tenant 缺少 key。')
    }
    if (!tenant.deviceToken) {
      throw new Error(`Relay tenant ${tenant.key} 缺少 deviceToken。`)
    }
    if (keySet.has(tenant.key)) {
      throw new Error(`Relay tenant key 重复：${tenant.key}`)
    }
    keySet.add(tenant.key)

    tenant.hosts.forEach((host) => {
      if (hostSet.has(host)) {
        throw new Error(`Relay tenant host 重复：${host}`)
      }
      hostSet.add(host)
    })
  })

  return {
    host: String(process.env.PROMPTX_RELAY_HOST || process.env.HOST || DEFAULT_RELAY_HOST).trim() || DEFAULT_RELAY_HOST,
    port: Math.max(1, Number(process.env.PROMPTX_RELAY_PORT || process.env.PORT) || DEFAULT_RELAY_PORT),
    accessCookieName: String(process.env.PROMPTX_RELAY_ACCESS_COOKIE || DEFAULT_COOKIE_NAME).trim() || DEFAULT_COOKIE_NAME,
    tenants: tenantConfig.tenants,
    tenantSource: tenantConfig.source,
  }
}

function resolveRelayTenantByHost(tenants = [], rawHost = '') {
  const normalizedHost = normalizeRelayHost(rawHost)
  if (!normalizedHost) {
    return tenants.length === 1 && tenants[0].hosts.length === 0 ? tenants[0] : null
  }

  const exactMatch = tenants.find((tenant) => tenant.hosts.includes(normalizedHost))
  if (exactMatch) {
    return exactMatch
  }

  return tenants.length === 1 && tenants[0].hosts.length === 0 ? tenants[0] : null
}

function getWebDistRoot() {
  return path.resolve(serverRootDir, '..', 'web', 'dist')
}

function buildLoginPage({
  errorMessage = '',
  redirectPath = '/',
  tenantLabel = '',
} = {}) {
  const escapedError = String(errorMessage || '').replace(/[<>&"]/g, '')
  const escapedRedirect = String(redirectPath || '/').replace(/"/g, '&quot;')
  const escapedTenantLabel = String(tenantLabel || '').replace(/[<>&"]/g, '')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PromptX Relay 登录</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f4; color: #1c1917; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .card { width: min(92vw, 420px); border: 1px solid #d6d3d1; background: #fffbeb; box-shadow: 8px 8px 0 rgba(28,25,23,.06); padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { margin: 0 0 16px; line-height: 1.6; color: #57534e; }
    label { display: block; margin-bottom: 8px; font-size: 13px; color: #44403c; }
    input { box-sizing: border-box; width: 100%; border: 1px solid #a8a29e; padding: 10px 12px; background: white; }
    button { margin-top: 14px; width: 100%; border: 1px solid #166534; background: #16a34a; color: white; padding: 10px 12px; cursor: pointer; }
    .error { margin-bottom: 12px; color: #b91c1c; font-size: 13px; }
    .tenant { display: inline-block; margin-bottom: 10px; padding: 2px 8px; border: 1px dashed #86efac; color: #166534; font-size: 12px; }
  </style>
</head>
<body>
  <form class="card" action="/relay/login" method="get">
    ${escapedTenantLabel ? `<div class="tenant">${escapedTenantLabel}</div>` : ''}
    <h1>PromptX Relay</h1>
    <p>请输入远程访问令牌，进入你自己的 PromptX 工作台。</p>
    ${escapedError ? `<div class="error">${escapedError}</div>` : ''}
    <input type="hidden" name="redirect" value="${escapedRedirect}" />
    <label for="token">访问令牌</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required />
    <button type="submit">进入 PromptX</button>
  </form>
</body>
</html>`
}

function buildUnknownTenantPage(host = '') {
  const escapedHost = String(host || '').replace(/[<>&"]/g, '')

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PromptX Relay</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f4; color: #1c1917; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .card { width: min(92vw, 480px); border: 1px solid #d6d3d1; background: white; box-shadow: 8px 8px 0 rgba(28,25,23,.06); padding: 24px; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { margin: 0; line-height: 1.7; color: #57534e; }
    code { padding: 2px 6px; background: #f5f5f4; }
  </style>
</head>
<body>
  <div class="card">
    <h1>PromptX Relay 未匹配到租户</h1>
    <p>当前访问域名 <code>${escapedHost || 'unknown-host'}</code> 没有配置到 Relay。请检查 DNS、Nginx 与租户配置文件。</p>
  </div>
</body>
</html>`
}

function getRequestPath(request) {
  return String(request.raw.url || '/').split('?')[0] || '/'
}

function isHtmlRequest(request) {
  const accept = String(request.headers.accept || '').toLowerCase()
  return accept.includes('text/html')
}

function normalizeRedirectPath(value = '/') {
  const raw = String(value || '/').trim()
  if (!raw.startsWith('/')) {
    return '/'
  }
  if (raw.startsWith('//') || raw.startsWith('/relay/login')) {
    return '/'
  }
  return raw
}

function createCookieValue(name, value, secure = false) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`
}

function normalizeRequestBodyToBuffer(body) {
  if (Buffer.isBuffer(body)) {
    return body
  }

  if (typeof body === 'string') {
    return Buffer.from(body)
  }

  if (body instanceof ArrayBuffer) {
    return Buffer.from(body)
  }

  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  }

  if (body === null || typeof body === 'undefined') {
    return Buffer.alloc(0)
  }

  if (typeof body === 'object') {
    return Buffer.from(JSON.stringify(body))
  }

  return Buffer.from(String(body))
}

function getRequestHost(request) {
  return normalizeRelayHost(request?.headers?.['x-forwarded-host'] || request?.headers?.host || '')
}

function isHttpsRequest(request) {
  const forwardedProto = String(request?.headers?.['x-forwarded-proto'] || '').split(',')[0]?.trim().toLowerCase()
  if (forwardedProto) {
    return forwardedProto === 'https'
  }

  return Boolean(request?.socket?.encrypted)
}

function createTenantState(tenant) {
  return {
    tenantKey: tenant.key,
    tenantHosts: tenant.hosts,
    socket: null,
    deviceId: '',
    connectedAt: '',
    version: '',
  }
}

async function startRelayServer(options = {}) {
  const config = options.config || readRelayServerConfig()
  const webDistDir = options.webDistDir || getWebDistRoot()
  const webIndexPath = path.join(webDistDir, 'index.html')
  if (!fs.existsSync(webIndexPath)) {
    throw new Error('没有找到前端构建产物，请先运行 `pnpm build`。')
  }

  const app = Fastify({
    logger: typeof options.logger === 'undefined' ? true : options.logger,
    bodyLimit: 35 * 1024 * 1024,
  })
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (request, body, done) => {
    done(null, body)
  })

  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: '/',
    wildcard: false,
    index: false,
  })

  const wsServer = new WebSocketServer({ noServer: true })
  const requestMap = new Map()
  const tenantStateMap = new Map(config.tenants.map((tenant) => [tenant.key, createTenantState(tenant)]))

  function getTenantState(tenantKey) {
    return tenantStateMap.get(String(tenantKey || '').trim()) || null
  }

  function getTenantForRequest(request) {
    return resolveRelayTenantByHost(config.tenants, getRequestHost(request))
  }

  function replyUnknownTenant(request, reply) {
    const host = getRequestHost(request)
    if (isHtmlRequest(request)) {
      return reply.code(404).type('text/html; charset=utf-8').send(buildUnknownTenantPage(host))
    }
    return reply.code(404).send({
      message: '当前域名未配置到 PromptX Relay。',
      host,
    })
  }

  function requireTenantRequest(request, reply) {
    const tenant = getTenantForRequest(request)
    if (tenant) {
      return tenant
    }
    replyUnknownTenant(request, reply)
    return null
  }

  function isAuthorizedRequest(request, tenant) {
    if (!tenant?.accessToken) {
      return true
    }

    const bearerToken = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
    if (bearerToken && constantTimeEqual(bearerToken, tenant.accessToken)) {
      return true
    }

    const cookies = parseCookieHeader(request.headers.cookie)
    return constantTimeEqual(cookies[config.accessCookieName] || '', tenant.accessToken)
  }

  function ensureAuthorized(request, reply, tenant) {
    if (isAuthorizedRequest(request, tenant)) {
      return true
    }

    if (isHtmlRequest(request)) {
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(buildLoginPage({
          redirectPath: getRequestPath(request),
          tenantLabel: tenant?.key || getRequestHost(request),
        }))
    }

    return reply.code(401).send({ message: '未通过 relay 访问验证。' })
  }

  function getActiveDeviceSocket(tenantKey) {
    const tenantState = getTenantState(tenantKey)
    if (!tenantState?.socket || tenantState.socket.readyState !== 1) {
      return null
    }
    return tenantState.socket
  }

  function clearPendingRequest(requestId, reason = 'request_closed') {
    const record = requestMap.get(requestId)
    if (!record) {
      return
    }
    requestMap.delete(requestId)
    try {
      getActiveDeviceSocket(record.tenantKey)?.send(JSON.stringify({
        type: 'request.cancel',
        requestId,
        reason,
      }))
    } catch {
      // Ignore send failures after disconnect.
    }
  }

  function writeRelayResponseStart(record, payload) {
    if (record.started) {
      return
    }
    record.started = true
    record.reply.raw.writeHead(payload.status || 200, sanitizeProxyHeaders(payload.headers, ['content-encoding']))
  }

  function writeRelayResponseBody(record, payload) {
    if (!record.started) {
      writeRelayResponseStart(record, { status: 200, headers: {} })
    }
    const chunk = decodeChunk(payload.chunk)
    if (chunk.length) {
      record.reply.raw.write(chunk)
    }
  }

  function finalizeRelayResponse(record) {
    if (!record.reply.raw.writableEnded) {
      record.reply.raw.end()
    }
  }

  function failRelayRequest(record, statusCode = 502, message = 'Relay 请求失败。') {
    if (!record.reply.raw.writableEnded) {
      if (!record.started) {
        record.reply.raw.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' })
      }
      record.reply.raw.end(JSON.stringify({ message }))
    }
  }

  function sendRequestToDevice(socket, requestId, request) {
    const requestPath = String(request.raw.url || '/')
    const bodyBuffer = normalizeRequestBodyToBuffer(request.body)

    socket.send(JSON.stringify({
      type: 'request.start',
      requestId,
      method: String(request.method || 'GET').toUpperCase(),
      path: requestPath,
      headers: sanitizeProxyHeaders(request.headers, ['cookie']),
    }))

    chunkBuffer(bodyBuffer).forEach((chunk) => {
      socket.send(JSON.stringify({
        type: 'request.body',
        requestId,
        chunk: encodeChunk(chunk),
      }))
    })

    socket.send(JSON.stringify({
      type: 'request.end',
      requestId,
    }))
  }

  function handleProxyRequest(request, reply) {
    const tenant = requireTenantRequest(request, reply)
    if (!tenant) {
      return
    }

    if (ensureAuthorized(request, reply, tenant) !== true) {
      return
    }

    const deviceSocket = getActiveDeviceSocket(tenant.key)
    if (!deviceSocket) {
      app.log.warn({ tenantKey: tenant.key, host: getRequestHost(request) }, '[relay] 当前租户没有在线设备')
      return reply.code(503).send({ message: 'PromptX 本地设备暂未连接到 relay。' })
    }

    const requestId = createRelayRequestId()
    reply.hijack()
    requestMap.set(requestId, {
      requestId,
      tenantKey: tenant.key,
      request,
      reply,
      started: false,
    })

    reply.raw.on('close', () => {
      clearPendingRequest(requestId, 'browser_closed')
    })

    try {
      sendRequestToDevice(deviceSocket, requestId, request)
    } catch (error) {
      const record = requestMap.get(requestId)
      requestMap.delete(requestId)
      if (record) {
        failRelayRequest(record, 502, error?.message || '发送 relay 请求失败。')
      }
    }
  }

  app.get('/health', async (request) => {
    const tenant = getTenantForRequest(request)
    if (tenant) {
      const tenantState = getTenantState(tenant.key)
      return {
        ok: true,
        tenant: tenant.key,
        host: getRequestHost(request),
        deviceOnline: Boolean(getActiveDeviceSocket(tenant.key)),
        deviceId: tenantState?.deviceId || '',
      }
    }

    return {
      ok: true,
      tenants: config.tenants.map((item) => {
        const tenantState = getTenantState(item.key)
        return {
          key: item.key,
          hosts: item.hosts,
          deviceOnline: Boolean(getActiveDeviceSocket(item.key)),
          deviceId: tenantState?.deviceId || '',
        }
      }),
    }
  })

  app.get('/relay/device-status', async (request, reply) => {
    const tenant = requireTenantRequest(request, reply)
    if (!tenant) {
      return
    }

    if (ensureAuthorized(request, reply, tenant) !== true) {
      return
    }

    const tenantState = getTenantState(tenant.key)
    return {
      ok: true,
      tenant: tenant.key,
      host: getRequestHost(request),
      deviceOnline: Boolean(getActiveDeviceSocket(tenant.key)),
      deviceId: tenantState?.deviceId || '',
      connectedAt: tenantState?.connectedAt || '',
      version: tenantState?.version || '',
    }
  })

  app.get('/relay/login', async (request, reply) => {
    const tenant = requireTenantRequest(request, reply)
    if (!tenant) {
      return
    }

    if (!tenant.accessToken) {
      return reply.redirect('/')
    }

    const token = String(request.query?.token || '').trim()
    const redirectPath = normalizeRedirectPath(request.query?.redirect)
    if (token && constantTimeEqual(token, tenant.accessToken)) {
      reply.header('Set-Cookie', createCookieValue(config.accessCookieName, tenant.accessToken, isHttpsRequest(request)))
      return reply.redirect(redirectPath)
    }

    return reply
      .code(token ? 401 : 200)
      .type('text/html; charset=utf-8')
      .send(buildLoginPage({
        errorMessage: token ? '访问令牌不正确。' : '',
        redirectPath,
        tenantLabel: tenant.key,
      }))
  })

  app.route({
    method: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'],
    url: '/api/*',
    handler: handleProxyRequest,
  })

  app.route({
    method: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'],
    url: '/uploads/*',
    handler: handleProxyRequest,
  })

  app.get('/', async (request, reply) => {
    const tenant = requireTenantRequest(request, reply)
    if (!tenant) {
      return
    }
    if (ensureAuthorized(request, reply, tenant) !== true) {
      return
    }
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(webIndexPath))
  })

  app.get('/*', async (request, reply) => {
    if (getRequestPath(request).startsWith('/relay/')) {
      return reply.code(404).send({ message: '资源不存在。' })
    }

    const tenant = requireTenantRequest(request, reply)
    if (!tenant) {
      return
    }
    if (ensureAuthorized(request, reply, tenant) !== true) {
      return
    }
    return reply.type('text/html; charset=utf-8').send(fs.createReadStream(webIndexPath))
  })

  wsServer.on('connection', (socket, request) => {
    const tenant = resolveRelayTenantByHost(config.tenants, request?.headers?.['x-forwarded-host'] || request?.headers?.host || '')
    if (!tenant) {
      app.log.warn({ host: normalizeRelayHost(request?.headers?.host || request?.headers?.['x-forwarded-host'] || '') }, '[relay] WebSocket 连接未匹配到租户')
      socket.close(1008, 'invalid_tenant')
      return
    }

    const tenantState = getTenantState(tenant.key)
    let authenticated = false
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        app.log.warn({ tenantKey: tenant.key, host: tenant.hosts[0] || '' }, '[relay] 设备认证超时，连接将被关闭')
        socket.close(1008, 'missing_auth')
      }
    }, DEVICE_AUTH_TIMEOUT_MS)

    socket.on('message', (payload, isBinary) => {
      if (isBinary) {
        return
      }

      let message
      try {
        message = JSON.parse(payload.toString('utf8'))
      } catch {
        return
      }

      if (!authenticated) {
        if (message.type !== 'hello') {
          app.log.warn({ tenantKey: tenant.key, host: tenant.hosts[0] || '' }, '[relay] 收到未认证设备的非法首包，连接将被关闭')
          socket.close(1008, 'missing_hello')
          return
        }

        const providedToken = String(message.deviceToken || '').trim()
        const providedDeviceId = String(message.deviceId || '').trim()
        if (!constantTimeEqual(providedToken, tenant.deviceToken)) {
          app.log.warn({
            tenantKey: tenant.key,
            host: tenant.hosts[0] || '',
            deviceId: providedDeviceId || 'unknown-device',
          }, '[relay] 设备令牌不匹配，连接将被拒绝')
          socket.close(1008, 'invalid_token')
          return
        }
        if (tenant.expectedDeviceId && providedDeviceId !== tenant.expectedDeviceId) {
          app.log.warn({
            tenantKey: tenant.key,
            host: tenant.hosts[0] || '',
            expectedDeviceId: tenant.expectedDeviceId,
            providedDeviceId: providedDeviceId || 'unknown-device',
          }, '[relay] 设备 ID 不匹配，连接将被拒绝')
          socket.close(1008, 'invalid_device')
          return
        }

        authenticated = true
        clearTimeout(authTimer)

        if (tenantState?.socket && tenantState.socket !== socket) {
          app.log.warn({
            tenantKey: tenant.key,
            host: tenant.hosts[0] || '',
            deviceId: providedDeviceId || 'unknown-device',
          }, '[relay] 当前租户已有旧设备连接，将被新连接替换')
          tenantState.socket.close(1012, 'replaced_by_new_connection')
        }

        if (tenantState) {
          tenantState.socket = socket
          tenantState.deviceId = providedDeviceId
          tenantState.connectedAt = new Date().toISOString()
          tenantState.version = String(message.version || '').trim()
        }
        socket.send(JSON.stringify({
          type: 'hello.ack',
          ok: true,
          deviceId: providedDeviceId,
          tenantKey: tenant.key,
        }))
        app.log.info({
          tenantKey: tenant.key,
          host: tenant.hosts[0] || '',
          deviceId: providedDeviceId || 'unknown-device',
        }, '[relay] 设备已连接')
        return
      }

      const record = requestMap.get(String(message.requestId || ''))
      if (!record || record.tenantKey !== tenant.key) {
        return
      }

      if (message.type === 'response.start') {
        writeRelayResponseStart(record, message)
        return
      }

      if (message.type === 'response.body') {
        writeRelayResponseBody(record, message)
        return
      }

      if (message.type === 'response.end') {
        requestMap.delete(record.requestId)
        finalizeRelayResponse(record)
        return
      }

      if (message.type === 'response.error') {
        requestMap.delete(record.requestId)
        failRelayRequest(record, 502, message.message || '本地 PromptX 响应失败。')
      }
    })

    socket.on('close', (code, reason) => {
      const closeReason = reason?.toString('utf8') || ''
      clearTimeout(authTimer)
      if (tenantState?.socket === socket) {
        const disconnectedRequestIds = [...requestMap.keys()].filter((requestId) => requestMap.get(requestId)?.tenantKey === tenant.key)
        disconnectedRequestIds.forEach((requestId) => {
          const record = requestMap.get(requestId)
          requestMap.delete(requestId)
          if (record) {
            failRelayRequest(record, 503, 'PromptX 本地设备已断开。')
          }
        })
        tenantState.socket = null
        tenantState.deviceId = ''
        tenantState.connectedAt = ''
        tenantState.version = ''
        app.log.warn({
          tenantKey: tenant.key,
          host: tenant.hosts[0] || '',
          code: Number(code || 0),
          reason: closeReason || 'none',
        }, '[relay] 设备已断开')
      } else if (!authenticated) {
        app.log.warn({
          tenantKey: tenant.key,
          host: tenant.hosts[0] || '',
          code: Number(code || 0),
          reason: closeReason || 'none',
        }, '[relay] 未认证设备连接已关闭')
      }
    })
  })

  app.server.on('upgrade', (request, socket, head) => {
    const pathname = String(request.url || '').split('?')[0]
    if (pathname !== '/relay/connect') {
      socket.destroy()
      return
    }

    wsServer.handleUpgrade(request, socket, head, (ws) => {
      wsServer.emit('connection', ws, request)
    })
  })

  await app.listen({ host: config.host, port: config.port })
  const resolvedAddress = app.server.address()
  const resolvedPort = typeof resolvedAddress === 'object' && resolvedAddress ? resolvedAddress.port : config.port

  const accessUrl = `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${resolvedPort}`
  app.log.info(`promptx relay running at ${accessUrl}`)
  app.log.info(`[relay] 已加载 ${config.tenants.length} 个租户，来源：${config.tenantSource}`)
  config.tenants.forEach((tenant) => {
    app.log.info({
      tenantKey: tenant.key,
      hosts: tenant.hosts,
      expectedDeviceId: tenant.expectedDeviceId || '',
      accessTokenEnabled: Boolean(tenant.accessToken),
    }, '[relay] 租户已就绪，等待本地 PromptX 接入')
  })

  return {
    app,
    config,
    port: resolvedPort,
    async close() {
      await new Promise((resolve) => {
        try {
          wsServer.close(() => resolve())
        } catch {
          resolve()
        }
      })
      await app.close()
    },
  }
}

export {
  normalizeRelayHost,
  normalizeRelayTenantConfig,
  normalizeRequestBodyToBuffer,
  readRelayServerConfig,
  resolveRelayTenantByHost,
  startRelayServer,
}
