import { request } from './request.js'

export function getRelayConfig() {
  return request('/api/relay/config', {
    cache: 'no-store',
  })
}

export function updateRelayConfig(payload) {
  return request('/api/relay/config', {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function reconnectRelay() {
  return request('/api/relay/reconnect', {
    method: 'POST',
  })
}
