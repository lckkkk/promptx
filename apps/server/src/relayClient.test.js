import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocketServer } from 'ws'

import { createRelayClient } from './relayClient.js'

async function withRelayServer(run) {
  const server = new WebSocketServer({ port: 0 })

  await new Promise((resolve) => server.once('listening', resolve))
  const { port } = server.address()

  try {
    await run({
      relayWsUrl: `ws://127.0.0.1:${port}`,
      server,
    })
  } finally {
    server.clients.forEach((client) => {
      try {
        client.terminate()
      } catch {
        // ignore
      }
    })
    await new Promise((resolve) => server.close(resolve))
  }
}

function listenJsonMessages(socket, handler) {
  socket.on('message', (payload, isBinary) => {
    if (isBinary) {
      return
    }

    let message = null
    try {
      message = JSON.parse(payload.toString('utf8'))
    } catch {
      return
    }

    handler(message)
  })
}

async function waitFor(check, timeoutMs = 2_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = check()
    if (value) {
      return value
    }
    await delay(20)
  }
  throw new Error('waitFor timeout')
}

function createSilentLogger(logs = []) {
  return {
    info(...args) {
      logs.push(['info', args])
    },
    warn(...args) {
      logs.push(['warn', args])
    },
    error(...args) {
      logs.push(['error', args])
    },
  }
}

test('relay client becomes connected only after hello ack', async () => {
  await withRelayServer(async ({ relayWsUrl, server }) => {
    server.on('connection', (socket) => {
      listenJsonMessages(socket, (message) => {
        if (message?.type === 'hello') {
          socket.send(JSON.stringify({
            type: 'hello.ack',
            ok: true,
            deviceId: message.deviceId,
          }))
        }
      })
    })

    const logs = []
    const client = createRelayClient({
      relayUrl: relayWsUrl.replace(/^ws/, 'http'),
      deviceId: 'my-device',
      deviceToken: 'secret',
      logger: createSilentLogger(logs),
    })

    try {
      client.start()
      await waitFor(() => client.getStatus().connected === true)

      const status = client.getStatus()
      assert.equal(status.connected, true)
      assert.equal(status.lastError, '')
      assert.equal(Boolean(status.lastConnectedAt), true)
      assert.equal(Boolean(status.lastHeartbeatAt), true)
      assert.equal(status.lastCloseReason, '')
      assert.equal(status.pendingRequestCount, 0)
      assert.equal(status.socketReadyState, 1)
      assert.equal(status.recentEvents.some((event) => event.type === 'auth_ok'), true)
      assert.equal(logs.some(([level, args]) => level === 'info' && String(args.at(-1)).includes('连接已就绪')), true)
    } finally {
      client.stop()
    }
  })
})

test('relay client records heartbeat timestamp after server ping', async () => {
  await withRelayServer(async ({ relayWsUrl, server }) => {
    server.on('connection', (socket) => {
      listenJsonMessages(socket, (message) => {
        if (message?.type === 'hello') {
          socket.send(JSON.stringify({
            type: 'hello.ack',
            ok: true,
            deviceId: message.deviceId,
          }))

          setTimeout(() => {
            if (socket.readyState === 1) {
              socket.ping()
            }
          }, 40)
        }
      })
    })

    const client = createRelayClient({
      relayUrl: relayWsUrl.replace(/^ws/, 'http'),
      deviceId: 'my-device',
      deviceToken: 'secret',
      logger: createSilentLogger(),
    })

    try {
      client.start()
      await waitFor(() => client.getStatus().connected === true)
      const initialHeartbeatAt = client.getStatus().lastHeartbeatAt
      await waitFor(() => client.getStatus().lastHeartbeatAt && client.getStatus().lastHeartbeatAt !== initialHeartbeatAt)

      assert.equal(Boolean(client.getStatus().lastHeartbeatAt), true)
    } finally {
      client.stop()
    }
  })
})

test('relay client pauses reconnect after non-retryable reject reason', async () => {
  await withRelayServer(async ({ relayWsUrl, server }) => {
    let connectionCount = 0
    server.on('connection', (socket) => {
      connectionCount += 1
      listenJsonMessages(socket, (message) => {
        if (message?.type === 'hello') {
          socket.close(1008, 'invalid_device')
        }
      })
    })

    const client = createRelayClient({
      relayUrl: relayWsUrl.replace(/^ws/, 'http'),
      deviceId: 'my-device',
      deviceToken: 'secret',
      reconnectDelayStrategy: () => 20,
      logger: createSilentLogger(),
    })

    try {
      client.start()
      await waitFor(() => client.getStatus().lastCloseReason !== '')
      await delay(120)

      const status = client.getStatus()
      assert.equal(status.connected, false)
      assert.equal(status.lastCloseCode, 1008)
      assert.equal(status.lastCloseReason, '设备 ID 不匹配')
      assert.match(status.lastError, /设备 ID 不匹配/)
      assert.equal(status.reconnectPaused, true)
      assert.equal(status.reconnectPausedReason, '设备 ID 不匹配')
      assert.equal(connectionCount, 1)
      assert.equal(status.recentEvents.some((event) => event.type === 'reconnect_paused'), true)
    } finally {
      client.stop()
    }
  })
})

test('relay client resets reconnect count after reconnect succeeds', async () => {
  await withRelayServer(async ({ relayWsUrl, server }) => {
    let connectionCount = 0
    server.on('connection', (socket) => {
      connectionCount += 1
      const currentConnection = connectionCount
      listenJsonMessages(socket, (message) => {
        if (message?.type !== 'hello') {
          return
        }

        socket.send(JSON.stringify({
          type: 'hello.ack',
          ok: true,
          deviceId: message.deviceId,
        }))

        if (currentConnection === 1) {
          setTimeout(() => {
            if (socket.readyState === 1) {
              socket.close(1012, 'server_restart')
            }
          }, 30)
        }
      })
    })

    const client = createRelayClient({
      relayUrl: relayWsUrl.replace(/^ws/, 'http'),
      deviceId: 'my-device',
      deviceToken: 'secret',
      reconnectDelayStrategy: () => 20,
      logger: createSilentLogger(),
    })

    try {
      client.start()
      await waitFor(() => connectionCount >= 2)
      await waitFor(() => client.getStatus().connected === true && client.getStatus().reconnectCount === 0)

      const status = client.getStatus()
      assert.equal(status.connected, true)
      assert.equal(status.reconnectCount, 0)
      assert.equal(status.nextReconnectDelayMs, 0)
      assert.equal(status.reconnectPaused, false)
      assert.equal(status.recentEvents.some((event) => event.type === 'reconnect_scheduled'), true)
    } finally {
      client.stop()
    }
  })
})

test('relay client self-heals when heartbeat becomes stale', async () => {
  await withRelayServer(async ({ relayWsUrl, server }) => {
    let connectionCount = 0
    server.on('connection', (socket) => {
      connectionCount += 1
      const currentConnection = connectionCount
      listenJsonMessages(socket, (message) => {
        if (message?.type !== 'hello') {
          return
        }

        socket.send(JSON.stringify({
          type: 'hello.ack',
          ok: true,
          deviceId: message.deviceId,
        }))

        if (currentConnection >= 2) {
          setTimeout(() => {
            if (socket.readyState === 1) {
              socket.ping()
            }
          }, 20)
        }
      })
    })

    const client = createRelayClient({
      relayUrl: relayWsUrl.replace(/^ws/, 'http'),
      deviceId: 'my-device',
      deviceToken: 'secret',
      reconnectDelayStrategy: () => 20,
      healthCheckIntervalMs: 20,
      heartbeatTimeoutMs: 60,
      logger: createSilentLogger(),
    })

    try {
      client.start()
      await waitFor(() => connectionCount >= 2, 3_000)
      await waitFor(() => client.getStatus().connected === true)

      const status = client.getStatus()
      assert.equal(status.connected, true)
      assert.equal(connectionCount >= 2, true)
      assert.equal(status.recentEvents.some((event) => event.type === 'heartbeat_stale'), true)
      assert.equal(status.recentEvents.some((event) => event.type === 'reconnect_requested' && event.source === 'heartbeat_timeout'), true)
    } finally {
      client.stop()
    }
  })
})

test('relay client detects resume-like clock jump and reconnects', async () => {
  await withRelayServer(async ({ relayWsUrl, server }) => {
    let connectionCount = 0
    let fakeNow = Date.now()

    server.on('connection', (socket) => {
      connectionCount += 1
      const currentConnection = connectionCount
      listenJsonMessages(socket, (message) => {
        if (message?.type !== 'hello') {
          return
        }

        socket.send(JSON.stringify({
          type: 'hello.ack',
          ok: true,
          deviceId: message.deviceId,
        }))

        if (currentConnection >= 2) {
          setTimeout(() => {
            if (socket.readyState === 1) {
              socket.ping()
            }
          }, 20)
        }
      })
    })

    const client = createRelayClient({
      relayUrl: relayWsUrl.replace(/^ws/, 'http'),
      deviceId: 'my-device',
      deviceToken: 'secret',
      reconnectDelayStrategy: () => 20,
      healthCheckIntervalMs: 20,
      heartbeatTimeoutMs: 60,
      sleepResumeThresholdMs: 40,
      getNow: () => fakeNow,
      logger: createSilentLogger(),
    })

    try {
      client.start()
      await waitFor(() => client.getStatus().connected === true)

      fakeNow += 500

      await waitFor(() => connectionCount >= 2, 3_000)
      await waitFor(() => client.getStatus().connected === true)

      const status = client.getStatus()
      assert.equal(status.connected, true)
      assert.equal(status.recentEvents.some((event) => event.type === 'system_resume_detected'), true)
      assert.equal(status.recentEvents.some((event) => event.type === 'reconnect_requested' && event.source === 'heartbeat_timeout'), true)
    } finally {
      client.stop()
    }
  })
})

test('relay client supports manual reconnect', async () => {
  await withRelayServer(async ({ relayWsUrl, server }) => {
    let connectionCount = 0
    server.on('connection', (socket) => {
      connectionCount += 1
      listenJsonMessages(socket, (message) => {
        if (message?.type === 'hello') {
          socket.send(JSON.stringify({
            type: 'hello.ack',
            ok: true,
            deviceId: message.deviceId,
          }))
        }
      })
    })

    const client = createRelayClient({
      relayUrl: relayWsUrl.replace(/^ws/, 'http'),
      deviceId: 'my-device',
      deviceToken: 'secret',
      reconnectDelayStrategy: () => 20,
      logger: createSilentLogger(),
    })

    try {
      client.start()
      await waitFor(() => client.getStatus().connected === true)

      const reconnectResult = client.reconnect()
      assert.equal(reconnectResult, true)

      await waitFor(() => connectionCount >= 2, 3_000)
      await waitFor(() => client.getStatus().connected === true)

      const status = client.getStatus()
      assert.equal(status.connected, true)
      assert.equal(status.recentEvents.some((event) => event.type === 'reconnect_requested' && event.source === 'manual'), true)
    } finally {
      client.stop()
    }
  })
})
