export function filterTasksBySessionIds(tasks = [], selectedSessionIds = []) {
  const normalizedSelectedIds = (selectedSessionIds || [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)

  if (!normalizedSelectedIds.length) {
    return Array.isArray(tasks) ? tasks : []
  }

  return (tasks || []).filter((task) => normalizedSelectedIds.includes(String(task?.codexSessionId || '').trim()))
}

export function resolveSwipeEndOffset(offset = 0, threshold = 132, maxOffset = 264) {
  const normalizedOffset = Math.max(0, Math.min(maxOffset, Number(offset) || 0))
  return normalizedOffset >= threshold ? maxOffset : 0
}
