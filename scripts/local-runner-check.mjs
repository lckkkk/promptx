import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'

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

function normalizeProfile(value = '') {
  const profile = String(value || process.env.PROMPTX_LOCAL_CHECK_PROFILE || 'quick').trim().toLowerCase()
  return profile === 'nightly' ? 'nightly' : 'quick'
}

function nowMs() {
  return performance.now()
}

function trimTail(text = '', maxLength = 6000) {
  const value = String(text || '')
  if (value.length <= maxLength) {
    return value
  }
  return value.slice(value.length - maxLength)
}

function createReportDir(profile) {
  const requested = String(readFlag('--report-dir', process.env.PROMPTX_LOCAL_CHECK_REPORT_DIR || '')).trim()
  if (requested) {
    fs.mkdirSync(requested, { recursive: true })
    return requested
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(process.cwd(), 'apps', 'server', 'tmp', 'runner-checks', `${stamp}-${profile}`)
  fs.mkdirSync(target, { recursive: true })
  return target
}

function createSteps(profile, reportDir) {
  const steps = [
    {
      name: 'server-test',
      command: 'pnpm',
      args: ['--filter', '@promptx/server', 'test'],
      env: {},
    },
    {
      name: 'real-stop',
      command: 'pnpm',
      args: ['e2e:real-stop'],
      env: {},
    },
  ]

  if (profile === 'nightly') {
    steps.splice(1, 0, {
      name: 'real-agents',
      command: 'pnpm',
      args: ['e2e:real-agents'],
      env: {},
    })
  }

  steps.push({
    name: 'perf-runner-split',
    command: 'pnpm',
    args: ['perf:runner-split'],
    env: {
      PROMPTX_PERF_PROFILE: profile === 'nightly' ? 'nightly' : 'default',
      PROMPTX_PERF_REPORT_PATH: path.join(reportDir, `perf-${profile}.json`),
    },
  })

  return steps
}

async function runStep(step, index, reportDir) {
  const prefix = `${String(index + 1).padStart(2, '0')}-${step.name}`
  const stdoutPath = path.join(reportDir, `${prefix}.stdout.log`)
  const stderrPath = path.join(reportDir, `${prefix}.stderr.log`)
  const startedAt = new Date().toISOString()
  const startedMs = nowMs()

  return new Promise((resolve) => {
    const stdoutChunks = []
    const stderrChunks = []
    const child = spawn(step.command, step.args, {
      cwd: process.cwd(),
      windowsHide: true,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ...step.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      stdoutChunks.push(text)
      process.stdout.write(text)
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderrChunks.push(text)
      process.stderr.write(text)
    })

    child.on('close', (code, signal) => {
      const stdout = stdoutChunks.join('')
      const stderr = stderrChunks.join('')
      fs.mkdirSync(reportDir, { recursive: true })
      fs.writeFileSync(stdoutPath, stdout)
      fs.writeFileSync(stderrPath, stderr)

      resolve({
        name: step.name,
        command: [step.command, ...step.args].join(' '),
        startedAt,
        finishedAt: new Date().toISOString(),
        durationMs: nowMs() - startedMs,
        status: code === 0 ? 'passed' : 'failed',
        exitCode: code ?? null,
        signal: signal || '',
        stdoutPath,
        stderrPath,
        stdoutTail: code === 0 ? '' : trimTail(stdout),
        stderrTail: code === 0 ? '' : trimTail(stderr),
      })
    })
  })
}

async function main() {
  const profile = normalizeProfile(readFlag('--profile'))
  const reportDir = createReportDir(profile)
  const steps = createSteps(profile, reportDir)
  const results = []

  console.log(`本机巡检启动：profile=${profile}`)
  console.log(`报告目录：${reportDir}`)

  for (let index = 0; index < steps.length; index += 1) {
    const result = await runStep(steps[index], index, reportDir)
    results.push(result)

    if (result.status !== 'passed') {
      break
    }
  }

  const summary = {
    profile,
    reportDir,
    startedAt: results[0]?.startedAt || new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    steps: results,
  }

  const summaryPath = path.join(reportDir, 'summary.json')
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary, null, 2))

  const failed = results.find((item) => item.status !== 'passed')
  assert.ok(!failed, `${failed?.name || 'local-runner-check'} failed，报告见 ${summaryPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
