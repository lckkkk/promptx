import { onBeforeUnmount, onMounted, ref } from 'vue'

export function useMediaQuery(query, initialValue = false) {
  const matches = ref(Boolean(initialValue))

  let mediaQueryList = null
  let removeListener = () => {}

  function updateMatches(nextMatches) {
    matches.value = Boolean(nextMatches)
  }

  onMounted(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return
    }

    mediaQueryList = window.matchMedia(query)
    updateMatches(mediaQueryList.matches)

    const handleChange = (event) => {
      updateMatches(event.matches)
    }

    if (typeof mediaQueryList.addEventListener === 'function') {
      mediaQueryList.addEventListener('change', handleChange)
      removeListener = () => mediaQueryList?.removeEventListener('change', handleChange)
      return
    }

    if (typeof mediaQueryList.addListener === 'function') {
      mediaQueryList.addListener(handleChange)
      removeListener = () => mediaQueryList?.removeListener(handleChange)
    }
  })

  onBeforeUnmount(() => {
    removeListener()
  })

  return {
    matches,
  }
}
