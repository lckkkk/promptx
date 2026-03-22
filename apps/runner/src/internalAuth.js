const INTERNAL_AUTH_HEADER = 'x-promptx-internal-token'
const DEFAULT_INTERNAL_TOKEN = 'promptx-internal-dev-token'

export function getInternalAuthHeaderName() {
  return INTERNAL_AUTH_HEADER
}

export function getInternalAuthToken() {
  return String(process.env.PROMPTX_INTERNAL_TOKEN || DEFAULT_INTERNAL_TOKEN).trim() || DEFAULT_INTERNAL_TOKEN
}

export function buildInternalAuthHeaders(headers = {}) {
  return {
    ...headers,
    [INTERNAL_AUTH_HEADER]: getInternalAuthToken(),
  }
}

export function isValidInternalAuthToken(value = '') {
  return String(value || '').trim() === getInternalAuthToken()
}

export function readInternalAuthToken(headers = {}) {
  const target = headers && typeof headers === 'object' ? headers : {}
  return String(target[INTERNAL_AUTH_HEADER] || target[INTERNAL_AUTH_HEADER.toLowerCase()] || '').trim()
}

export function assertInternalRequest(headers = {}) {
  if (!isValidInternalAuthToken(readInternalAuthToken(headers))) {
    const error = new Error('非法内部请求')
    error.statusCode = 401
    throw error
  }
}
