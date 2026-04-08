import process from 'node:process'
import readline from 'node:readline'

import {
  addUser,
  hasUsersConfigured,
  readUsersConfig,
  removeUser,
  resetUserPassword,
} from '../apps/server/src/usersConfig.js'

function printHelp() {
  console.log(`
PromptX 用户管理 CLI

用法：
  promptx user add <username>                  添加用户（交互式输入密码）
  promptx user list                            列出所有用户
  promptx user remove <username>               删除用户
  promptx user reset-password <username>       重置密码（交互式输入）
`.trim())
}

function promptPassword(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    })

    process.stderr.write(promptText)

    let password = ''

    // 隐藏密码输入（仅在 TTY 环境下）
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
    }

    process.stdin.resume()

    const onData = (char) => {
      const c = char.toString()
      if (c === '\n' || c === '\r' || c === '\u0004') {
        // Enter 或 Ctrl+D
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false)
        }
        process.stderr.write('\n')
        process.stdin.removeListener('data', onData)
        rl.close()
        resolve(password)
      } else if (c === '\u0003') {
        // Ctrl+C
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false)
        }
        process.stderr.write('\n')
        process.stdin.removeListener('data', onData)
        rl.close()
        process.exit(1)
      } else if (c === '\u007f' || c === '\b') {
        // 退格
        if (password.length > 0) {
          password = password.slice(0, -1)
        }
      } else {
        password += c
      }
    }

    if (process.stdin.isTTY) {
      process.stdin.on('data', onData)
    } else {
      // 非 TTY 环境（管道输入），直接读取一行
      rl.question('', (line) => {
        rl.close()
        resolve(line.trim())
      })
    }
  })
}

async function promptConfirmPassword() {
  const password1 = await promptPassword('输入密码：')
  if (!password1) throw new Error('密码不能为空')
  const password2 = await promptPassword('再次输入密码：')
  if (password1 !== password2) {
    throw new Error('两次输入的密码不一致')
  }
  return password1
}

function printUserList() {
  const { users } = readUsersConfig()
  if (!users.length) {
    console.log('[promptx-user] 当前无已配置用户')
    console.log('提示：使用 "promptx user add <username>" 添加用户')
    return
  }
  console.log(`[promptx-user] 已配置 ${users.length} 个用户：`)
  users.forEach((user, index) => {
    const passwordStatus = user.passwordHash ? '已设密码' : '无密码'
    const displayName = user.displayName && user.displayName !== user.username
      ? ` (${user.displayName})`
      : ''
    console.log(`  ${index + 1}. ${user.username}${displayName} - ${passwordStatus}`)
  })
  if (!hasUsersConfigured()) {
    console.log('')
    console.log('提示：添加至少一个用户后，多用户模式将自动启用')
  }
}

async function cmdAdd(username, extraArgs) {
  if (!username) {
    throw new Error('请提供用户名，例如：promptx user add alice')
  }
  const displayNameIdx = extraArgs.indexOf('--display-name')
  const displayName = displayNameIdx >= 0 ? String(extraArgs[displayNameIdx + 1] || '').trim() : ''

  const password = await promptConfirmPassword()

  const user = addUser(username, password, displayName)
  console.log(`[promptx-user] 已添加用户：${user.username}`)
  if (user.displayName && user.displayName !== user.username) {
    console.log(`  显示名：${user.displayName}`)
  }
  console.log('  密码：已设置')
  console.log('')
  console.log('登录已切换为账号密码模式。')
}

async function cmdResetPassword(username) {
  if (!username) {
    throw new Error('请提供用户名，例如：promptx user reset-password alice')
  }

  const password = await promptConfirmPassword()
  resetUserPassword(username, password)
  console.log(`[promptx-user] 已重置用户 "${username}" 的密码`)
  console.log('  新密码：已设置')
}

function cmdRemove(username) {
  if (!username) {
    throw new Error('请提供用户名，例如：promptx user remove alice')
  }
  removeUser(username)
  console.log(`[promptx-user] 已删除用户：${username}`)
  const { users } = readUsersConfig()
  console.log(`当前剩余 ${users.length} 个用户。`)
}

async function main() {
  const action = String(process.argv[2] || '').trim()
  const username = String(process.argv[3] || '').trim()
  const extraArgs = process.argv.slice(4)

  if (!action || action === 'help' || action === '--help' || action === '-h') {
    printHelp()
    return
  }

  if (!['add', 'list', 'remove', 'reset-password'].includes(action)) {
    throw new Error(`不支持的用户管理命令：${action}`)
  }

  if (action === 'list') {
    printUserList()
    return
  }

  if (action === 'remove') {
    cmdRemove(username)
    return
  }

  if (action === 'add') {
    await cmdAdd(username, extraArgs)
    return
  }

  if (action === 'reset-password') {
    await cmdResetPassword(username)
    return
  }
}

try {
  await main()
} catch (error) {
  console.error(`[promptx-user] ${error.message || error}`)
  process.exitCode = 1
}
