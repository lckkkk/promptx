import fs from 'node:fs'
import path from 'node:path'

import { ensurePromptxStorageReady } from './appPaths.js'

const AUTH_CONFIG_FILE = 'auth-config.json'

function getAuthConfigPath() {
  const { dataDir } = ensurePromptxStorageReady()
  return path.join(dataDir, AUTH_CONFIG_FILE)
}

function normalizeAuthConfig(input = {}) {
  return {
    accessToken: String(input?.accessToken || '').trim(),
  }
}

function readStoredAuthConfig() {
  const filePath = getAuthConfigPath()
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return normalizeAuthConfig(payload)
  } catch {
    return normalizeAuthConfig()
  }
}

function writeStoredAuthConfig(input = {}) {
  const filePath = getAuthConfigPath()
  const normalized = normalizeAuthConfig(input)
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

function getAuthConfigForServer() {
  const envToken = String(process.env.PROMPTX_ACCESS_TOKEN || '').trim()
  if (envToken) {
    return normalizeAuthConfig({ accessToken: envToken })
  }
  return readStoredAuthConfig()
}

export {
  getAuthConfigForServer,
  getAuthConfigPath,
  normalizeAuthConfig,
  readStoredAuthConfig,
  writeStoredAuthConfig,
}
