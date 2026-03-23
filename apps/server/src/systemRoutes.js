import {
  EXPIRY_OPTIONS,
  VISIBILITY_OPTIONS,
} from '../../../packages/shared/src/index.js'
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
      message: String(error?.message || error || '无法读取 runner diagnostics'),
    }
  }
}

function registerSystemRoutes(app, options = {}) {
  const {
    promptxVersion,
    relayClient,
    runnerClient,
    runRecoveryService,
    maintenanceService,
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

  app.get('/internal/system-config', async (request, reply) => {
    try {
      assertInternalRequest(request.headers)
      return {
        config: getSystemConfigForClient(),
        managedByEnv: getSystemConfigManagedByEnv(),
      }
    } catch (error) {
      return reply.code(error.statusCode || 400).send({
        message: error.message || '系统配置读取失败。',
      })
    }
  })
}

export {
  fetchRunnerDiagnostics,
  registerSystemRoutes,
}
