import { createInterface } from 'node:readline'
import process from 'node:process'

import { getTaskGitDiffReview } from './gitDiff.js'

function writeMessage(payload = {}) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function handleRequest(payload = {}) {
  const requestId = String(payload?.requestId || '').trim()
  const action = String(payload?.action || '').trim()

  if (!requestId) {
    writeMessage({
      ok: false,
      error: {
        message: 'Missing requestId.',
      },
    })
    return
  }

  if (action !== 'getTaskGitDiffReview') {
    writeMessage({
      requestId,
      ok: false,
      error: {
        message: `Unsupported git diff worker action: ${action || 'unknown'}`,
      },
    })
    return
  }

  try {
    const result = getTaskGitDiffReview(payload.taskSlug, payload.options || {})
    writeMessage({
      requestId,
      ok: true,
      result,
    })
  } catch (error) {
    writeMessage({
      requestId,
      ok: false,
      error: {
        message: String(error?.message || error || 'git diff worker failed'),
      },
    })
  }
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})

rl.on('line', (line) => {
  const text = String(line || '').trim()
  if (!text) {
    return
  }

  try {
    handleRequest(JSON.parse(text))
  } catch (error) {
    writeMessage({
      ok: false,
      error: {
        message: String(error?.message || error || 'Invalid worker payload.'),
      },
    })
  }
})

rl.on('close', () => {
  process.exit(0)
})
