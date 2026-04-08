import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

function readSource(relativePath) {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8')
}

test('service script defaults to ports 9301 and 9303', () => {
  const source = readSource('scripts/service.mjs')
  assert.match(source, /const DEFAULT_SERVER_PORT = 9301/)
  assert.match(source, /const DEFAULT_RUNNER_PORT = 9303/)
})

test('dev script defaults to ports 9302 and 9303', () => {
  const source = readSource('scripts/dev.mjs')
  assert.match(source, /const DEFAULT_SERVER_PORT = 9302/)
  assert.match(source, /const DEFAULT_RUNNER_PORT = 9303/)
})

test('dev tailscale script defaults to server port 9302', () => {
  const source = readSource('scripts/dev-tailscale.mjs')
  assert.match(source, /const DEFAULT_SERVER_PORT = 9302/)
})
