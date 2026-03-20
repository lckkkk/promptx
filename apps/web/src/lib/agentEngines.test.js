import test from 'node:test'
import assert from 'node:assert/strict'

import {
  fetchEnabledAgentEngineOptions,
  getEnabledAgentEngineOptions,
  normalizeAgentEngineOptions,
} from './agentEngines.js'

function createJsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name || '').toLowerCase() === 'content-type' ? 'application/json' : null
      },
    },
    async json() {
      return payload
    },
    async text() {
      return JSON.stringify(payload)
    },
  }
}

test('normalizeAgentEngineOptions 会保留服务端下发的 available 状态', () => {
  const items = normalizeAgentEngineOptions([
    { value: 'codex', label: 'Codex', enabled: true, available: true },
    { value: 'opencode', label: 'OpenCode', enabled: true, available: false },
  ])

  assert.deepEqual(items, [
    { value: 'codex', label: 'Codex', enabled: true, available: true },
    { value: 'opencode', label: 'OpenCode', enabled: true, available: false },
  ])

  assert.deepEqual(getEnabledAgentEngineOptions(items), [
    { value: 'codex', label: 'Codex', enabled: true, available: true },
  ])
})

test('fetchEnabledAgentEngineOptions 使用服务端下发的执行引擎列表', async () => {
  const originalFetch = global.fetch
  const requests = []

  global.fetch = async (url) => {
    requests.push(String(url))
    return createJsonResponse({
      agentEngineOptions: [
        { value: 'codex', label: 'Codex', enabled: true, available: true },
        { value: 'opencode', label: 'OpenCode', enabled: true, available: true },
        { value: 'claude-code', label: 'Claude Code', enabled: true, available: false },
      ],
    })
  }

  try {
    const options = await fetchEnabledAgentEngineOptions()

    assert.equal(requests.length, 1)
    assert.match(requests[0], /\/api\/meta$/)
    assert.deepEqual(options, [
      { value: 'codex', label: 'Codex', enabled: true, available: true },
      { value: 'opencode', label: 'OpenCode', enabled: true, available: true },
    ])
  } finally {
    global.fetch = originalFetch
  }
})
