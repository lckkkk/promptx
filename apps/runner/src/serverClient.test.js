import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { getInternalAuthHeaderName, getInternalAuthToken } from './internalAuth.js'
import { createServerClient } from './serverClient.js'

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

test('serverClient attaches internal auth header and posts JSON payload', async () => {
  const { server, baseUrl } = await startJsonServer(async (request, response) => {
    assert.equal(request.headers[getInternalAuthHeaderName()], getInternalAuthToken())

    const chunks = []
    for await (const chunk of request) {
      chunks.push(chunk)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    assert.equal(body.items.length, 1)

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
  })

  try {
    const client = createServerClient({ baseUrl, timeoutMs: 1000 })
    const payload = await client.postEvents([{ id: 1 }], { runnerId: 'runner-1' })
    assert.deepEqual(payload, { ok: true })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('serverClient fails fast on timeout', async () => {
  const { server, baseUrl } = await startJsonServer((_request, response) => {
    setTimeout(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ ok: true }))
    }, 700)
  })

  try {
    const client = createServerClient({ baseUrl, timeoutMs: 500 })
    await assert.rejects(
      () => client.postStatus({ ok: true }),
      (error) => error?.statusCode === 504 && /超时/.test(String(error?.message || ''))
    )
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('serverClient reads system config with internal auth header', async () => {
  const { server, baseUrl } = await startJsonServer((request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.url, '/internal/system-config')
    assert.equal(request.headers[getInternalAuthHeaderName()], getInternalAuthToken())

    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({
      config: {
        runner: {
          maxConcurrentRuns: 4,
        },
      },
    }))
  })

  try {
    const client = createServerClient({ baseUrl, timeoutMs: 1000 })
    const payload = await client.getSystemConfig()
    assert.deepEqual(payload, {
      config: {
        runner: {
          maxConcurrentRuns: 4,
        },
      },
    })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('serverClient defaults to server port 9301', async () => {
  const originalEnv = {
    PROMPTX_SERVER_BASE_URL: process.env.PROMPTX_SERVER_BASE_URL,
    PROMPTX_SERVER_HOST: process.env.PROMPTX_SERVER_HOST,
    PROMPTX_SERVER_PORT: process.env.PROMPTX_SERVER_PORT,
    PORT: process.env.PORT,
  }

  delete process.env.PROMPTX_SERVER_BASE_URL
  delete process.env.PROMPTX_SERVER_HOST
  delete process.env.PROMPTX_SERVER_PORT
  delete process.env.PORT

  try {
    const { createServerClient: createServerClientWithDefaultPort } = await import(`./serverClient.js?test=${Date.now()}`)
    const client = createServerClientWithDefaultPort()
    assert.equal(client.baseUrl, 'http://127.0.0.1:9301')
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
