import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildRunFingerprintForTranscript,
  buildTurnVisibleSnapshot,
} from './useCodexRunHistory.js'

test('隐藏执行过程时，process-only 更新不改变可见快照', () => {
  const previous = {
    id: 'run-1',
    prompt: '你好',
    responseMessage: '',
    errorMessage: '',
    status: 'running',
    updatedAt: '2026-03-28T10:00:00.000Z',
    eventCount: 12,
    lastEventSeq: 12,
  }
  const next = {
    ...previous,
    updatedAt: '2026-03-28T10:00:05.000Z',
    eventCount: 18,
    lastEventSeq: 18,
  }

  assert.deepEqual(
    buildTurnVisibleSnapshot(previous, false),
    buildTurnVisibleSnapshot(next, false)
  )
})

test('显示执行过程时，process-only 更新会改变可见指纹', () => {
  const runs = [
    {
      id: 'run-1',
      prompt: '你好',
      responseMessage: '',
      errorMessage: '',
      status: 'running',
      updatedAt: '2026-03-28T10:00:00.000Z',
      eventCount: 12,
      lastEventSeq: 12,
    },
  ]
  const nextRuns = [
    {
      ...runs[0],
      updatedAt: '2026-03-28T10:00:05.000Z',
      eventCount: 18,
      lastEventSeq: 18,
    },
  ]

  assert.notEqual(
    buildRunFingerprintForTranscript(runs, true),
    buildRunFingerprintForTranscript(nextRuns, true)
  )
  assert.equal(
    buildRunFingerprintForTranscript(runs, false),
    buildRunFingerprintForTranscript(nextRuns, false)
  )
})
