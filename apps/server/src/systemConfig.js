import fs from 'node:fs'
import path from 'node:path'

import { ensurePromptxStorageReady } from './appPaths.js'

const SYSTEM_CONFIG_FILE = 'system-config.json'
const DEFAULT_RUNNER_MAX_CONCURRENT_RUNS = 3
const MIN_RUNNER_MAX_CONCURRENT_RUNS = 1
const MAX_RUNNER_MAX_CONCURRENT_RUNS = 16

function getSystemConfigPath() {
  const { dataDir } = ensurePromptxStorageReady()
  return path.join(dataDir, SYSTEM_CONFIG_FILE)
}

function clampInteger(value, fallback, minimum, maximum) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, Math.round(normalized)))
}

function normalizeRunnerConfig(input = {}, fallback = {}) {
  const fallbackMaxConcurrentRuns = clampInteger(
    fallback?.maxConcurrentRuns,
    DEFAULT_RUNNER_MAX_CONCURRENT_RUNS,
    MIN_RUNNER_MAX_CONCURRENT_RUNS,
    MAX_RUNNER_MAX_CONCURRENT_RUNS
  )

  return {
    maxConcurrentRuns: clampInteger(
      input?.maxConcurrentRuns,
      fallbackMaxConcurrentRuns,
      MIN_RUNNER_MAX_CONCURRENT_RUNS,
      MAX_RUNNER_MAX_CONCURRENT_RUNS
    ),
  }
}

function normalizeWorkspaceConfig(input = {}) {
  const rootPath = String(input?.rootPath || '').trim()
  return { rootPath }
}

function normalizeNotificationConfig(input = {}, fallback = {}) {
  const fallbackDefaultProfileId = Number(fallback?.defaultProfileId) || 0
  const hasExplicitDefaultProfileId = Object.prototype.hasOwnProperty.call(input || {}, 'defaultProfileId')
  const nextDefaultProfileId = Number(input?.defaultProfileId)

  return {
    defaultProfileId: hasExplicitDefaultProfileId
      ? (Number.isInteger(nextDefaultProfileId) && nextDefaultProfileId > 0 ? nextDefaultProfileId : null)
      : fallbackDefaultProfileId > 0
        ? fallbackDefaultProfileId
        : null,
  }
}

function normalizeSystemConfig(input = {}, fallback = {}) {
  return {
    runner: normalizeRunnerConfig(input?.runner || {}, fallback?.runner || {}),
    notification: normalizeNotificationConfig(input?.notification || {}, fallback?.notification || {}),
    workspace: normalizeWorkspaceConfig(input?.workspace || {}),
  }
}

function readStoredSystemConfig() {
  const filePath = getSystemConfigPath()

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return normalizeSystemConfig(payload)
  } catch {
    return normalizeSystemConfig()
  }
}

function writeStoredSystemConfig(input = {}) {
  const filePath = getSystemConfigPath()
  const previous = readStoredSystemConfig()
  const normalized = normalizeSystemConfig(input, previous)
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

function getSystemConfigManagedByEnv() {
  return {
    runner: {
      maxConcurrentRuns: Boolean(String(process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS || '').trim()),
    },
  }
}

function getSystemConfigForClient() {
  const stored = readStoredSystemConfig()
  const managedByEnv = getSystemConfigManagedByEnv()

  return normalizeSystemConfig({
    runner: {
      maxConcurrentRuns: managedByEnv.runner.maxConcurrentRuns
        ? process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS
        : stored.runner.maxConcurrentRuns,
    },
    notification: {
      defaultProfileId: stored.notification?.defaultProfileId,
    },
    workspace: {
      rootPath: stored.workspace?.rootPath,
    },
  }, stored)
}

export {
  getSystemConfigForClient,
  getSystemConfigManagedByEnv,
  getSystemConfigPath,
  normalizeSystemConfig,
  readStoredSystemConfig,
  writeStoredSystemConfig,
}
