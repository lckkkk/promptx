import assert from 'node:assert/strict'
import test from 'node:test'

import { filterTasksBySessionIds, resolveSwipeEndOffset } from './workbenchTaskList.js'

test('filterTasksBySessionIds keeps tasks from multiple selected projects', () => {
  const items = filterTasksBySessionIds([
    { slug: 'a', codexSessionId: 'p1' },
    { slug: 'b', codexSessionId: 'p2' },
    { slug: 'c', codexSessionId: 'p3' },
  ], ['p1', 'p3'])

  assert.deepEqual(items.map((item) => item.slug), ['a', 'c'])
})

test('filterTasksBySessionIds returns all tasks when no filter is selected', () => {
  const items = filterTasksBySessionIds([
    { slug: 'a', codexSessionId: 'p1' },
    { slug: 'b', codexSessionId: 'p2' },
  ], [])

  assert.deepEqual(items.map((item) => item.slug), ['a', 'b'])
})

test('resolveSwipeEndOffset snaps open only after threshold', () => {
  assert.equal(resolveSwipeEndOffset(20), 0)
  assert.equal(resolveSwipeEndOffset(44), 88)
  assert.equal(resolveSwipeEndOffset(120), 88)
})
