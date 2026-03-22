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
