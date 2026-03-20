import {
  AGENT_ENGINE_OPTIONS,
  AGENT_ENGINES,
  getAgentEngineLabel,
  normalizeAgentEngine,
} from '../../../../packages/shared/src/index.js'
import { codexRunner } from './codexRunner.js'
import { claudeCodeRunner } from './claudeCodeRunner.js'
import { openCodeRunner } from './openCodeRunner.js'

const runnerRegistry = new Map([
  [codexRunner.engine, codexRunner],
  [claudeCodeRunner.engine, claudeCodeRunner],
  [openCodeRunner.engine, openCodeRunner],
])

export function getAgentRunner(engine = AGENT_ENGINES.CODEX) {
  return runnerRegistry.get(normalizeAgentEngine(engine)) || null
}

export function listAvailableAgentEngines() {
  return AGENT_ENGINE_OPTIONS.map((item) => ({
    ...item,
    available: runnerRegistry.has(item.value),
  }))
}

export function listEnabledAgentEngines() {
  return listAvailableAgentEngines().filter((item) => item.enabled)
}

export function assertAgentRunner(engine = AGENT_ENGINES.CODEX) {
  const normalized = normalizeAgentEngine(engine)
  const runner = getAgentRunner(normalized)
  if (!runner) {
    throw new Error(`当前还不支持执行引擎：${getAgentEngineLabel(normalized)}`)
  }
  return runner
}

export function listKnownWorkspacesByEngine(engine = AGENT_ENGINES.CODEX, limit) {
  const runner = getAgentRunner(engine)
  if (!runner?.listKnownWorkspaces) {
    return []
  }
  return runner.listKnownWorkspaces(limit)
}
