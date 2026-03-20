export const CODEX_RUN_EVENTS_MODES = {
  NONE: 'none',
  LATEST: 'latest',
  ALL: 'all',
}

export function normalizeCodexRunEventsMode(value = '', legacyOptions = {}) {
  const normalized = String(value || '').trim().toLowerCase()

  if (normalized === CODEX_RUN_EVENTS_MODES.ALL) {
    return CODEX_RUN_EVENTS_MODES.ALL
  }

  if (normalized === CODEX_RUN_EVENTS_MODES.LATEST) {
    return CODEX_RUN_EVENTS_MODES.LATEST
  }

  if (normalized === CODEX_RUN_EVENTS_MODES.NONE) {
    return CODEX_RUN_EVENTS_MODES.NONE
  }

  if (legacyOptions.includeEvents) {
    return CODEX_RUN_EVENTS_MODES.ALL
  }

  if (legacyOptions.includeLatestEvents) {
    return CODEX_RUN_EVENTS_MODES.LATEST
  }

  return CODEX_RUN_EVENTS_MODES.NONE
}
