import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createDirectoryPickerDirectory, listDirectoryPickerTree, searchDirectoryPickerEntries } from './workspaceFiles.js'

test('listDirectoryPickerTree returns filesystem roots when path is empty', () => {
  const payload = listDirectoryPickerTree()

  assert.equal(payload.path, path.resolve(os.homedir()))
  assert.equal(payload.parentPath, '')
  assert.equal(Array.isArray(payload.items), true)
  assert.equal(payload.items.length > 0, true)
  assert.equal(payload.items.every((item) => item.type === 'directory'), true)
})

test('listDirectoryPickerTree lists child directories and excludes files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-dir-picker-'))
  const childDir = path.join(tempDir, 'project-a')
  const nestedDir = path.join(tempDir, 'project-b')
  const hiddenDir = path.join(tempDir, '.secret')
  const downloadsDir = path.join(tempDir, 'Downloads')
  const filePath = path.join(tempDir, 'note.txt')

  fs.mkdirSync(childDir)
  fs.mkdirSync(nestedDir)
  fs.mkdirSync(hiddenDir)
  fs.mkdirSync(downloadsDir)
  fs.writeFileSync(filePath, 'hello')

  const payload = listDirectoryPickerTree({ path: tempDir })

  assert.equal(payload.path, tempDir)
  assert.equal(payload.items.some((item) => item.path === childDir), true)
  assert.equal(payload.items.some((item) => item.path === nestedDir), true)
  assert.equal(payload.items.some((item) => item.path === hiddenDir), false)
  assert.equal(payload.items.some((item) => item.path === downloadsDir), false)
  assert.equal(payload.items.some((item) => item.path === filePath), false)
})

test('searchDirectoryPickerEntries returns matching directories only', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-dir-search-'))
  const alphaDir = path.join(tempDir, 'alpha-project')
  const betaDir = path.join(tempDir, 'beta-notes')
  const hiddenAlphaDir = path.join(tempDir, '.alpha-hidden')
  const alphaFile = path.join(tempDir, 'alpha-project.txt')

  fs.mkdirSync(alphaDir)
  fs.mkdirSync(betaDir)
  fs.mkdirSync(hiddenAlphaDir)
  fs.writeFileSync(alphaFile, 'hello')

  const payload = searchDirectoryPickerEntries({
    path: tempDir,
    query: 'alpha',
  })

  assert.equal(payload.items.some((item) => item.path === alphaDir), true)
  assert.equal(payload.items.some((item) => item.path === betaDir), false)
  assert.equal(payload.items.some((item) => item.path === hiddenAlphaDir), false)
  assert.equal(payload.items.some((item) => item.path === alphaFile), false)
})

test('createDirectoryPickerDirectory creates a new child directory and rejects duplicates', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-dir-create-'))

  const created = createDirectoryPickerDirectory({
    path: tempDir,
    name: 'project-new',
  })

  assert.equal(created.path, path.join(tempDir, 'project-new'))
  assert.equal(fs.existsSync(created.path), true)

  assert.throws(() => {
    createDirectoryPickerDirectory({
      path: tempDir,
      name: 'project-new',
    })
  }, /目录已存在/)
})
