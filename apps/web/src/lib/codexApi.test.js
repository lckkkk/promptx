import test from 'node:test'
import assert from 'node:assert/strict'

import { listTaskCodexRuns } from './codexApi.js'

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

test('listTaskCodexRuns 使用 events 查询语义，并兼容旧布尔参数', async () => {
  const originalFetch = global.fetch
  const requests = []

  global.fetch = async (url) => {
    requests.push(String(url))
    return createJsonResponse({ items: [] })
  }

  try {
    await listTaskCodexRuns('task-1', {
      limit: 10,
      events: 'latest',
    })

    await listTaskCodexRuns('task-1', {
      includeEvents: true,
    })

    await listTaskCodexRuns('task-1', {
      includeLatestEvents: true,
    })

    assert.equal(requests.length, 3)
    assert.match(requests[0], /\/api\/tasks\/task-1\/codex-runs\?limit=10&events=latest$/)
    assert.match(requests[1], /\/api\/tasks\/task-1\/codex-runs\?limit=20&events=all$/)
    assert.match(requests[2], /\/api\/tasks\/task-1\/codex-runs\?limit=20&events=latest$/)
  } finally {
    global.fetch = originalFetch
  }
})
