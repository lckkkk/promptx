import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function normalizeTenantKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function normalizeHost(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
}

function resolveTenantHost({ key = '', domain = '', host = '' } = {}) {
  const normalizedHost = normalizeHost(host)
  if (normalizedHost) {
    return normalizedHost
  }

  const normalizedKey = normalizeTenantKey(key)
  const normalizedDomain = normalizeHost(domain)
  if (!normalizedKey || !normalizedDomain) {
    return ''
  }

  return `${normalizedKey}.${normalizedDomain}`
}

function inferBaseDomainFromHost(host = '') {
  const normalizedHost = normalizeHost(host)
  const parts = normalizedHost.split('.').filter(Boolean)
  if (parts.length < 3) {
    return ''
  }
  return parts.slice(1).join('.')
}

function createRandomToken(prefix = 'px') {
  return `${prefix}_${crypto.randomBytes(12).toString('base64url')}`
}

function readRelayTenantsFile(filePath) {
  const resolvedPath = path.resolve(String(filePath || '').trim())

  try {
    const payload = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
    const tenants = Array.isArray(payload) ? payload : payload?.tenants
    if (!Array.isArray(tenants)) {
      return {
        path: resolvedPath,
        tenants: [],
      }
    }
    return {
      path: resolvedPath,
      tenants,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: resolvedPath,
        tenants: [],
      }
    }
    throw error
  }
}

function writeRelayTenantsFile(filePath, tenants = []) {
  const resolvedPath = path.resolve(String(filePath || '').trim())
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })
  fs.writeFileSync(resolvedPath, `${JSON.stringify({ tenants }, null, 2)}\n`, 'utf8')
  return resolvedPath
}

function listRelayTenants(filePath) {
  return readRelayTenantsFile(filePath)
}

function inferRelayTenantDomain({
  filePath,
  domain = '',
  fallbackDomain = '',
  fallbackHost = '',
} = {}) {
  const normalizedDomain = normalizeHost(domain)
  if (normalizedDomain) {
    return normalizedDomain
  }

  const normalizedFallbackDomain = normalizeHost(fallbackDomain)
  if (normalizedFallbackDomain) {
    return normalizedFallbackDomain
  }

  const inferredFromFallbackHost = inferBaseDomainFromHost(fallbackHost)
  if (inferredFromFallbackHost) {
    return inferredFromFallbackHost
  }

  const current = readRelayTenantsFile(filePath)
  for (const tenant of current.tenants) {
    const inferred = inferBaseDomainFromHost(tenant?.host)
    if (inferred) {
      return inferred
    }
  }

  return ''
}

function addRelayTenant({
  filePath,
  key,
  domain,
  host,
  fallbackDomain,
  fallbackHost,
  deviceId,
  deviceToken,
  accessToken,
} = {}) {
  const normalizedKey = normalizeTenantKey(key)
  if (!normalizedKey) {
    throw new Error('租户 key 不能为空，且只能包含字母、数字和中划线。')
  }

  const resolvedDomain = inferRelayTenantDomain({
    filePath,
    domain,
    fallbackDomain,
    fallbackHost,
  })
  const resolvedHost = resolveTenantHost({ key: normalizedKey, domain: resolvedDomain, host })
  if (!resolvedHost) {
    throw new Error('请提供 --domain 或 --host，用来生成租户子域名。')
  }

  const normalizedDeviceId = String(deviceId || `${normalizedKey}-mac`).trim()
  if (!normalizedDeviceId) {
    throw new Error('deviceId 不能为空。')
  }

  const nextTenant = {
    key: normalizedKey,
    host: resolvedHost,
    deviceId: normalizedDeviceId,
    deviceToken: String(deviceToken || createRandomToken(`dev_${normalizedKey}`)).trim(),
    accessToken: String(accessToken || createRandomToken(`access_${normalizedKey}`)).trim(),
  }

  const current = readRelayTenantsFile(filePath)
  if (current.tenants.some((item) => normalizeTenantKey(item?.key) === normalizedKey)) {
    throw new Error(`租户已存在：${normalizedKey}`)
  }
  if (current.tenants.some((item) => normalizeHost(item?.host) === resolvedHost)) {
    throw new Error(`域名已存在：${resolvedHost}`)
  }

  const nextTenants = [...current.tenants, nextTenant]
  writeRelayTenantsFile(current.path, nextTenants)

  return {
    path: current.path,
    tenant: nextTenant,
    tenants: nextTenants,
  }
}

function removeRelayTenant({
  filePath,
  key,
  host,
} = {}) {
  const normalizedKey = normalizeTenantKey(key)
  const normalizedHost = normalizeHost(host)
  if (!normalizedKey && !normalizedHost) {
    throw new Error('请提供要删除的租户 key 或 --host。')
  }

  const current = readRelayTenantsFile(filePath)
  const nextTenants = current.tenants.filter((item) => {
    const itemKey = normalizeTenantKey(item?.key)
    const itemHost = normalizeHost(item?.host)
    if (normalizedKey && itemKey === normalizedKey) {
      return false
    }
    if (normalizedHost && itemHost === normalizedHost) {
      return false
    }
    return true
  })

  if (nextTenants.length === current.tenants.length) {
    throw new Error(`未找到要删除的租户：${normalizedKey || normalizedHost}`)
  }

  writeRelayTenantsFile(current.path, nextTenants)

  return {
    path: current.path,
    tenants: nextTenants,
  }
}

export {
  addRelayTenant,
  createRandomToken,
  inferBaseDomainFromHost,
  inferRelayTenantDomain,
  listRelayTenants,
  normalizeHost,
  normalizeTenantKey,
  readRelayTenantsFile,
  removeRelayTenant,
  resolveTenantHost,
  writeRelayTenantsFile,
}
