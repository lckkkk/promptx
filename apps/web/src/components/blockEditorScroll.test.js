import assert from 'node:assert/strict'
import test from 'node:test'

import {
  computeScrollTopForTarget,
  isTargetVisibleInContainer,
  isScrollContainerNearBottom,
} from './blockEditorScroll.js'

test('isScrollContainerNearBottom detects near-bottom state with threshold', () => {
  assert.equal(isScrollContainerNearBottom({
    scrollHeight: 1000,
    scrollTop: 770,
    clientHeight: 200,
  }), true)

  assert.equal(isScrollContainerNearBottom({
    scrollHeight: 1000,
    scrollTop: 720,
    clientHeight: 200,
  }), false)
})

test('computeScrollTopForTarget keeps current scroll when target is already visible', () => {
  const nextScrollTop = computeScrollTopForTarget({
    containerScrollTop: 300,
    containerClientHeight: 400,
    targetTop: 360,
    targetHeight: 120,
    align: 'nearest',
    padding: 20,
  })

  assert.equal(nextScrollTop, 300)
})

test('computeScrollTopForTarget scrolls down when target falls below viewport', () => {
  const nextScrollTop = computeScrollTopForTarget({
    containerScrollTop: 300,
    containerClientHeight: 400,
    targetTop: 720,
    targetHeight: 80,
    align: 'nearest',
    padding: 20,
  })

  assert.equal(nextScrollTop, 420)
})

test('computeScrollTopForTarget aligns target near bottom when using end mode', () => {
  const nextScrollTop = computeScrollTopForTarget({
    containerScrollTop: 300,
    containerClientHeight: 400,
    targetTop: 720,
    targetHeight: 80,
    align: 'end',
    padding: 20,
  })

  assert.equal(nextScrollTop, 420)
})

test('isTargetVisibleInContainer detects fully visible target with padding', () => {
  assert.equal(isTargetVisibleInContainer({
    containerScrollTop: 300,
    containerClientHeight: 400,
    targetTop: 360,
    targetHeight: 120,
    padding: 20,
  }), true)

  assert.equal(isTargetVisibleInContainer({
    containerScrollTop: 300,
    containerClientHeight: 400,
    targetTop: 660,
    targetHeight: 80,
    padding: 20,
  }), false)
})

test('isTargetVisibleInContainer treats oversized target as visible when it intersects viewport', () => {
  assert.equal(isTargetVisibleInContainer({
    containerScrollTop: 300,
    containerClientHeight: 400,
    targetTop: 280,
    targetHeight: 520,
    padding: 20,
  }), true)
})
