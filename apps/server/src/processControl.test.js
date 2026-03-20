import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import test from 'node:test'

import { createManagedSpawnOptions, forceStopChildProcess } from './processControl.js'

test('forceStopChildProcess 会在宽限时间后结束忽略 SIGTERM 的子进程', async () => {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
    createManagedSpawnOptions({
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  )

  await new Promise((resolve) => {
    child.once('spawn', resolve)
  })

  assert.equal(typeof child.pid, 'number')
  forceStopChildProcess(child, { graceMs: 100 })

  const closeResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('等待子进程退出超时'))
    }, 5000)

    child.once('close', (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal })
    })
  })

  assert.ok(closeResult.signal || closeResult.code !== null)
})
