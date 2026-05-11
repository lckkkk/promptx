import assert from 'node:assert/strict'
import test from 'node:test'

import { createSpawnInvocation } from './local-update.mjs'

test('createSpawnInvocation 在 Windows 下用 cmd.exe 包装命令名', () => {
  const invocation = createSpawnInvocation('corepack', ['pnpm', '-r', 'build'], 'win32', 'C:\\Windows\\System32\\cmd.exe')

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'corepack pnpm -r build'])
})

test('createSpawnInvocation 在非 Windows 或非批处理命令下保持原样', () => {
  const invocation = createSpawnInvocation('/usr/bin/npm', ['run', 'build'], 'linux')

  assert.equal(invocation.command, '/usr/bin/npm')
  assert.deepEqual(invocation.args, ['run', 'build'])
})

test('createSpawnInvocation 在 Windows 下对批处理路径退化为文件名执行', () => {
  const invocation = createSpawnInvocation('C:\\Program Files\\nodejs\\npm.cmd', ['install', '-g', '.', '--force'], 'win32', 'C:\\Windows\\System32\\cmd.exe')

  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe')
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'npm.cmd install -g . --force'])
})
