import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractClaudeAssistantText,
  extractClaudeResultText,
  extractClaudeSessionId,
  normalizeClaudeEvent,
} from './claudeCodeRunner.js'

test('extractClaudeAssistantText joins nested text parts', () => {
  const text = extractClaudeAssistantText({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    },
  })

  assert.equal(text, '第一段\n第二段')
})

test('extractClaudeSessionId reads common session id fields', () => {
  assert.equal(extractClaudeSessionId({ session_id: 'claude-session-1' }), 'claude-session-1')
  assert.equal(extractClaudeSessionId({ result: { session_id: 'claude-session-2' } }), 'claude-session-2')
})

test('normalizeClaudeEvent maps assistant output to agent message', () => {
  assert.deepEqual(
    normalizeClaudeEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '已完成修改' }],
      },
    }),
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '已完成修改',
      },
    }
  )
})

test('normalizeClaudeEvent maps result output to turn completion', () => {
  assert.deepEqual(
    normalizeClaudeEvent({
      type: 'result',
      result: '最终回复',
    }),
    {
      type: 'turn.completed',
      result: '最终回复',
    }
  )

  assert.equal(extractClaudeResultText({ result: '最终回复' }), '最终回复')
})
