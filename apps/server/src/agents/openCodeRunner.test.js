import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createOpenCodeNormalizationState,
  extractOpenCodeErrorMessage,
  extractOpenCodeSessionId,
  extractOpenCodeText,
  extractOpenCodeUsage,
  normalizeOpenCodeEvent,
  normalizeOpenCodeEvents,
} from './openCodeRunner.js'

test('extractOpenCodeSessionId reads common session id fields', () => {
  assert.equal(extractOpenCodeSessionId({ sessionID: 'opencode-session-1' }), 'opencode-session-1')
  assert.equal(extractOpenCodeSessionId({ sessionId: 'opencode-session-2' }), 'opencode-session-2')
})

test('extractOpenCodeText trims text payload', () => {
  assert.equal(
    extractOpenCodeText({
      type: 'text',
      part: {
        type: 'text',
        text: '\n\n已完成修改\n',
      },
    }),
    '已完成修改'
  )
})

test('normalizeOpenCodeEvent maps text output to agent message', () => {
  assert.deepEqual(
    normalizeOpenCodeEvent({
      type: 'text',
      part: {
        type: 'text',
        text: '已完成修改',
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

test('normalizeOpenCodeEvents maps first step_start to turn.started only once', () => {
  const state = createOpenCodeNormalizationState()

  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'step_start',
      sessionID: 'ses_1',
    }, state),
    [{ type: 'turn.started' }]
  )

  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'step_start',
      sessionID: 'ses_1',
    }, state),
    []
  )
})

test('normalizeOpenCodeEvents maps completed tool_use to command events', () => {
  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'tool_use',
      sessionID: 'ses_2',
      part: {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: {
            filePath: '/tmp/demo.txt',
          },
          output: '<path>/tmp/demo.txt</path>',
        },
      },
    }),
    [
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          command: 'read: /tmp/demo.txt',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'read: /tmp/demo.txt',
          status: 'completed',
          exit_code: 0,
          aggregated_output: '<path>/tmp/demo.txt</path>',
        },
      },
    ]
  )
})

test('normalizeOpenCodeEvent maps step_finish stop to turn completion with usage', () => {
  const event = normalizeOpenCodeEvent({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: {
        input: 321,
        output: 12,
        cache: {
          read: 256,
        },
      },
    },
  })

  assert.deepEqual(event, {
    type: 'turn.completed',
    usage: {
      input_tokens: 321,
      output_tokens: 12,
      cached_input_tokens: 256,
    },
  })

  assert.deepEqual(extractOpenCodeUsage({
    part: {
      tokens: {
        input: 321,
        output: 12,
        cache: {
          read: 256,
        },
      },
    },
  }), {
    input_tokens: 321,
    output_tokens: 12,
    cached_input_tokens: 256,
  })
})

test('extractOpenCodeErrorMessage reads nested API errors', () => {
  assert.equal(
    extractOpenCodeErrorMessage({
      type: 'error',
      error: {
        name: 'APIError',
        data: {
          message: 'openai_error',
          responseBody: '{"error":{"message":"bad gateway"}}',
        },
      },
    }),
    'openai_error'
  )
})
