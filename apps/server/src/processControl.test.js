import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createManagedSpawnOptions, forceStopChildProcess } from './processControl.js'

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check, timeoutMs, errorMessage) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }

  throw new Error(errorMessage)
}

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

test('forceStopChildProcess 会结束脱离原进程组的后代进程', {
  skip: process.platform === 'win32',
}, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-process-tree-'))
  const detachedPidFile = path.join(fixtureDir, 'detached.pid')
  const detachedExitFile = path.join(fixtureDir, 'detached.exit.json')
  let detachedPid = 0
  const detachedScript = [
    "const fs = require('node:fs')",
    `const detachedExitFile = ${JSON.stringify(detachedExitFile)}`,
    "process.on('SIGTERM', () => {",
    "  fs.writeFileSync(detachedExitFile, JSON.stringify({ reason: 'sigterm' }))",
    "  process.exit(0)",
    "})",
    "setInterval(() => {}, 1000)",
  ].join('\n')

  const parentScript = [
    "const fs = require('node:fs')",
    "const { spawn } = require('node:child_process')",
    `const detachedPidFile = ${JSON.stringify(detachedPidFile)}`,
    `const detachedScript = ${JSON.stringify(detachedScript)}`,
    "const detachedChild = spawn(process.execPath, ['-e', detachedScript], {",
    "  detached: true,",
    "  stdio: 'ignore',",
    "})",
    "fs.writeFileSync(detachedPidFile, String(detachedChild.pid))",
    "detachedChild.unref()",
    "process.on('SIGTERM', () => {})",
    "setInterval(() => {}, 1000)",
  ].join('\n')

  const child = spawn(
    process.execPath,
    ['-e', parentScript],
    createManagedSpawnOptions({
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  )

  try {
    await new Promise((resolve) => {
      child.once('spawn', resolve)
    })

    await waitFor(() => fs.existsSync(detachedPidFile), 5000, '等待 detached.pid 超时')
    detachedPid = Number(fs.readFileSync(detachedPidFile, 'utf8').trim()) || 0
    assert.ok(detachedPid > 0)
    assert.equal(isProcessAlive(detachedPid), true)

    forceStopChildProcess(child, { graceMs: 100 })

    const closeResult = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('等待父进程退出超时'))
      }, 5000)

      child.once('close', (code, signal) => {
        clearTimeout(timeout)
        resolve({ code, signal })
      })
    })

    assert.ok(closeResult.signal || closeResult.code !== null)

    await waitFor(() => !isProcessAlive(detachedPid), 5000, '等待后代进程退出超时')
    await waitFor(() => fs.existsSync(detachedExitFile), 5000, '等待后代进程退出标记超时')

    const exitPayload = JSON.parse(fs.readFileSync(detachedExitFile, 'utf8'))
    assert.equal(exitPayload.reason, 'sigterm')
  } finally {
    if (detachedPid > 0 && isProcessAlive(detachedPid)) {
      try {
        process.kill(-detachedPid, 'SIGKILL')
      } catch {
        // Ignore cleanup failures for already-exited processes.
      }
      try {
        process.kill(detachedPid, 'SIGKILL')
      } catch {
        // Ignore cleanup failures for already-exited processes.
      }
    }

    fs.rmSync(fixtureDir, { recursive: true, force: true })
  }
})
