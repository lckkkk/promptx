import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('useTaskDiffReviewData does not reference removed selectedFilePath ref internally', () => {
  const filePath = path.resolve(process.cwd(), 'apps/web/src/composables/useTaskDiffReviewData.js')
  const source = fs.readFileSync(filePath, 'utf8')

  assert.doesNotMatch(source, /selectedFilePath\.value/)
  assert.match(source, /selectedFilePath:\s*selectedFileKey/)
})
