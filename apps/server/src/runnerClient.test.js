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
