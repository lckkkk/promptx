export const AGENT_RUN_ENVELOPE_EVENT_TYPES = {
  SESSION: 'session',
  SESSION_UPDATED: 'session.updated',
  STATUS: 'status',
  STDOUT: 'stdout',
  STDERR: 'stderr',
  AGENT_EVENT: 'agent_event',
  COMPLETED: 'completed',
  STOPPED: 'stopped',
  ERROR: 'error',
}

export function normalizeAgentRunEnvelopeEventType(value = '') {
  const normalized = String(value || '').trim().toLowerCase()

  if (normalized === 'codex') {
    return AGENT_RUN_ENVELOPE_EVENT_TYPES.AGENT_EVENT
  }

  return normalized
}

export function createAgentRunEnvelopeEvent(type = '', payload = {}) {
  return {
    type: normalizeAgentRunEnvelopeEventType(type),
    ...(payload && typeof payload === 'object' ? payload : {}),
  }
}

export function createSessionEnvelopeEvent(session) {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.SESSION, { session })
}

export function createSessionUpdatedEnvelopeEvent(session) {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.SESSION_UPDATED, { session })
}

export function createStatusEnvelopeEvent(payload = {}) {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.STATUS, payload)
}

export function createStdoutEnvelopeEvent(text = '') {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.STDOUT, {
    text: String(text || ''),
  })
}

export function createStderrEnvelopeEvent(text = '') {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.STDERR, {
    text: String(text || ''),
  })
}

export function createAgentEventEnvelopeEvent(event = {}) {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.AGENT_EVENT, { event })
}

export function createCompletedEnvelopeEvent(message = '') {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.COMPLETED, {
    message: String(message || ''),
  })
}

export function createStoppedEnvelopeEvent(message = '') {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.STOPPED, {
    message: String(message || ''),
  })
}

export function createErrorEnvelopeEvent(message = '', payload = {}) {
  return createAgentRunEnvelopeEvent(AGENT_RUN_ENVELOPE_EVENT_TYPES.ERROR, {
    message: String(message || ''),
    ...(payload && typeof payload === 'object' ? payload : {}),
  })
}
