import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  addRelayTenant,
  inferBaseDomainFromHost,
  inferRelayTenantDomain,
  listRelayTenants,
  normalizeHost,
  normalizeTenantKey,
  readRelayTenantsFile,
  removeRelayTenant,
  resolveTenantHost,
} from './relayTenants.js'

test('normalizeTenantKey keeps only safe slug characters', () => {
  assert.equal(normalizeTenantKey(' User_One '), 'user-one')
  assert.equal(normalizeTenantKey('a---b'), 'a-b')
})

test('normalizeHost strips protocol and path', () => {
  assert.equal(normalizeHost('https://User1.PromptX.mushayu.com/path?a=1'), 'user1.promptx.mushayu.com')
})

test('resolveTenantHost combines key and domain when host is omitted', () => {
  assert.equal(resolveTenantHost({ key: 'user1', domain: 'promptx.mushayu.com' }), 'user1.promptx.mushayu.com')
  assert.equal(resolveTenantHost({ key: 'user1', host: 'https://custom.promptx.mushayu.com' }), 'custom.promptx.mushayu.com')
})

test('inferBaseDomainFromHost keeps root domain after removing first label', () => {
  assert.equal(inferBaseDomainFromHost('user1.promptx.mushayu.com'), 'promptx.mushayu.com')
  assert.equal(inferBaseDomainFromHost('promptx.mushayu.com'), 'mushayu.com')
})

test('addRelayTenant writes host and generated tokens to file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-tenants-'))
  const filePath = path.join(tempDir, 'relay-tenants.json')

  const result = addRelayTenant({
    filePath,
    key: 'user1',
    domain: 'promptx.mushayu.com',
  })

  assert.equal(result.tenant.host, 'user1.promptx.mushayu.com')
  assert.equal(result.tenant.deviceId, 'user1-mac')
  assert.match(result.tenant.deviceToken, /^dev_user1_/) 
  assert.match(result.tenant.accessToken, /^access_user1_/) 

  const saved = readRelayTenantsFile(filePath)
  assert.equal(saved.tenants.length, 1)
  assert.equal(saved.tenants[0].host, 'user1.promptx.mushayu.com')
})

test('inferRelayTenantDomain falls back to existing tenant host when domain is omitted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-tenants-domain-'))
  const filePath = path.join(tempDir, 'relay-tenants.json')

  addRelayTenant({
    filePath,
    key: 'user1',
    domain: 'promptx.mushayu.com',
  })

  assert.equal(inferRelayTenantDomain({ filePath }), 'promptx.mushayu.com')

  const result = addRelayTenant({
    filePath,
    key: 'user2',
  })
  assert.equal(result.tenant.host, 'user2.promptx.mushayu.com')
})

test('inferRelayTenantDomain supports explicit fallback domain from relay public url', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-tenants-fallback-'))
  const filePath = path.join(tempDir, 'relay-tenants.json')

  const result = addRelayTenant({
    filePath,
    key: 'dongdong',
    fallbackDomain: 'https://promptx.mushayu.com',
  })

  assert.equal(result.tenant.host, 'dongdong.promptx.mushayu.com')
})

test('addRelayTenant rejects duplicate tenant key and host', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-tenants-dup-'))
  const filePath = path.join(tempDir, 'relay-tenants.json')

  addRelayTenant({
    filePath,
    key: 'user1',
    domain: 'promptx.mushayu.com',
  })

  assert.throws(() => addRelayTenant({
    filePath,
    key: 'user1',
    domain: 'promptx.mushayu.com',
  }), /租户已存在/)

  assert.throws(() => addRelayTenant({
    filePath,
    key: 'user2',
    host: 'user1.promptx.mushayu.com',
  }), /域名已存在/)
})

test('listRelayTenants and removeRelayTenant update tenant file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-tenants-remove-'))
  const filePath = path.join(tempDir, 'relay-tenants.json')

  addRelayTenant({
    filePath,
    key: 'user1',
    domain: 'promptx.mushayu.com',
  })
  addRelayTenant({
    filePath,
    key: 'user2',
    domain: 'promptx.mushayu.com',
  })

  const listed = listRelayTenants(filePath)
  assert.equal(listed.tenants.length, 2)

  const removed = removeRelayTenant({
    filePath,
    key: 'user1',
  })
  assert.equal(removed.tenants.length, 1)
  assert.equal(removed.tenants[0].key, 'user2')
})
