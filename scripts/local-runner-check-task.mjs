import assert from 'node:assert/strict'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)

function readFlag(flagName, fallback = '') {
  const flagIndex = argv.findIndex((item) => item === flagName || item.startsWith(`${flagName}=`))
  if (flagIndex < 0) {
    return fallback
  }
  const rawValue = argv[flagIndex]
  if (rawValue.includes('=')) {
    return rawValue.split('=').slice(1).join('=')
  }
  return argv[flagIndex + 1] || fallback
}

function printUsage() {
  console.log([
    '用法：',
    '  node scripts/local-runner-check-task.mjs install [--profile nightly] [--time 02:30] [--task-name "PromptX Runner Check"]',
    '  node scripts/local-runner-check-task.mjs remove [--task-name "PromptX Runner Check"]',
  ].join('\n'))
}

function buildTaskCommand(profile) {
  const normalizedProfile = profile === 'nightly' ? 'nightly' : 'quick'
  const repoRoot = process.cwd()
  const scriptName = normalizedProfile === 'nightly'
    ? 'pnpm local:runner-check:nightly'
    : 'pnpm local:runner-check'

  return `cmd /d /c "cd /d ${repoRoot} && ${scriptName}"`
}

function installTask() {
  assert.equal(process.platform, 'win32', '本机定时巡检安装器当前仅支持 Windows')

  const profile = String(readFlag('--profile', 'nightly')).trim().toLowerCase() === 'nightly' ? 'nightly' : 'quick'
  const time = String(readFlag('--time', profile === 'nightly' ? '02:30' : '09:30')).trim() || '02:30'
  const taskName = String(
    readFlag('--task-name', profile === 'nightly' ? 'PromptX Runner Check Nightly' : 'PromptX Runner Check Quick')
  ).trim()

  execFileSync('schtasks.exe', [
    '/Create',
    '/SC', 'DAILY',
    '/TN', taskName,
    '/TR', buildTaskCommand(profile),
    '/ST', time,
    '/F',
  ], {
    stdio: 'inherit',
    windowsHide: true,
  })

  console.log(`已安装本机定时巡检任务：${taskName}`)
}

function removeTask() {
  assert.equal(process.platform, 'win32', '本机定时巡检卸载器当前仅支持 Windows')

  const taskName = String(readFlag('--task-name', 'PromptX Runner Check Nightly')).trim()
  execFileSync('schtasks.exe', [
    '/Delete',
    '/TN', taskName,
    '/F',
  ], {
    stdio: 'inherit',
    windowsHide: true,
  })

  console.log(`已删除本机定时巡检任务：${taskName}`)
}

function main() {
  const action = String(argv[0] || '').trim().toLowerCase()
  if (!action || action === '--help' || action === '-h') {
    printUsage()
    return
  }

  if (action === 'install') {
    installTask()
    return
  }

  if (action === 'remove') {
    removeTask()
    return
  }

  throw new Error(`未知操作：${action}`)
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
