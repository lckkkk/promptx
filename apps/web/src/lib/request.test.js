import assert from 'node:assert/strict'
import test from 'node:test'

test('request defaults to localhost:9301 when window is unavailable', async () => {
  const originalWindow = globalThis.window
  delete globalThis.window

  try {
    const module = await import(`./request.js?test=${Date.now()}-server-default`)
    assert.equal(module.getApiBase(), 'http://localhost:9301')
  } finally {
    globalThis.window = originalWindow
  }
})

test('request points vite dev pages at server port 9302 by default', async () => {
  const originalWindow = globalThis.window
  globalThis.window = {
    location: {
      origin: 'http://127.0.0.1:5174',
    },
  }

  try {
    const module = await import(`./request.js?test=${Date.now()}-vite-default`)
    assert.equal(module.getApiBase(), 'http://127.0.0.1:9302')
  } finally {
    globalThis.window = originalWindow
  }
})
