import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('TaskDiffFileList uses the selected file prop in template bindings', () => {
  const filePath = path.resolve(process.cwd(), 'apps/web/src/components/TaskDiffFileList.vue')
  const source = fs.readFileSync(filePath, 'utf8')

  assert.match(source, /props\.selectedFilePath/)
})
