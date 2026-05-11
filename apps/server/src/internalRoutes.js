import { assertInternalRequest } from './internalAuth.js'

const INTERNAL_RUNNER_EVENTS_BODY_LIMIT = Math.max(
  1024 * 1024,
  Number(process.env.PROMPTX_INTERNAL_RUNNER_EVENTS_BODY_LIMIT) || 10 * 1024 * 1024
)

function registerInternalRunnerRoutes(app, options = {}) {
  const {
    runEventIngestService,
    taskAutomationService,
  } = options

  app.post('/internal/runner-events', {
    bodyLimit: INTERNAL_RUNNER_EVENTS_BODY_LIMIT,
  }, async (request, reply) => {
    try {
      assertInternalRequest(request.headers)
      return runEventIngestService.ingestEvents(request.body?.items || [])
    } catch (error) {
      return reply.code(error.statusCode || 400).send({
        message: error.message || 'Runner 事件写入失败。',
      })
    }
  })

  app.post('/internal/runner-status', async (request, reply) => {
    try {
      assertInternalRequest(request.headers)
      const result = runEventIngestService.ingestStatus(request.body || {})
      const run = result?.run || null
      if (!run) {
        return reply.code(404).send({ message: '没有找到对应的运行记录。' })
      }

      if (result.transitionedToTerminal) {
        taskAutomationService.notifyRun(run.taskSlug, run.id).catch(() => {})
      }

      return {
        ok: true,
        run,
      }
    } catch (error) {
      return reply.code(error.statusCode || 400).send({
        message: error.message || 'Runner 状态写入失败。',
      })
    }
  })
}

function registerRealtimeRoutes(app, options = {}) {
  const sseHub = options.sseHub

  app.get('/api/events/stream', async (request, reply) => {
    reply.hijack()
    const requestOrigin = request.headers.origin
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(requestOrigin ? {
        'Access-Control-Allow-Origin': requestOrigin,
        Vary: 'Origin',
      } : {}),
    })
    reply.raw.socket?.setNoDelay?.(true)
    reply.raw.flushHeaders?.()

    const removeClient = sseHub.addClient(reply.raw)
    sseHub.write(reply.raw, {
      type: 'ready',
      sentAt: new Date().toISOString(),
    })

    const handleClose = () => {
      removeClient()
    }

    reply.raw.on('close', handleClose)
  })
}

export {
  registerInternalRunnerRoutes,
  registerRealtimeRoutes,
}
