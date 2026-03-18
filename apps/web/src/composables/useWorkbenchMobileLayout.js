import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMediaQuery } from './useMediaQuery.js'

const MOBILE_BREAKPOINT_QUERY = '(max-width: 1023px)'
const MOBILE_DETAIL_HISTORY_KEY = 'promptxWorkbenchMobileView'

function hasMobileDetailHistoryState(state) {
  return state?.[MOBILE_DETAIL_HISTORY_KEY] === 'detail'
}

export function useWorkbenchMobileLayout({ currentTaskSlug }) {
  const { matches: isMobileLayout } = useMediaQuery(MOBILE_BREAKPOINT_QUERY)
  const mobileView = ref('tasks')
  const mobileDetailTab = ref('activity')

  function replaceMobileHistoryState(view = 'tasks') {
    if (typeof window === 'undefined') {
      return
    }

    const nextState = { ...(window.history.state || {}) }
    if (view === 'detail') {
      nextState[MOBILE_DETAIL_HISTORY_KEY] = 'detail'
    } else {
      delete nextState[MOBILE_DETAIL_HISTORY_KEY]
    }

    window.history.replaceState(nextState, '')
  }

  function pushMobileDetailHistoryState() {
    if (typeof window === 'undefined') {
      return
    }

    const nextState = {
      ...(window.history.state || {}),
      [MOBILE_DETAIL_HISTORY_KEY]: 'detail',
    }
    window.history.pushState(nextState, '')
  }

  function syncMobileViewFromHistory(state = null) {
    if (!isMobileLayout.value) {
      mobileView.value = 'detail'
      return
    }

    if (!currentTaskSlug.value) {
      mobileView.value = 'tasks'
      replaceMobileHistoryState('tasks')
      return
    }

    mobileView.value = hasMobileDetailHistoryState(state) ? 'detail' : 'tasks'
  }

  function updateMobileLayout(matches) {
    isMobileLayout.value = Boolean(matches)
    syncMobileViewFromHistory(typeof window === 'undefined' ? null : window.history.state)
  }

  function enterMobileDetail(options = {}) {
    const { pushHistory = true } = options
    mobileView.value = 'detail'
    if (!isMobileLayout.value) {
      return
    }

    if (pushHistory) {
      pushMobileDetailHistoryState()
      return
    }

    replaceMobileHistoryState('detail')
  }

  function leaveMobileDetail(options = {}) {
    const { useHistory = true } = options
    if (!isMobileLayout.value) {
      mobileView.value = 'tasks'
      return
    }

    if (useHistory && typeof window !== 'undefined' && hasMobileDetailHistoryState(window.history.state)) {
      window.history.back()
      return
    }

    mobileView.value = 'tasks'
    replaceMobileHistoryState('tasks')
  }

  function handlePopState(event) {
    if (!isMobileLayout.value) {
      return
    }

    mobileView.value = hasMobileDetailHistoryState(event.state) && currentTaskSlug.value ? 'detail' : 'tasks'
  }

  onMounted(() => {
    if (typeof window === 'undefined') {
      return
    }

    window.addEventListener('popstate', handlePopState)
  })

  onBeforeUnmount(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('popstate', handlePopState)
    }
  })

  watch(
    isMobileLayout,
    (matches) => {
      updateMobileLayout(matches)
    },
    { immediate: true }
  )

  watch(
    currentTaskSlug,
    () => {
      if (typeof window === 'undefined') {
        return
      }

      syncMobileViewFromHistory(window.history.state)
    },
    { flush: 'post' }
  )

  return {
    enterMobileDetail,
    isMobileLayout,
    leaveMobileDetail,
    mobileDetailTab,
    mobileView,
  }
}
