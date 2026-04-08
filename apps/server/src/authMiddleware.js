import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { parseCookieHeader } from './relayProtocol.js'
import { validateUserCredentials, hasUsersConfigured } from './usersConfig.js'
import { ensurePromptxStorageReady } from './appPaths.js'

const SESSION_COOKIE_NAME = 'promptx_session'
const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10
const SESSION_SALT = 'promptx-session-salt-v1'
const SECRET_FILE = 'session-secret.json'

function getSessionSecretPath() {
  const { dataDir } = ensurePromptxStorageReady()
  return path.join(dataDir, SECRET_FILE)
}

function loadOrCreateSessionSecret() {
  const envSecret = String(process.env.PROMPTX_SESSION_SECRET || '').trim()
  if (envSecret) return envSecret

  const filePath = getSessionSecretPath()
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    if (data?.secret) return String(data.secret)
  } catch {
    // 不存在则生成
  }

  const secret = crypto.randomBytes(32).toString('hex')
  try {
    fs.writeFileSync(filePath, `${JSON.stringify({ secret })}\n`, 'utf8')
  } catch {
    // 写入失败时继续使用内存中的 secret
  }
  return secret
}

let _sessionSecret = null
function getSessionSecret() {
  if (!_sessionSecret) {
    _sessionSecret = loadOrCreateSessionSecret()
  }
  return _sessionSecret
}

function deriveKey(secret) {
  return crypto.scryptSync(secret, SESSION_SALT, 32)
}

function encryptSession(username) {
  const iv = crypto.randomBytes(16)
  const key = deriveKey(getSessionSecret())
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv)
  const encrypted = Buffer.concat([cipher.update(username, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptSession(token) {
  try {
    const parts = String(token || '').split(':')
    if (parts.length !== 2) return null
    const [ivHex, encryptedHex] = parts
    const iv = Buffer.from(ivHex, 'hex')
    const key = deriveKey(getSessionSecret())
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedHex, 'hex')), decipher.final()])
    return decrypted.toString('utf8')
  } catch {
    return null
  }
}

function getRequestPath(request) {
  return String(request.raw.url || '/').split('?')[0] || '/'
}

function isHtmlRequest(request) {
  return String(request.headers.accept || '').toLowerCase().includes('text/html')
}

function normalizeRedirectPath(value = '/') {
  const raw = String(value || '/').trim()
  if (!raw.startsWith('/')) return '/'
  if (raw.startsWith('/login') || raw.startsWith('//')) return '/'
  return raw
}

function createCookieValue(name, value, maxAge = 2592000) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`
}

function clearCookieValue(name) {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
}

function parseUrlEncodedBody(body) {
  const rawBody = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '')
  const params = new URLSearchParams(rawBody)
  return Object.fromEntries(params.entries())
}

function getClientIp(request) {
  const forwarded = String(request?.headers?.['x-forwarded-for'] || '').split(',')[0]?.trim()
  if (forwarded) return forwarded
  return String(request?.ip || request?.socket?.remoteAddress || '').trim() || 'unknown'
}

function formatRetryAfterText(retryAfterMs = 0) {
  const seconds = Math.max(1, Math.ceil(Number(retryAfterMs || 0) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  return `${Math.ceil(seconds / 60)} 分钟`
}

function createLoginRateLimiter({
  windowMs = DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS,
  maxAttempts = DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS,
  now = () => Date.now(),
} = {}) {
  const attempts = new Map()

  function cleanup() {
    const currentTime = now()
    for (const [key, value] of attempts.entries()) {
      if (!value || currentTime >= value.resetAt) attempts.delete(key)
    }
  }

  function getState(key) {
    cleanup()
    return attempts.get(key) || { count: 0, resetAt: now() + windowMs }
  }

  return {
    getRemaining(key) {
      const state = getState(key)
      if (state.count >= maxAttempts) {
        return { ok: false, retryAfterMs: Math.max(0, state.resetAt - now()) }
      }
      return { ok: true, retryAfterMs: 0 }
    },
    recordFailure(key) {
      const state = getState(key)
      const nextState = { count: state.count + 1, resetAt: state.resetAt }
      attempts.set(key, nextState)
      if (nextState.count >= maxAttempts) {
        return { ok: false, retryAfterMs: Math.max(0, nextState.resetAt - now()) }
      }
      return { ok: true, retryAfterMs: 0 }
    },
    clear(key) {
      attempts.delete(key)
    },
  }
}

function buildServerLoginPage({ errorMessage = '', redirectPath = '/', loginReady = true } = {}) {
  const escapedError = String(errorMessage || '').replace(/[<>&"]/g, '')
  const escapedRedirect = String(redirectPath || '/').replace(/"/g, '&quot;')
  const description = loginReady
    ? '请输入用户名和密码，登录你的 PromptX 工作台。'
    : '当前还没有可登录账号。请先通过 CLI 添加账号，再回到这里登录。'
  const disabledAttr = loginReady ? '' : ' disabled'
  const helper = loginReady
    ? ''
    : '<div class="helper">请在服务器上执行 `promptx user add <username>`，并按提示设置密码。</div>'

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PromptX 登录</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: #f5f5f4; color: #1c1917; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .card { width: min(100%, 420px); border: 1px solid #d6d3d1; background: #fffbeb; box-shadow: 8px 8px 0 rgba(28,25,23,.06); padding: 24px; }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { margin: 0 0 16px; line-height: 1.6; color: #57534e; }
    label { display: block; margin-bottom: 8px; font-size: 13px; color: #44403c; }
    input { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #a8a29e; padding: 10px 12px; background: white; font: inherit; }
    button { margin-top: 14px; width: 100%; min-height: 44px; border: 1px solid #166534; background: #16a34a; color: white; padding: 10px 12px; cursor: pointer; font: inherit; font-size: 15px; }
    .error { margin-bottom: 12px; padding: 8px 12px; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; font-size: 13px; }
    .helper { margin-top: 12px; padding: 10px 12px; border: 1px dashed #d6d3d1; background: #fafaf9; color: #57534e; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
    button:disabled, input:disabled { opacity: .65; cursor: not-allowed; }
    @media (max-width: 640px) {
      body { padding: 12px; align-items: stretch; }
      .card { padding: 18px 16px; box-shadow: 4px 4px 0 rgba(28,25,23,.05); }
      h1 { font-size: 20px; }
      p { font-size: 14px; }
    }
  </style>
</head>
<body>
  <form class="card" action="/login" method="post">
    <h1>PromptX</h1>
    <p>${description}</p>
    ${escapedError ? `<div class="error">${escapedError}</div>` : ''}
    <input type="hidden" name="redirect" value="${escapedRedirect}" />
    <label for="username">用户名</label>
    <input id="username" name="username" type="text" autocomplete="username" required autofocus style="margin-bottom:10px;"${disabledAttr} />
    <label for="password">密码</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required${disabledAttr} />
    <button type="submit"${disabledAttr}>登录</button>
    ${helper}
  </form>
</body>
</html>`
}

// 从请求 Cookie 中解析当前用户（多用户模式）
function getUserFromSession(request) {
  const cookies = parseCookieHeader(request.headers.cookie)
  const sessionToken = cookies[SESSION_COOKIE_NAME]
  if (!sessionToken) return null
  const username = decryptSession(decodeURIComponent(sessionToken))
  if (!username) return null
  return { username }
}

function isPublicPath(request) {
  if (request.method === 'OPTIONS') return true
  const requestPath = getRequestPath(request)
  if (requestPath === '/health') return true
  if (requestPath === '/login') return true
  if (requestPath.startsWith('/uploads/')) return true
  if (requestPath.startsWith('/internal/')) return true
  return false
}

function registerAuthMiddleware(app) {
  const loginRateLimiter = createLoginRateLimiter()

  app.addHook('onRequest', async (request, reply) => {
    if (isPublicPath(request)) return

    const user = getUserFromSession(request)
    if (user) {
      request.user = user
      return
    }

    if (isHtmlRequest(request)) {
      const requestPath = getRequestPath(request)
      const redirectQuery = requestPath !== '/' ? `?redirect=${encodeURIComponent(requestPath)}` : ''
      return reply.code(302).redirect(`/login${redirectQuery}`)
    }

    return reply.code(401).send({ message: '请先登录。', messageKey: 'errors.unauthorized' })
  })

  app.get('/login', async (request, reply) => {
    const loginReady = hasUsersConfigured()

    const redirectPath = normalizeRedirectPath(request.query?.redirect)
    const user = getUserFromSession(request)
    if (user) return reply.redirect(redirectPath)

    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(buildServerLoginPage({ redirectPath, loginReady }))
  })

  app.post('/login', async (request, reply) => {
    const loginReady = hasUsersConfigured()

    const form = parseUrlEncodedBody(request.body)
    const redirectPath = normalizeRedirectPath(form.redirect)
    const rateLimitKey = `server-login:${getClientIp(request)}`

    if (!loginReady) {
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(buildServerLoginPage({
          errorMessage: '当前还没有可登录账号，请先通过 CLI 添加账号。',
          redirectPath,
          loginReady,
        }))
    }

    const remaining = loginRateLimiter.getRemaining(rateLimitKey)
    if (!remaining.ok) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(buildServerLoginPage({
          errorMessage: `尝试次数过多，请 ${formatRetryAfterText(remaining.retryAfterMs)} 后再试。`,
          redirectPath,
          loginReady,
        }))
    }

    const username = String(form.username || '').trim().toLowerCase()
    const password = String(form.password || '')

    if (!username) {
      return reply
        .code(401)
        .type('text/html; charset=utf-8')
        .send(buildServerLoginPage({ errorMessage: '请输入用户名。', redirectPath, loginReady }))
    }

    if (validateUserCredentials(username, password)) {
      loginRateLimiter.clear(rateLimitKey)
      reply.header('Set-Cookie', createCookieValue(SESSION_COOKIE_NAME, encryptSession(username)))
      return reply.redirect(redirectPath)
    }

    const nextState = loginRateLimiter.recordFailure(rateLimitKey)
    const errorMessage = nextState.ok
      ? '用户名或密码不正确。'
      : `尝试次数过多，请 ${formatRetryAfterText(nextState.retryAfterMs)} 后再试。`

    return reply
      .code(nextState.ok ? 401 : 429)
      .type('text/html; charset=utf-8')
      .send(buildServerLoginPage({
        errorMessage,
        redirectPath,
        loginReady,
      }))
  })

  app.post('/logout', async (request, reply) => {
    reply.header('Set-Cookie', clearCookieValue(SESSION_COOKIE_NAME))
    return reply.redirect('/login')
  })

  app.get('/api/auth-info', async (request) => {
    const username = request.user?.username || null
    return { multiUser: true, username, loginReady: hasUsersConfigured() }
  })
}

export {
  SESSION_COOKIE_NAME,
  buildServerLoginPage,
  getUserFromSession,
  registerAuthMiddleware,
}
