import test from 'node:test'
import assert from 'node:assert/strict'

import { normalizeOpenCodeEvents } from './openCodeRunner.js'

test('runner openCodeRunner maps sub-agent task tool_use to collaboration events', () => {
  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'tool_use',
      sessionID: 'ses_main',
      part: {
        type: 'tool',
        tool: 'task',
        state: {
          status: 'completed',
          input: {
            description: '分析 a.js 文件',
            prompt: '请分析 /tmp/demo/a.js 文件',
            subagent_type: 'explore',
          },
          output: 'task_id: ses_child_1\n\n<task_result>ok</task_result>',
          metadata: {
            sessionId: 'ses_child_1',
            model: {
              providerID: 'opencode',
              modelID: 'minimax-m2.5-free',
            },
          },
        },
      },
    }),
    [
      {
        type: 'item.completed',
        item: {
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          receiver_thread_ids: ['ses_child_1'],
          prompt: '请分析 /tmp/demo/a.js 文件',
          agents_states: {
            ses_child_1: {
              status: 'completed',
              message: 'task_id: ses_child_1\n\n<task_result>ok</task_result>',
              title: '分析 a.js 文件',
              role: 'explore',
              target: 'a.js',
              model: 'opencode/minimax-m2.5-free',
            },
          },
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'collab_tool_call',
          tool: 'wait',
          receiver_thread_ids: ['ses_child_1'],
          prompt: '请分析 /tmp/demo/a.js 文件',
          agents_states: {
            ses_child_1: {
              status: 'completed',
              message: 'task_id: ses_child_1\n\n<task_result>ok</task_result>',
              title: '分析 a.js 文件',
              role: 'explore',
              target: 'a.js',
              model: 'opencode/minimax-m2.5-free',
            },
          },
        },
      },
    ]
  )
})
