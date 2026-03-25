import { computed, ref } from 'vue'
import {
  DEFAULT_LOCALE,
  getLocaleMetadata,
  interpolate,
  LOCALE_STORAGE_KEY,
  MESSAGES,
  resolveLocale,
  resolveMessage,
  SUPPORTED_LOCALES,
} from '../lib/i18n.js'

const currentLocale = ref(DEFAULT_LOCALE)
const localeReady = ref(false)

function getBrowserLocaleFallback() {
  if (typeof window === 'undefined') {
    return DEFAULT_LOCALE
  }

  const language = String(window.navigator?.language || '').trim().toLowerCase()
  if (language.startsWith('en')) {
    return 'en-US'
  }

  return DEFAULT_LOCALE
}

function applyDocumentLocale(locale) {
  if (typeof document === 'undefined') {
    return
  }

  document.documentElement.lang = locale
}

export function getCurrentLocale() {
  return currentLocale.value
}

export function translate(key = '', params = {}, fallback = '') {
  const locale = resolveLocale(currentLocale.value)
  const currentMessages = MESSAGES[locale] || MESSAGES[DEFAULT_LOCALE]
  const fallbackMessages = MESSAGES[DEFAULT_LOCALE] || {}
  const resolved = resolveMessage(currentMessages, key) ?? resolveMessage(fallbackMessages, key)

  if (typeof resolved === 'function') {
    return resolved(params)
  }

  if (typeof resolved === 'string') {
    return interpolate(resolved, params)
  }

  return fallback || key
}

export function initializeI18n() {
  if (typeof window === 'undefined') {
    currentLocale.value = DEFAULT_LOCALE
    localeReady.value = true
    return currentLocale.value
  }

  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
  const nextLocale = resolveLocale(stored || getBrowserLocaleFallback())
  currentLocale.value = nextLocale
  window.localStorage.setItem(LOCALE_STORAGE_KEY, nextLocale)
  applyDocumentLocale(nextLocale)
  localeReady.value = true
  return nextLocale
}

export function setLocale(nextLocale = '') {
  const resolved = resolveLocale(nextLocale)
  currentLocale.value = resolved

  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, resolved)
  }

  applyDocumentLocale(resolved)
  localeReady.value = true
}

export function formatDateTime(value = '', options = {}) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return translate('common.notAvailable')
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    return translate('common.notAvailable')
  }

  return new Intl.DateTimeFormat(getCurrentLocale(), options).format(parsed)
}

export function formatDate(value = '', options = {}) {
  return formatDateTime(value, {
    month: 'numeric',
    day: 'numeric',
    ...options,
  })
}

export function compareByLocale(left = '', right = '') {
  return String(left || '').localeCompare(String(right || ''), getCurrentLocale())
}

export function useI18n() {
  const locale = computed(() => currentLocale.value)
  const localeOptions = computed(() => SUPPORTED_LOCALES.map((item) => ({
    value: item.value,
    label: item.label,
    englishLabel: item.englishLabel,
  })))
  const localeMeta = computed(() => getLocaleMetadata(currentLocale.value))

  return {
    locale,
    localeMeta,
    localeOptions,
    localeReady,
    setLocale,
    t: translate,
  }
}
