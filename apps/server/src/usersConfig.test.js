import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('users config requires password-backed accounts for login readiness', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-users-config-'))
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  process.env.PROMPTX_DATA_DIR = tempDir

  try {
    const usersConfig = await import(`./usersConfig.js?test=${Date.now()}`)
    const {
      addUser,
      hasUsersConfigured,
      validateUserCredentials,
      writeUsersConfig,
    } = usersConfig

    writeUsersConfig({
      users: [
        {
          username: 'default',
          passwordHash: '',
          displayName: 'default',
        },
      ],
    })

    assert.equal(hasUsersConfigured(), false)
    assert.equal(validateUserCredentials('default', ''), false)
    assert.throws(() => addUser('alice', ''), /密码不能为空/)

    addUser('alice', 'secret123')
    assert.equal(hasUsersConfigured(), true)
    assert.equal(validateUserCredentials('alice', 'secret123'), true)
    assert.equal(validateUserCredentials('alice', ''), false)
  } finally {
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
