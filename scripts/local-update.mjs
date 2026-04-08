import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'

import { resolvePromptxPaths } from '../apps/server/src/appPaths.js'
import { all } from '../apps/server/src/db.js'
import { TASK_NOTIFICATION_CHANNELS, TASK_NOTIFICATION_LOCALES, normalizeTaskNotificationLocale } from '../packages/shared/src/index.js'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serviceScriptPath = path.join(rootDir, 'scripts', 'service.mjs')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const ACTIVE_RUN_STATUSES = ['queued', 'starting', 'running', 'stopping']
const RESTART_WAIT_INTERVAL_MS = Math.max(2000, Number(process.env.PROMPTX_LOCAL_UPDATE_WAIT_INTERVAL_MS) || 5000)
const RESTART_WAIT_TIMEOUT_MS = Math.max(RESTART_WAIT_INTERVAL_MS, Number(process.env.PROMPTX_LOCAL_UPDATE_WAIT_TIMEOUT_MS) || 6 * 60 * 60 * 1000)
const RESTART_RESULT_WAIT_MS = Math.max(3000, Number(process.env.PROMPTX_LOCAL_UPDATE_RESULT_WAIT_MS) || 30_000)
const LOCAL_UPDATE_NOTIFICATION_PROFILE_NAME = 'lc 提醒'

function ensureRuntimeDir() {
  const { promptxHomeDir } = resolvePromptxPaths()
  const runtimeDir = path.join(promptxHomeDir, 'run')
  fs.mkdirSync(runtimeDir, { recursive: true })
  return runtimeDir
}

function appendLog(message) {
  const logFile = path.join(ensureRuntimeDir(), 'local-update.log')
  const line = `[${new Date().toISOString()}] ${message}\n`
  fs.appendFileSync(logFile, line)
  return logFile
}

function getStatusFilePath() {
  return path.join(ensureRuntimeDir(), 'local-update-status.json')
}

function writeStatus(state = '', extra = {}) {
  const payload = {
    state: String(state || '').trim(),
    updatedAt: new Date().toISOString(),
    ...extra,
  }
  fs.writeFileSync(getStatusFilePath(), JSON.stringify(payload, null, 2))
  return payload
}

function readStatus() {
  try {
    return JSON.parse(fs.readFileSync(getStatusFilePath(), 'utf8'))
  } catch {
    return null
  }
}

function getActiveRuns() {
  const placeholders = ACTIVE_RUN_STATUSES.map(() => '?').join(', ')
  return all(
    `SELECT id, task_slug AS taskSlug, status
     FROM codex_runs
     WHERE status IN (${placeholders})
     ORDER BY updated_at DESC, created_at DESC`,
    ACTIVE_RUN_STATUSES
  )
}

function summarizeActiveRuns(activeRuns = []) {
  if (!activeRuns.length) {
    return '0 个活动 run'
  }
  const preview = activeRuns
    .slice(0, 3)
    .map((item) => `${item.taskSlug || item.id}:${item.status}`)
    .join(', ')
  return `${activeRuns.length} 个活动 run${preview ? `（${preview}${activeRuns.length > 3 ? ' ...' : ''}）` : ''}`
}

function text(locale, zh, en) {
  return normalizeTaskNotificationLocale(locale) === TASK_NOTIFICATION_LOCALES.EN_US ? en : zh
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`命令被信号中断：${command} ${args.join(' ')}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`命令执行失败（退出码 ${code}）：${command} ${args.join(' ')}`))
        return
      }
      resolve()
    })
  })
}

function triggerDetachedRestart() {
  const logFile = path.join(ensureRuntimeDir(), 'local-update.log')
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [serviceScriptPath, 'restart'], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
    windowsHide: true,
  })
  fs.closeSync(logFd)
  child.unref()
  return { pid: child.pid, logFile }
}

function triggerDeferredRestartWatcher() {
  const logFile = path.join(ensureRuntimeDir(), 'local-update.log')
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--restart-when-idle'], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
    windowsHide: true,
  })
  fs.closeSync(logFd)
  child.unref()
  return { pid: child.pid, logFile }
}

function runLoggedCommand(command, args, logFile) {
  return new Promise((resolve, reject) => {
    const logFd = fs.openSync(logFile, 'a')
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: ['ignore', logFd, logFd],
      env: process.env,
      windowsHide: true,
    })
    fs.closeSync(logFd)

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`命令被信号中断：${command} ${args.join(' ')}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`命令执行失败（退出码 ${code}）：${command} ${args.join(' ')}`))
        return
      }
      resolve()
    })
  })
}

async function performRestartAndNotify() {
  const logFile = path.join(ensureRuntimeDir(), 'local-update.log')
  writeStatus('restarting', {
    phase: 'restarting',
    message: '正在执行服务重启。',
  })
  appendLog('开始执行服务重启。')
  await runLoggedCommand(process.execPath, [serviceScriptPath, 'restart'], logFile)
  appendLog('服务重启完成。')
  writeStatus('restarted', {
    phase: 'restarted',
    message: 'PromptX 已完成重启。',
  })
  await notifyLatestProfileForRestart().catch((error) => {
    appendLog(`发送重启通知失败：${error.message || error}`)
  })
}

function getLocalUpdateNotificationProfile() {
  const rows = all(
    `SELECT id, user_id, name, channel_type, webhook_url, secret, locale, updated_at
     FROM notification_profiles
     WHERE LOWER(name) = LOWER(?)
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`
    ,
    [LOCAL_UPDATE_NOTIFICATION_PROFILE_NAME]
  )
  const row = rows[0] || null
  if (!row) {
    return null
  }

  return {
    id: Number(row.id),
    userId: String(row.user_id || 'default').trim() || 'default',
    name: String(row.name || '').trim(),
    channelType: String(row.channel_type || TASK_NOTIFICATION_CHANNELS.DINGTALK).trim() || TASK_NOTIFICATION_CHANNELS.DINGTALK,
    webhookUrl: String(row.webhook_url || '').trim(),
    secret: String(row.secret || '').trim(),
    locale: normalizeTaskNotificationLocale(row.locale),
    updatedAt: String(row.updated_at || ''),
  }
}

function appendSignedQuery(url, secret = '') {
  const targetUrl = String(url || '').trim()
  if (!secret) {
    return targetUrl
  }

  const timestamp = Date.now().toString()
  const stringToSign = `${timestamp}\n${secret}`
  const sign = encodeURIComponent(
    crypto
      .createHmac('sha256', secret)
      .update(stringToSign)
      .digest('base64')
  )

  const target = new URL(targetUrl)
  target.searchParams.set('timestamp', timestamp)
  target.searchParams.set('sign', sign)
  return target.toString()
}

function buildRestartNotificationRequest(profile) {
  const locale = normalizeTaskNotificationLocale(profile?.locale)
  const finishedAt = new Date().toLocaleString(locale)
  const message = [
    text(locale, 'PromptX 本地更新已完成', 'PromptX local update completed'),
    '',
    `${text(locale, '时间', 'Time')}: ${finishedAt}`,
    `${text(locale, '结果', 'Result')}: ${text(locale, '服务已重启成功', 'Service restarted successfully')}`,
  ].join('\n')

  if (profile.channelType === TASK_NOTIFICATION_CHANNELS.FEISHU) {
    const payload = {
      msg_type: 'text',
      content: {
        text: message,
      },
    }

    if (profile.secret) {
      const timestamp = Math.floor(Date.now() / 1000).toString()
      const stringToSign = `${timestamp}\n${profile.secret}`
      payload.timestamp = timestamp
      payload.sign = crypto
        .createHmac('sha256', stringToSign)
        .digest('base64')
    }

    return {
      url: profile.webhookUrl,
      payload,
    }
  }

  if (profile.channelType === TASK_NOTIFICATION_CHANNELS.WEBHOOK) {
    return {
      url: profile.webhookUrl,
      payload: {
        type: 'promptx_local_update',
        title: text(locale, 'PromptX 本地更新已完成', 'PromptX local update completed'),
        message,
        finishedAt: new Date().toISOString(),
      },
    }
  }

  return {
    url: appendSignedQuery(profile.webhookUrl, profile.secret),
    payload: {
      msgtype: 'markdown',
      markdown: {
        title: text(locale, 'PromptX 本地更新已完成', 'PromptX local update completed'),
        text: message,
      },
    },
  }
}

async function postNotification(requestOptions = {}, locale = TASK_NOTIFICATION_LOCALES.ZH_CN) {
  const response = await fetch(requestOptions.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(requestOptions.payload),
  })

  const bodyText = await response.text()
  if (!response.ok) {
    throw new Error(text(locale, `Webhook 返回 ${response.status}：${bodyText.slice(0, 200)}`, `Webhook returned ${response.status}: ${bodyText.slice(0, 200)}`))
  }
}

async function notifyLatestProfileForRestart() {
  const profile = getLocalUpdateNotificationProfile()
  if (!profile?.webhookUrl) {
    appendLog(`未找到名为 ${LOCAL_UPDATE_NOTIFICATION_PROFILE_NAME} 的可用通知配置，跳过重启通知。`)
    return false
  }

  const locale = normalizeTaskNotificationLocale(profile.locale)
  const requestOptions = buildRestartNotificationRequest(profile)
  await postNotification(requestOptions, locale)
  appendLog(`已通过通知配置发送重启通知：profile=${profile.name || profile.id}`)
  return true
}

async function waitForIdleAndRestart() {
  appendLog('后台重启守护已启动，等待活动 run 清空。')
  writeStatus('waiting', {
    phase: 'waiting_for_idle',
    message: '后台重启守护已启动，等待活动 run 清空。',
  })
  const startedAt = Date.now()
  let lastSummary = ''

  while (Date.now() - startedAt < RESTART_WAIT_TIMEOUT_MS) {
    const activeRuns = getActiveRuns()
    if (!activeRuns.length) {
      appendLog('未检测到活动 run，开始执行重启。')
      await performRestartAndNotify()
      return
    }

    const summary = summarizeActiveRuns(activeRuns)
    if (summary !== lastSummary) {
      appendLog(`检测到活动 run，暂不重启：${summary}`)
      writeStatus('waiting', {
        phase: 'waiting_for_idle',
        message: `检测到活动 run，暂不重启：${summary}`,
        activeRunCount: activeRuns.length,
        activeRuns: activeRuns.slice(0, 10),
      })
      lastSummary = summary
    }

    await delay(RESTART_WAIT_INTERVAL_MS)
  }

  appendLog(`等待活动 run 清空超时（${RESTART_WAIT_TIMEOUT_MS}ms），本次未自动重启。`)
  writeStatus('timeout', {
    phase: 'waiting_for_idle',
    message: `等待活动 run 清空超时（${RESTART_WAIT_TIMEOUT_MS}ms），本次未自动重启。`,
  })
}

async function waitForRestartResult(expectedState = 'restarted', timeoutMs = RESTART_RESULT_WAIT_MS) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const status = readStatus()
    if (status?.state === expectedState) {
      return status
    }
    if (status?.state === 'failed' || status?.state === 'timeout') {
      return status
    }
    await delay(500)
  }

  return readStatus()
}

async function main() {
  if (process.argv.includes('--restart-when-idle')) {
    try {
      await waitForIdleAndRestart()
    } catch (error) {
      appendLog(`后台重启守护失败：${error.message || error}`)
      writeStatus('failed', {
        phase: 'watcher_failed',
        message: error.message || String(error || '后台重启守护失败。'),
      })
      throw error
    }
    return
  }

  appendLog('开始执行 local update。')
  writeStatus('running', {
    phase: 'build_install',
    message: '开始执行 local update。',
  })
  console.log('[promptx] 开始执行本地更新：build -> install -> restart when idle')

  await runCommand(npmCommand, ['run', 'build'])
  appendLog('build 完成。')

  await runCommand(npmCommand, ['install', '-g', '.', '--force'])
  appendLog('全局安装完成。')

  const activeRuns = getActiveRuns()
  const { pid, logFile } = triggerDeferredRestartWatcher()
  if (activeRuns.length) {
    appendLog(`检测到活动 run，已投递空闲后重启守护，PID ${pid}。当前：${summarizeActiveRuns(activeRuns)}`)
    writeStatus('waiting', {
      phase: 'waiting_for_idle',
      message: `检测到活动 run，等待空闲后自动重启：${summarizeActiveRuns(activeRuns)}`,
      watcherPid: pid,
      activeRunCount: activeRuns.length,
      activeRuns: activeRuns.slice(0, 10),
    })
    console.log(`[promptx] 已完成 build 和 install。检测到活动 run，等待空闲后自动重启。`)
  } else {
    appendLog(`当前无活动 run，已投递立即重启守护，PID ${pid}。`)
    writeStatus('restarting', {
      phase: 'queued_restart',
      message: '当前无活动 run，后台守护将立即执行重启。',
      watcherPid: pid,
    })
    console.log('[promptx] 已完成 build 和 install。当前无活动 run，将立即自动重启。')
  }

  console.log(`[promptx] 已投递后台重启守护（PID ${pid}）。`)
  console.log(`[promptx] 重启日志：${logFile}`)
  console.log(`[promptx] 重启状态：${getStatusFilePath()}`)

  if (!activeRuns.length) {
    const result = await waitForRestartResult('restarted')
    if (result?.state === 'restarted') {
      console.log(`[promptx] 重启已完成：${result.message || '服务已完成重启流程。'}`)
      return
    }

    if (result?.state === 'failed' || result?.state === 'timeout') {
      console.log(`[promptx] 重启未完成：${result.message || '请查看状态文件或日志。'}`)
      return
    }

    console.log('[promptx] 尚未拿到最终重启结果，请查看状态文件或日志。')
  }
}

main().catch((error) => {
  appendLog(`local update 失败：${error.message || error}`)
  writeStatus('failed', {
    phase: 'main_failed',
    message: error.message || String(error || 'local update 失败。'),
  })
  console.error(`[promptx] ${error.message || error}`)
  process.exitCode = 1
})
