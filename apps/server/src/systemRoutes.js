import fs from 'node:fs'
import path from 'node:path'
import {
  EXPIRY_OPTIONS,
  VISIBILITY_OPTIONS,
} from '../../../packages/shared/src/index.js'
import { getApiErrorPayload } from './apiErrors.js'
import { listAvailableAgentEngines } from './agents/index.js'
import { assertInternalRequest } from './internalAuth.js'
import {
  getRelayConfigForClient,
  isRelayConfigManagedByEnv,
  writeStoredRelayConfig,
} from './relayConfig.js'
import {
  getSystemConfigForClient,
  getSystemConfigManagedByEnv,
  writeStoredSystemConfig,
} from './systemConfig.js'
import { resolvePromptxPaths } from './appPaths.js'

function readLocalUpdateStatus() {
  try {
    const { promptxHomeDir } = resolvePromptxPaths()
    const filePath = path.join(promptxHomeDir, 'run', 'local-update-status.json')
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

async function fetchRunnerDiagnostics(runnerClient) {
  try {
    const payload = await runnerClient.getDiagnostics()
    return {
      ok: true,
      baseUrl: runnerClient.baseUrl,
      runner: payload.runner || null,
    }
  } catch (error) {
    return {
      ok: false,
      baseUrl: runnerClient.baseUrl,
      messageKey: error?.messageKey || 'errors.runnerDiagnosticsReadFailed',
      message: String(error?.message || error || '无法读取 runner diagnostics'),
    }
  }
}

function registerSystemRoutes(app, options = {}) {
  const {
    createNotificationProfile = () => null,
    deleteNotificationProfile = () => ({ error: 'not_found' }),
    listNotificationProfiles = () => [],
    promptxVersion,
    relayClient,
    runnerClient,
    runRecoveryService,
    maintenanceService,
    updateNotificationProfile = () => ({ error: 'not_found' }),
    getGitDiffWorkerDiagnostics,
    localBaseUrl,
  } = options

  app.get('/api/meta', async () => ({
    version: promptxVersion,
    expiryOptions: EXPIRY_OPTIONS,
    visibilityOptions: VISIBILITY_OPTIONS,
    agentEngineOptions: listAvailableAgentEngines(),
  }))

  app.get('/api/relay/status', async () => ({
    relay: relayClient.getStatus(),
  }))

  app.get('/api/diagnostics/git-diff-worker', async () => ({
    gitDiffWorker: getGitDiffWorkerDiagnostics(),
  }))

  app.get('/api/diagnostics/runtime', async () => ({
    runner: await fetchRunnerDiagnostics(runnerClient),
    gitDiffWorker: getGitDiffWorkerDiagnostics(),
    recovery: runRecoveryService.getDiagnostics(),
    maintenance: maintenanceService.getDiagnostics(),
  }))

  app.post('/api/diagnostics/maintenance/run', async () => ({
    maintenance: maintenanceService.runCleanup(),
  }))

  app.get('/api/system/config', async () => ({
    config: getSystemConfigForClient(),
    managedByEnv: getSystemConfigManagedByEnv(),
  }))

  app.get('/api/system/local-update-status', async () => ({
    status: readLocalUpdateStatus(),
  }))

  app.put('/api/system/config', async (request, reply) => {
    writeStoredSystemConfig(request.body || {})
    const effectiveConfig = getSystemConfigForClient()
    const managedByEnv = getSystemConfigManagedByEnv()

    if (!managedByEnv.runner?.maxConcurrentRuns) {
      try {
        await runnerClient.updateConfig({
          maxConcurrentRuns: effectiveConfig.runner.maxConcurrentRuns,
        })
      } catch (error) {
        request.log.warn(error, 'runner config hot update failed')
        return reply.code(error.statusCode || 503).send({
          messageKey: error?.messageKey || 'errors.systemConfigHotReloadFailed',
          message: `系统配置已保存，但 runner 热更新失败：${error.message || 'unknown error'}`,
          config: effectiveConfig,
          managedByEnv,
        })
      }
    }

    return {
      config: effectiveConfig,
      managedByEnv,
    }
  })

  app.get('/api/relay/config', async () => ({
    config: {
      ...getRelayConfigForClient(),
    },
    managedByEnv: isRelayConfigManagedByEnv(),
    relay: relayClient.getStatus(),
  }))

  app.put('/api/relay/config', async (request) => {
    const savedConfig = writeStoredRelayConfig(request.body || {})
    relayClient.updateConfig({
      ...savedConfig,
      localBaseUrl,
    })

    return {
      config: getRelayConfigForClient(),
      managedByEnv: isRelayConfigManagedByEnv(),
      relay: relayClient.getStatus(),
    }
  })

  app.post('/api/relay/reconnect', async (request, reply) => {
    const status = relayClient.getStatus()
    if (!status.enabled) {
      return reply.code(400).send({
        messageKey: 'errors.relayNotEnabled',
        message: '当前远程访问尚未启用，请先保存完整的 Relay 配置。',
        relay: status,
      })
    }

    relayClient.reconnect()
    return {
      ok: true,
      relay: relayClient.getStatus(),
    }
  })

  app.get('/api/notification-profiles', async (request) => {
    const userId = request.user?.username || 'default'
    return {
      items: listNotificationProfiles(userId),
    }
  })

  app.post('/api/notification-profiles', async (request, reply) => {
    const userId = request.user?.username || 'default'
    try {
      const profile = createNotificationProfile(request.body || {}, userId)
      return reply.code(201).send(profile)
    } catch (error) {
      return reply.code(400).send({
        messageKey: 'errors.notificationProfileCreateFailed',
        message: error?.message || '通知配置创建失败。',
      })
    }
  })

  app.put('/api/notification-profiles/:profileId', async (request, reply) => {
    const userId = request.user?.username || 'default'
    try {
      const result = updateNotificationProfile(request.params.profileId, request.body || {}, userId)
      if (result?.error === 'not_found') {
        return reply.code(404).send({
          messageKey: 'errors.notificationProfileNotFound',
          message: '通知配置不存在。',
        })
      }
      return result
    } catch (error) {
      return reply.code(400).send({
        messageKey: 'errors.notificationProfileUpdateFailed',
        message: error?.message || '通知配置更新失败。',
      })
    }
  })

  app.delete('/api/notification-profiles/:profileId', async (request, reply) => {
    const userId = request.user?.username || 'default'
    const result = deleteNotificationProfile(request.params.profileId, userId)
    if (result?.error === 'not_found') {
      return reply.code(404).send({
        messageKey: 'errors.notificationProfileNotFound',
        message: '通知配置不存在。',
      })
    }
    if (result?.error === 'in_use') {
      return reply.code(409).send({
        messageKey: 'errors.notificationProfileInUse',
        message: `该通知配置仍被 ${result.usageCount} 个任务引用，请先解除引用。`,
      })
    }
    return reply.code(204).send()
  })

  app.get('/internal/system-config', async (request, reply) => {
    try {
      assertInternalRequest(request.headers)
      return {
        config: getSystemConfigForClient(),
        managedByEnv: getSystemConfigManagedByEnv(),
      }
    } catch (error) {
      return reply.code(error.statusCode || 400).send(getApiErrorPayload(error, {
        messageKey: 'errors.systemConfigReadFailed',
        message: error.message || '系统配置读取失败。',
      }))
    }
  })
}

export {
  fetchRunnerDiagnostics,
  registerSystemRoutes,
}
