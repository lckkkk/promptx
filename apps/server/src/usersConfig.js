import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { ensurePromptxStorageReady } from './appPaths.js'

const USERS_CONFIG_FILE = 'users-config.json'

function getUsersConfigPath() {
  const { dataDir } = ensurePromptxStorageReady()
  return path.join(dataDir, USERS_CONFIG_FILE)
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    const inputHash = crypto.scryptSync(password, salt, 64).toString('hex')
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(inputHash, 'hex'))
  } catch {
    return false
  }
}

function normalizeUser(input = {}) {
  return {
    username: String(input?.username || '').trim().toLowerCase(),
    passwordHash: String(input?.passwordHash || '').trim(),
    displayName: String(input?.displayName || input?.username || '').trim(),
  }
}

export function readUsersConfig() {
  const filePath = getUsersConfigPath()
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    const users = Array.isArray(payload?.users) ? payload.users.map(normalizeUser).filter((u) => u.username) : []
    return { users }
  } catch {
    return { users: [] }
  }
}

export function writeUsersConfig(config = {}) {
  const filePath = getUsersConfigPath()
  const users = Array.isArray(config?.users) ? config.users.map(normalizeUser).filter((u) => u.username) : []
  fs.writeFileSync(filePath, `${JSON.stringify({ users }, null, 2)}\n`, 'utf8')
  return { users }
}

export function getUserByUsername(username) {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  if (!normalizedUsername) return null
  const { users } = readUsersConfig()
  return users.find((u) => u.username === normalizedUsername) || null
}

export function validateUserCredentials(username, password) {
  const user = getUserByUsername(username)
  if (!user) return false
  if (!user.passwordHash) return false
  if (!String(password || '').trim()) return false
  return verifyPassword(String(password || ''), user.passwordHash)
}

export function hasUsersConfigured() {
  const { users } = readUsersConfig()
  return users.some((user) => user.username && user.passwordHash)
}

export function addUser(username, password, displayName = '') {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  if (!normalizedUsername) throw new Error('用户名不能为空')
  const normalizedPassword = String(password || '')
  if (!normalizedPassword.trim()) throw new Error('密码不能为空，必须使用账户密码登录')
  const config = readUsersConfig()
  if (config.users.find((u) => u.username === normalizedUsername)) {
    throw new Error(`用户 "${normalizedUsername}" 已存在`)
  }
  const passwordHash = hashPassword(normalizedPassword)
  const newUser = normalizeUser({ username: normalizedUsername, passwordHash, displayName: displayName || normalizedUsername })
  config.users.push(newUser)
  writeUsersConfig(config)
  return newUser
}

export function removeUser(username) {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  const config = readUsersConfig()
  const index = config.users.findIndex((u) => u.username === normalizedUsername)
  if (index === -1) throw new Error(`用户 "${normalizedUsername}" 不存在`)
  config.users.splice(index, 1)
  writeUsersConfig(config)
}

export function resetUserPassword(username, newPassword) {
  const normalizedUsername = String(username || '').trim().toLowerCase()
  const normalizedPassword = String(newPassword || '')
  if (!normalizedPassword.trim()) throw new Error('密码不能为空，必须使用账户密码登录')
  const config = readUsersConfig()
  const user = config.users.find((u) => u.username === normalizedUsername)
  if (!user) throw new Error(`用户 "${normalizedUsername}" 不存在`)
  user.passwordHash = hashPassword(normalizedPassword)
  writeUsersConfig(config)
}
