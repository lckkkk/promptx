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

test('notifyRun sends Feishu interactive card message with readable sections', async () => {
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
          errorMessage: [
            '摘要：本轮任务已完成通知卡片改造。',
            '变更：新增飞书交互卡片头部状态样式。',
            '变更：将项目、引擎、时间调整为结构化分区。',
            '风险：旧版纯文本摘要在长文本场景下仍可能影响已发送通知。',
            '下一步：继续优化摘要区的层级和可读性。',
          ].join('\n'),
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
    assert.equal(deliveries[0].payload.msg_type, 'interactive')
    assert.equal(deliveries[0].payload.card.header.title.content, 'PromptX 任务通知')
    assert.equal(deliveries[0].payload.card.header.template, 'red')

    const cardJson = JSON.stringify(deliveries[0].payload.card)
    assert.match(cardJson, /整理通知样式/)
    assert.match(cardJson, /消息中心/)
    assert.match(cardJson, /失败/)
    assert.match(cardJson, /claude-code/)
    assert.match(cardJson, /本轮任务已完成通知卡片改造/)
    assert.match(cardJson, /新增飞书交互卡片头部状态样式/)
    assert.match(cardJson, /将项目、引擎、时间调整为结构化分区/)
    assert.match(cardJson, /旧版纯文本摘要在长文本场景下仍可能影响已发送通知/)
    assert.match(cardJson, /继续优化摘要区的层级和可读性/)
    assert.match(cardJson, /http:\/\/127\.0\.0\.1:9301\/\?task=task-2/)
    assert.match(cardJson, /打开任务/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('notifyRun preserves multiline response message structure for Feishu card', async () => {
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
          slug: 'task-3',
          title: '移动端目录选择',
          codexSessionId: 'pxcs_3',
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
          id: 'run-3',
          taskSlug: 'task-3',
          status: 'completed',
          engine: 'codex',
          finishedAt: '2026-04-08T15:00:00.000Z',
          updatedAt: '2026-04-08T15:00:00.000Z',
          responseMessage: [
            '已经改了，手机端“选择工作目录”现在按你要的方案走的是整体单层滚动。',
            '',
            '这次调整的效果是：',
            '- 上面的“当前选择 / 搜索 / 新建目录 / tab”不再把目录树死死挤住',
            '- 手机端整个正文区域都可以上下滑',
            '- 目录树区域同时保留基础最小高度，不会只剩一行',
            '',
            '验证已做：',
            '- pnpm build 通过',
            '- npm run local:update 已执行',
          ].join('\n'),
        }
      },
      getPromptxCodexSessionById() {
        return {
          id: 'pxcs_3',
          title: 'promptx-codex',
        }
      },
      updateTaskNotificationDelivery() {},
      detailUrlBuilder() {
        return 'http://127.0.0.1:9301/?task=task-3'
      },
    })

    await service.notifyRun('task-3', 'run-3')

    const elements = deliveries[0].payload.card.elements || []
    const contentBlocks = elements
      .filter((item) => item?.text?.content)
      .map((item) => String(item.text.content))
    const cardJson = JSON.stringify(deliveries[0].payload.card)

    assert.equal(contentBlocks.some((item) => item.includes('**摘要**')), true)
    assert.equal(contentBlocks.some((item) => item.includes('**变更**')), true)
    assert.equal(contentBlocks.some((item) => item.includes('**验证**')), true)
    assert.equal(contentBlocks.some((item) => item.includes('- 上面的“当前选择 / 搜索 / 新建目录 / tab”不再把目录树死死挤住')), true)
    assert.equal(contentBlocks.some((item) => item.includes('- pnpm build 通过')), true)
    assert.equal(contentBlocks.some((item) => item.includes('已经改了，手机端“选择工作目录”现在按你要的方案走的是整体单层滚动。')), true)
    assert.equal(contentBlocks.some((item) => item.includes('这次调整的效果是')), false)
    assert.equal(contentBlocks.some((item) => item.includes('验证已做')), false)
    assert.doesNotMatch(cardJson, /摘要\*\*\\n已经改了，手机端“选择工作目录”现在按你要的方案走的是整体单层滚动。 这次调整的效果是： - 上面的/)
  } finally {
    globalThis.fetch = originalFetch
  }
})
