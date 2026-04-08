import { request } from './request.js'

export function getMeta() {
  return request('/api/meta', {
    cache: 'no-store',
  })
}

export function listTasks() {
  return request('/api/tasks')
}

export function listTaskWorkspaceDiffSummaries(limit = 30) {
  const params = new URLSearchParams()
  const normalizedLimit = Math.max(1, Number(limit) || 30)
  params.set('limit', String(normalizedLimit))

  return request(`/api/tasks/workspace-diff-summaries?${params.toString()}`, {
    cache: 'no-store',
  })
}

export function createTask(payload) {
  return request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function reorderTasks(slugs = []) {
  return request('/api/tasks/reorder', {
    method: 'POST',
    body: JSON.stringify({ slugs }),
  })
}

export function getTask(slug) {
  return request(`/api/tasks/${slug}`)
}

export function updateTask(slug, payload) {
  return request(`/api/tasks/${slug}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function listNotificationProfiles() {
  return request('/api/notification-profiles', {
    cache: 'no-store',
  })
}

export function createNotificationProfile(payload) {
  return request('/api/notification-profiles', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateNotificationProfile(profileId, payload) {
  return request(`/api/notification-profiles/${encodeURIComponent(profileId)}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteNotificationProfile(profileId) {
  return request(`/api/notification-profiles/${encodeURIComponent(profileId)}`, {
    method: 'DELETE',
  })
}

export function deleteTask(slug) {
  return request(`/api/tasks/${slug}`, {
    method: 'DELETE',
  })
}

export function fetchRawTask(slug) {
  return request(`/api/tasks/${slug}/raw`)
}
