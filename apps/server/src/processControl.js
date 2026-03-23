import { execFileSync } from 'node:child_process'

const DEFAULT_FORCE_STOP_GRACE_MS = Math.max(200, Number(process.env.PROMPTX_FORCE_STOP_GRACE_MS) || 1500)
let currentUnixProcessGroupId = null

export function createManagedSpawnOptions(options = {}) {
  const nextOptions = {
    env: process.env,
    windowsHide: true,
    ...options,
  }

  const normalizedCwd = String(options.cwd || '').trim()
  if (normalizedCwd) {
    nextOptions.cwd = normalizedCwd
  } else {
    delete nextOptions.cwd
  }

  if (process.platform !== 'win32') {
    nextOptions.detached = true
  }

  return nextOptions
}

function isChildProcessAlive(child) {
  if (!child?.pid) {
    return false
  }

  if (child.exitCode !== null || child.signalCode !== null) {
    return false
  }

  try {
    process.kill(child.pid, 0)
    return true
  } catch {
    return false
  }
}

function terminateWindowsProcessTree(pid, force = false) {
  execFileSync(
    'taskkill.exe',
    ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])],
    {
      stdio: 'ignore',
      windowsHide: true,
    }
  )
}

function getCurrentUnixProcessGroupId() {
  if (currentUnixProcessGroupId !== null) {
    return currentUnixProcessGroupId
  }

  try {
    const output = execFileSync(
      'ps',
      ['-o', 'pgid=', '-p', String(process.pid)],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim()
    currentUnixProcessGroupId = Number(output) || 0
  } catch {
    currentUnixProcessGroupId = 0
  }

  return currentUnixProcessGroupId
}

function readUnixProcessTable() {
  try {
    const output = execFileSync(
      'ps',
      ['-axo', 'pid=,ppid=,pgid='],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    )

    return output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pidText = '', ppidText = '', pgidText = ''] = line.split(/\s+/g)
        return {
          pid: Number(pidText) || 0,
          ppid: Number(ppidText) || 0,
          pgid: Number(pgidText) || 0,
        }
      })
      .filter((entry) => entry.pid > 0)
  } catch {
    return []
  }
}

function collectUnixDescendantProcesses(rootPid = 0) {
  const normalizedRootPid = Number(rootPid) || 0
  if (!normalizedRootPid) {
    return []
  }

  const processTable = readUnixProcessTable()
  const childrenByParentPid = new Map()
  processTable.forEach((entry) => {
    if (!childrenByParentPid.has(entry.ppid)) {
      childrenByParentPid.set(entry.ppid, [])
    }
    childrenByParentPid.get(entry.ppid).push(entry)
  })

  const descendants = []
  const queue = [...(childrenByParentPid.get(normalizedRootPid) || [])]
  const seenPids = new Set()

  while (queue.length) {
    const entry = queue.shift()
    if (!entry || seenPids.has(entry.pid)) {
      continue
    }

    seenPids.add(entry.pid)
    descendants.push(entry)
    const children = childrenByParentPid.get(entry.pid) || []
    children.forEach((childEntry) => {
      if (!seenPids.has(childEntry.pid)) {
        queue.push(childEntry)
      }
    })
  }

  return descendants
}

function terminateUnixProcessTree(child, signal = 'SIGTERM') {
  const pid = Number(child?.pid || 0)
  if (!pid) {
    return false
  }

  const currentPgid = getCurrentUnixProcessGroupId()
  const descendants = collectUnixDescendantProcesses(pid)
  const targetProcessGroupIds = new Set()

  if (child.detached && pid !== currentPgid) {
    targetProcessGroupIds.add(pid)
  }

  descendants.forEach((entry) => {
    if (entry.pgid > 0 && entry.pgid !== currentPgid) {
      targetProcessGroupIds.add(entry.pgid)
    }
  })

  let terminated = false

  ;[...targetProcessGroupIds].forEach((pgid) => {
    try {
      process.kill(-pgid, signal)
      terminated = true
    } catch {
      // Continue trying descendant pid fallbacks.
    }
  })

  const targetPids = [
    ...descendants.map((entry) => entry.pid).sort((left, right) => right - left),
    pid,
  ]

  for (const targetPid of targetPids) {
    try {
      process.kill(targetPid, signal)
      terminated = true
    } catch {
      // Continue trying fallbacks.
    }
  }

  return terminated
}

export function forceStopChildProcess(child, options = {}) {
  if (!child?.pid) {
    return false
  }

  if (child.__promptxForceStopping) {
    return true
  }

  child.__promptxForceStopping = true

  const graceMs = Math.max(0, Number(options.graceMs) || DEFAULT_FORCE_STOP_GRACE_MS)
  let forceKillTimer = null

  const clearForceKillTimer = () => {
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
  }

  child.once('close', clearForceKillTimer)
  child.once('exit', clearForceKillTimer)

  if (process.platform === 'win32') {
    try {
      terminateWindowsProcessTree(child.pid, false)
    } catch {
      // Ignore and fall back to forced kill below.
    }

    forceKillTimer = setTimeout(() => {
      if (!isChildProcessAlive(child)) {
        return
      }

      try {
        terminateWindowsProcessTree(child.pid, true)
      } catch {
        // Ignore final kill failures.
      }
    }, graceMs)
    forceKillTimer.unref?.()

    return true
  }

  const terminated = terminateUnixProcessTree(child, 'SIGTERM')
  if (!terminated) {
    try {
      child.kill('SIGTERM')
    } catch {
      // Ignore and rely on the forced kill timer below.
    }
  }

  forceKillTimer = setTimeout(() => {
    if (!isChildProcessAlive(child)) {
      return
    }

    const killed = terminateUnixProcessTree(child, 'SIGKILL')
    if (!killed) {
      try {
        child.kill('SIGKILL')
      } catch {
        // Ignore final kill failures.
      }
    }
  }, graceMs)
  forceKillTimer.unref?.()

  return true
}
