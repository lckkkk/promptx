export const EDITOR_AUTO_SCROLL_THRESHOLD = 32
export const EDITOR_SCROLL_PADDING = 20

export function isScrollContainerNearBottom(element, threshold = EDITOR_AUTO_SCROLL_THRESHOLD) {
  if (!element) {
    return true
  }

  const distanceToBottom = Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight)
  return distanceToBottom <= threshold
}

export function getRelativeOffsetTop(target, container) {
  if (!target || !container) {
    return 0
  }

  const targetRect = target.getBoundingClientRect()
  const containerRect = container.getBoundingClientRect()
  return targetRect.top - containerRect.top + container.scrollTop
}

export function computeScrollTopForTarget({
  containerScrollTop = 0,
  containerClientHeight = 0,
  targetTop = 0,
  targetHeight = 0,
  align = 'nearest',
  padding = EDITOR_SCROLL_PADDING,
} = {}) {
  const safePadding = Math.max(0, Number(padding) || 0)
  const currentTop = Math.max(0, Number(containerScrollTop) || 0)
  const viewportHeight = Math.max(0, Number(containerClientHeight) || 0)
  const blockTop = Math.max(0, Number(targetTop) || 0)
  const blockHeight = Math.max(0, Number(targetHeight) || 0)
  const blockBottom = blockTop + blockHeight

  if (!viewportHeight) {
    return currentTop
  }

  if (align === 'end') {
    return Math.max(0, blockBottom - viewportHeight + safePadding)
  }

  const visibleTop = currentTop + safePadding
  const visibleBottom = currentTop + viewportHeight - safePadding

  if (blockTop < visibleTop) {
    return Math.max(0, blockTop - safePadding)
  }

  if (blockBottom > visibleBottom) {
    return Math.max(0, blockBottom - viewportHeight + safePadding)
  }

  return currentTop
}

export function isTargetVisibleInContainer({
  containerScrollTop = 0,
  containerClientHeight = 0,
  targetTop = 0,
  targetHeight = 0,
  padding = EDITOR_SCROLL_PADDING,
} = {}) {
  const safePadding = Math.max(0, Number(padding) || 0)
  const currentTop = Math.max(0, Number(containerScrollTop) || 0)
  const viewportHeight = Math.max(0, Number(containerClientHeight) || 0)
  const blockTop = Math.max(0, Number(targetTop) || 0)
  const blockHeight = Math.max(0, Number(targetHeight) || 0)
  const blockBottom = blockTop + blockHeight

  if (!viewportHeight) {
    return true
  }

  const visibleTop = currentTop + safePadding
  const visibleBottom = currentTop + viewportHeight - safePadding

  if (blockHeight >= Math.max(0, visibleBottom - visibleTop)) {
    return blockBottom > visibleTop && blockTop < visibleBottom
  }

  return blockTop >= visibleTop && blockBottom <= visibleBottom
}
