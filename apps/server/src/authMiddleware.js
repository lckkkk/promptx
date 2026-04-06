import { parseCookieHeader, constantTimeEqual } from './relayProtocol.js'
import { getAuthConfigForServer } from './authConfig.js'

const ACCESS_COOKIE_NAME = 'promptx_access'
const DEFAULT_LOGIN_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000
const DEFAULT_LOGIN_RATE_LIMIT_MAX_ATTEMPTS = 10

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

function createCookieValue(name, value) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
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

function buildServerLoginPage({ errorMessage = '', redirectPath = '/' } = {}) {
  const escapedError = String(errorMessage || '').replace(/[<>&"]/g, '')
  const escapedRedirect = String(redirectPath || '/').replace(/"/g, '&quot;')

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
    <p>请输入访问令牌，进入你的 PromptX 工作台。</p>
    ${escapedError ? `<div class="error">${escapedError}</div>` : ''}
    <input type="hidden" name="redirect" value="${escapedRedirect}" />
    <label for="token">访问令牌</label>
    <input id="token" name="token" type="password" autocomplete="current-password" required autofocus />
    <button type="submit">进入 PromptX</button>
  </form>
</body>
</html>`
}

function isAuthorizedRequest(request, accessToken) {
  if (!accessToken) return true

  const bearerToken = String(request.headers.authorization || '').replace(/^Bearer\s+/i, '').trim()
  if (bearerToken && constantTimeEqual(bearerToken, accessToken)) return true

  const cookies = parseCookieHeader(request.headers.cookie)
  return constantTimeEqual(cookies[ACCESS_COOKIE_NAME] || '', accessToken)
}

function isPublicPath(request) {
  if (request.method === 'OPTIONS') return true
  const requestPath = getRequestPath(request)
  if (requestPath === '/health') return true
  if (requestPath === '/login') return true
  if (requestPath.startsWith('/internal/')) return true
  return false
}

function registerAuthMiddleware(app) {
  const loginRateLimiter = createLoginRateLimiter()

  app.addHook('onRequest', async (request, reply) => {
    const { accessToken } = getAuthConfigForServer()
    if (!accessToken) return
    if (isPublicPath(request)) return
    if (isAuthorizedRequest(request, accessToken)) return

    if (isHtmlRequest(request)) {
      const requestPath = getRequestPath(request)
      const redirectQuery = requestPath !== '/' ? `?redirect=${encodeURIComponent(requestPath)}` : ''
      return reply.code(302).redirect(`/login${redirectQuery}`)
    }

    return reply.code(401).send({ message: '请先登录。', messageKey: 'errors.unauthorized' })
  })

  app.get('/login', async (request, reply) => {
    const { accessToken } = getAuthConfigForServer()
    if (!accessToken) return reply.redirect('/')

    if (isAuthorizedRequest(request, accessToken)) {
      const redirectPath = normalizeRedirectPath(request.query?.redirect)
      return reply.redirect(redirectPath)
    }

    const redirectPath = normalizeRedirectPath(request.query?.redirect)
    return reply
      .code(200)
      .type('text/html; charset=utf-8')
      .send(buildServerLoginPage({ redirectPath }))
  })

  app.post('/login', async (request, reply) => {
    const { accessToken } = getAuthConfigForServer()
    if (!accessToken) return reply.redirect('/')

    const form = parseUrlEncodedBody(request.body)
    const redirectPath = normalizeRedirectPath(form.redirect)
    const rateLimitKey = `server-login:${getClientIp(request)}`

    const remaining = loginRateLimiter.getRemaining(rateLimitKey)
    if (!remaining.ok) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(buildServerLoginPage({
          errorMessage: `尝试次数过多，请 ${formatRetryAfterText(remaining.retryAfterMs)} 后再试。`,
          redirectPath,
        }))
    }

    const token = String(form.token || '').trim()
    if (token && constantTimeEqual(token, accessToken)) {
      loginRateLimiter.clear(rateLimitKey)
      reply.header('Set-Cookie', createCookieValue(ACCESS_COOKIE_NAME, accessToken))
      return reply.redirect(redirectPath)
    }

    const nextState = loginRateLimiter.recordFailure(rateLimitKey)
    if (!nextState.ok) {
      return reply
        .code(429)
        .type('text/html; charset=utf-8')
        .send(buildServerLoginPage({
          errorMessage: `尝试次数过多，请 ${formatRetryAfterText(nextState.retryAfterMs)} 后再试。`,
          redirectPath,
        }))
    }

    return reply
      .code(401)
      .type('text/html; charset=utf-8')
      .send(buildServerLoginPage({
        errorMessage: '访问令牌不正确。',
        redirectPath,
      }))
  })
}

export {
  ACCESS_COOKIE_NAME,
  buildServerLoginPage,
  isAuthorizedRequest,
  registerAuthMiddleware,
}
