import { execFileSync } from 'node:child_process'

const DEFAULT_FORCE_STOP_GRACE_MS = Math.max(200, Number(process.env.PROMPTX_FORCE_STOP_GRACE_MS) || 1500)
let currentUnixProcessGroupId = null

function nowIso() {
  return new Date().toISOString()
}

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

function ensureChildStopState(child) {
  if (!child || typeof child !== 'object') {
    return null
  }

  if (!child.__promptxStopControl) {
    child.__promptxStopControl = {
      requestedAt: '',
      gracefulSignalAt: '',
      gracefulMethod: '',
      forceKillScheduledAt: '',
      forceKillAttemptedAt: '',
      forceKillMethod: '',
      exitObservedAt: '',
      exitCode: null,
      signalCode: '',
      lastKnownAlive: false,
      cancelErrorMessage: '',
    }

    const rememberExit = (exitCode = null, signalCode = '') => {
      child.__promptxStopControl.exitObservedAt = child.__promptxStopControl.exitObservedAt || nowIso()
      child.__promptxStopControl.exitCode = exitCode
      child.__promptxStopControl.signalCode = String(signalCode || '').trim()
      child.__promptxStopControl.lastKnownAlive = false
    }

    child.once?.('exit', rememberExit)
    child.once?.('close', () => {
      rememberExit(child.exitCode ?? null, child.signalCode ?? '')
    })
  }

  child.__promptxStopControl.lastKnownAlive = isChildProcessAlive(child)
  return child.__promptxStopControl
}

export function getChildStopDiagnostics(child) {
  const state = ensureChildStopState(child)
  if (!state) {
    return {
      requestedAt: '',
      gracefulSignalAt: '',
      gracefulMethod: '',
      forceKillScheduledAt: '',
      forceKillAttemptedAt: '',
      forceKillMethod: '',
      exitObservedAt: '',
      exitCode: null,
      signalCode: '',
      lastKnownAlive: false,
      cancelErrorMessage: '',
    }
  }

  return {
    requestedAt: state.requestedAt || '',
    gracefulSignalAt: state.gracefulSignalAt || '',
    gracefulMethod: state.gracefulMethod || '',
    forceKillScheduledAt: state.forceKillScheduledAt || '',
    forceKillAttemptedAt: state.forceKillAttemptedAt || '',
    forceKillMethod: state.forceKillMethod || '',
    exitObservedAt: state.exitObservedAt || '',
    exitCode: state.exitCode ?? null,
    signalCode: state.signalCode || '',
    lastKnownAlive: Boolean(state.lastKnownAlive),
    cancelErrorMessage: state.cancelErrorMessage || '',
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

  const stopState = ensureChildStopState(child)
  if (child.__promptxForceStopping) {
    return true
  }

  child.__promptxForceStopping = true

  const graceMs = Math.max(0, Number(options.graceMs) || DEFAULT_FORCE_STOP_GRACE_MS)
  let forceKillTimer = null

  if (stopState) {
    stopState.requestedAt = stopState.requestedAt || nowIso()
    stopState.gracefulSignalAt = nowIso()
    stopState.forceKillScheduledAt = new Date(Date.now() + graceMs).toISOString()
    stopState.lastKnownAlive = isChildProcessAlive(child)
  }

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
      if (stopState) {
        stopState.gracefulMethod = 'taskkill_tree'
      }
      terminateWindowsProcessTree(child.pid, false)
    } catch (error) {
      if (stopState) {
        stopState.cancelErrorMessage = String(error?.message || error || '').trim()
      }
      // Ignore and fall back to forced kill below.
    }

    forceKillTimer = setTimeout(() => {
      if (!isChildProcessAlive(child)) {
        if (stopState) {
          stopState.lastKnownAlive = false
        }
        return
      }

      try {
        if (stopState) {
          stopState.forceKillAttemptedAt = nowIso()
          stopState.forceKillMethod = 'taskkill_tree_force'
          stopState.lastKnownAlive = true
        }
        terminateWindowsProcessTree(child.pid, true)
      } catch (error) {
        if (stopState) {
          stopState.cancelErrorMessage = String(error?.message || error || '').trim()
        }
        // Ignore final kill failures.
      }
    }, graceMs)
    forceKillTimer.unref?.()

    return true
  }

  const terminated = terminateUnixProcessTree(child, 'SIGTERM')
  if (stopState) {
    stopState.gracefulMethod = terminated ? 'process_group_sigterm' : 'child_sigterm'
  }
  if (!terminated) {
    try {
      child.kill('SIGTERM')
    } catch (error) {
      if (stopState) {
        stopState.cancelErrorMessage = String(error?.message || error || '').trim()
      }
      // Ignore and rely on the forced kill timer below.
    }
  }

  forceKillTimer = setTimeout(() => {
    if (!isChildProcessAlive(child)) {
      if (stopState) {
        stopState.lastKnownAlive = false
      }
      return
    }

    if (stopState) {
      stopState.forceKillAttemptedAt = nowIso()
      stopState.forceKillMethod = 'process_group_sigkill'
      stopState.lastKnownAlive = true
    }
    const killed = terminateUnixProcessTree(child, 'SIGKILL')
    if (!killed) {
      try {
        if (stopState) {
          stopState.forceKillMethod = 'child_sigkill'
        }
        child.kill('SIGKILL')
      } catch (error) {
        if (stopState) {
          stopState.cancelErrorMessage = String(error?.message || error || '').trim()
        }
        // Ignore final kill failures.
      }
    }
  }, graceMs)
  forceKillTimer.unref?.()

  return true
}
