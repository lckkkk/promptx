import { execFileSync, spawn } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'

const DEFAULT_SERVER_PORT = 3001
const DEFAULT_WEB_PORT = 5174
const DEFAULT_HOST = '127.0.0.1'

function resolvePnpmCommand() {
  if (process.platform !== 'win32') {
    return 'pnpm'
  }

  try {
    const output = execFileSync('where.exe', ['pnpm'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return 'pnpm'
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || 'pnpm'
  } catch {
    return 'pnpm'
  }
}

function spawnChild(command, args, env = {}) {
  const isWindowsShellScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path.basename(command))
  const spawnCommand = isWindowsShellScript ? (process.env.ComSpec || 'cmd.exe') : command
  const spawnArgs = isWindowsShellScript ? ['/d', '/s', '/c', command, ...args] : args

  return spawn(spawnCommand, spawnArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ...env,
    },
    shell: false,
  })
}

function killChild(child) {
  if (!child || child.killed) {
    return
  }

  if (process.platform === 'win32') {
    child.kill()
    return
  }

  child.kill('SIGTERM')
}

async function main() {
  const host = String(process.env.HOST || process.env.PROMPTX_DEV_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
  const serverPort = Math.max(
    1,
    Number(process.env.PORT || process.env.PROMPTX_SERVER_PORT) || DEFAULT_SERVER_PORT
  )
  const webPort = Math.max(
    1,
    Number(process.env.WEB_PORT || process.env.PROMPTX_WEB_PORT) || DEFAULT_WEB_PORT
  )

  console.log(`[promptx-dev] Web:    http://${host}:${webPort}`)
  console.log(`[promptx-dev] Server: http://${host}:${serverPort}`)
  console.log('[promptx-dev] 按 Ctrl+C 可同时停止前后端。')

  const pnpmCommand = resolvePnpmCommand()
  const serverProcess = spawnChild(
    pnpmCommand,
    ['--filter', '@promptx/server', 'dev'],
    {
      HOST: host,
      PORT: String(serverPort),
      PROMPTX_SERVER_PORT: String(serverPort),
    }
  )

  const webProcess = spawnChild(
    pnpmCommand,
    ['--filter', '@promptx/web', 'exec', 'vite', '--host', host, '--port', String(webPort)],
    {
      VITE_API_PORT: String(serverPort),
      PROMPTX_SERVER_PORT: String(serverPort),
      PROMPTX_WEB_PORT: String(webPort),
    }
  )

  const children = [serverProcess, webProcess]
  let shuttingDown = false

  const shutdown = (code = 0) => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    children.forEach(killChild)
    setTimeout(() => {
      process.exit(code)
    }, 100)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  serverProcess.on('exit', (code, signal) => {
    if (shuttingDown) {
      return
    }
    console.error(`[promptx-dev] 后端已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(Number(code) || 1)
  })

  webProcess.on('exit', (code, signal) => {
    if (shuttingDown) {
      return
    }
    console.error(`[promptx-dev] 前端已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(Number(code) || 1)
  })
}

main().catch((error) => {
  console.error(`[promptx-dev] ${error.message || error}`)
  process.exitCode = 1
})
