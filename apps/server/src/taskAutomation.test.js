import assert from 'node:assert/strict'
import test from 'node:test'

import { createTaskAutomationService } from './taskAutomation.js'

test('notifyRun includes project title in webhook notification payload', async () => {
  const deliveries = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, options = {}) => {
    deliveries.push({
      url,
      payload: JSON.parse(String(options.body || '{}')),
    })

    return {
      ok: true,
      async text() {
        return '{}'
      },
    }
  }

  try {
    const service = createTaskAutomationService({
      getTaskBySlug() {
        return {
          slug: 'task-1',
          title: '任务一',
          codexSessionId: 'pxcs_1',
          notification: {
            enabled: true,
            webhookUrl: 'https://example.com/webhook',
            channelType: 'webhook',
            triggerOn: 'completed',
            locale: 'zh-CN',
          },
        }
      },
      getRunById() {
        return {
          id: 'run-1',
          taskSlug: 'task-1',
          status: 'completed',
          engine: 'codex',
          finishedAt: '2026-04-08T01:30:00.000Z',
          updatedAt: '2026-04-08T01:30:00.000Z',
          responseMessage: 'done',
        }
      },
      getPromptxCodexSessionById() {
        return {
          id: 'pxcs_1',
          title: '结算项目',
        }
      },
      updateTaskNotificationDelivery() {},
      detailUrlBuilder() {
        return 'http://127.0.0.1:9301/tasks/task-1'
      },
    })

    await service.notifyRun('task-1', 'run-1')

    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].payload.task.projectTitle, '结算项目')
    assert.match(deliveries[0].payload.message, /项目: 结算项目/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyRun sends Feishu rich post message with readable sections', async () => {
  const deliveries = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, options = {}) => {
    deliveries.push({
      url,
      payload: JSON.parse(String(options.body || '{}')),
    })

    return {
      ok: true,
      async text() {
        return '{}'
      },
    }
  }

  try {
    const service = createTaskAutomationService({
      getTaskBySlug() {
        return {
          slug: 'task-2',
          title: '整理通知样式',
          codexSessionId: 'pxcs_2',
          notification: {
            enabled: true,
            webhookUrl: 'https://open.feishu.cn/webhook/demo',
            channelType: 'feishu',
            triggerOn: 'completed',
            locale: 'zh-CN',
          },
        }
      },
      getRunById() {
        return {
          id: 'run-2',
          taskSlug: 'task-2',
          status: 'error',
          engine: 'claude-code',
          finishedAt: '2026-04-08T10:30:00.000Z',
          updatedAt: '2026-04-08T10:30:00.000Z',
          errorMessage: '飞书通知还是纯文本，可读性太差',
        }
      },
      getPromptxCodexSessionById() {
        return {
          id: 'pxcs_2',
          title: '消息中心',
        }
      },
      updateTaskNotificationDelivery() {},
      detailUrlBuilder() {
        return 'http://127.0.0.1:9301/?task=task-2'
      },
    })

    await service.notifyRun('task-2', 'run-2')

    assert.equal(deliveries.length, 1)
    assert.equal(deliveries[0].payload.msg_type, 'post')
    assert.equal(deliveries[0].payload.content.post.zh_cn.title, 'PromptX 任务通知')

    const lines = deliveries[0].payload.content.post.zh_cn.content
    assert.equal(Array.isArray(lines), true)
    assert.match(JSON.stringify(lines), /整理通知样式/)
    assert.match(JSON.stringify(lines), /消息中心/)
    assert.match(JSON.stringify(lines), /失败/)
    assert.match(JSON.stringify(lines), /claude-code/)
    assert.match(JSON.stringify(lines), /飞书通知还是纯文本/)
    assert.match(JSON.stringify(lines), /http:\/\/127\.0\.0\.1:9301\/\?task=task-2/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
