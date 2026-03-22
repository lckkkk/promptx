import { execFileSync } from 'node:child_process'

const DEFAULT_FORCE_STOP_GRACE_MS = Math.max(200, Number(process.env.PROMPTX_FORCE_STOP_GRACE_MS) || 1500)

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
