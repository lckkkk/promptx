import { execFileSync } from 'node:child_process'

const DEFAULT_FORCE_STOP_GRACE_MS = Math.max(200, Number(process.env.PROMPTX_FORCE_STOP_GRACE_MS) || 1500)

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

function terminateUnixProcessTree(child, signal = 'SIGTERM') {
  const pid = Number(child?.pid || 0)
  if (!pid) {
    return false
  }

  const targets = child.detached
    ? [-pid, pid]
    : [pid]

  for (const target of targets) {
    try {
      process.kill(target, signal)
      return true
    } catch {
      // Continue trying fallbacks.
    }
  }

  return false
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
