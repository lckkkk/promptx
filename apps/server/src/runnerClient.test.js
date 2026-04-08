import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { getInternalAuthHeaderName, getInternalAuthToken } from './internalAuth.js'
import { createRunnerClient } from './runnerClient.js'

function startJsonServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${address.port}`,
      })
    })
  })
}

test('runnerClient attaches internal auth header and parses JSON response', async () => {
  const { server, baseUrl } = await startJsonServer((request, response) => {
    assert.equal(request.headers[getInternalAuthHeaderName()], getInternalAuthToken())
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })

  try {
    const client = createRunnerClient({ baseUrl, timeoutMs: 1000 })
    const payload = await client.getDiagnostics()
    assert.deepEqual(payload, { ok: true })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('runnerClient fails fast on timeout', async () => {
  const { server, baseUrl } = await startJsonServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    }, 700)
  })

  try {
    const client = createRunnerClient({ baseUrl, timeoutMs: 500 })
    await assert.rejects(
      () => client.getDiagnostics(),
      (error) => error?.statusCode === 504 && /超时/.test(String(error?.message || ''))
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('runnerClient updates runner config with internal auth header', async () => {
  const { server, baseUrl } = await startJsonServer(async (request, response) => {
    assert.equal(request.method, 'PUT')
    assert.equal(request.url, '/internal/config')
    assert.equal(request.headers[getInternalAuthHeaderName()], getInternalAuthToken())

    const chunks = []
    for await (const chunk of request) {
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(body.maxConcurrentRuns, 3)

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, config: { maxConcurrentRuns: 3 } }))
  })

  try {
    const client = createRunnerClient({ baseUrl, timeoutMs: 1000 })
    const payload = await client.updateConfig({ maxConcurrentRuns: 3 })
    assert.deepEqual(payload, { ok: true, config: { maxConcurrentRuns: 3 } })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('runnerClient defaults to runner port 9303', () => {
  const originalEnv = {
    PROMPTX_RUNNER_BASE_URL: process.env.PROMPTX_RUNNER_BASE_URL,
    PROMPTX_RUNNER_HOST: process.env.PROMPTX_RUNNER_HOST,
    RUNNER_HOST: process.env.RUNNER_HOST,
    PROMPTX_RUNNER_PORT: process.env.PROMPTX_RUNNER_PORT,
    RUNNER_PORT: process.env.RUNNER_PORT,
  }

  delete process.env.PROMPTX_RUNNER_BASE_URL
  delete process.env.PROMPTX_RUNNER_HOST
  delete process.env.RUNNER_HOST
  delete process.env.PROMPTX_RUNNER_PORT
  delete process.env.RUNNER_PORT

  try {
    const client = createRunnerClient()
    assert.equal(client.baseUrl, 'http://127.0.0.1:9303')
  } finally {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (typeof value === 'undefined') {
        delete process.env[key]
        return
      }
      process.env[key] = value
    })
  }
})
