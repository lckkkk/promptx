import process from 'node:process'

import {
  addRelayTenant,
  listRelayTenants,
  removeRelayTenant,
} from '../apps/server/src/relayTenants.js'

const DEFAULT_RELAY_TENANTS_FILE = '/etc/promptx-relay-tenants.json'

function printHelp() {
  console.log(`
PromptX Relay Tenant CLI

用法：
  promptx relay tenant add <key>
  promptx relay tenant list
  promptx relay tenant remove <key>
  promptx relay tenant add <key> --domain promptx.mushayu.com
  promptx relay tenant add <key> --host user1.promptx.mushayu.com

可选参数：
  --config <path>      Relay 租户配置文件路径，默认读 PROMPTX_RELAY_TENANTS_FILE，再回落到 /etc/promptx-relay-tenants.json
  --domain <domain>    自动生成 <key>.<domain>，默认读 PROMPTX_RELAY_BASE_DOMAIN
  --host <host>        直接指定完整子域名
  --device-id <id>     设备 ID，默认 <key>-mac
  --device-token <v>   手动指定设备 token
  --access-token <v>   手动指定访问口令
`.trim())
}

function readOption(args, name) {
  const index = args.indexOf(name)
  if (index < 0) {
    return ''
  }
  return String(args[index + 1] || '').trim()
}

function resolveConfigPath(extraArgs) {
  return readOption(extraArgs, '--config')
    || String(process.env.PROMPTX_RELAY_TENANTS_FILE || '').trim()
    || DEFAULT_RELAY_TENANTS_FILE
}

function printTenantList(filePath) {
  const result = listRelayTenants(filePath)
  console.log(`[promptx-relay] 当前租户配置文件：${result.path}`)
  if (!result.tenants.length) {
    console.log('- 暂无租户')
    return
  }

  result.tenants.forEach((tenant, index) => {
    console.log(`${index + 1}. ${tenant.key}`)
    console.log(`   host: ${tenant.host}`)
    console.log(`   deviceId: ${tenant.deviceId}`)
  })
}

function main() {
  const action = String(process.argv[2] || '').trim()
  const key = String(process.argv[3] || '').trim()
  const extraArgs = process.argv.slice(4)

  if (!action || action === 'help' || action === '--help' || action === '-h') {
    printHelp()
    return
  }

  if (!['add', 'list', 'remove'].includes(action)) {
    throw new Error(`不支持的 relay tenant 命令：${action}`)
  }

  const filePath = resolveConfigPath(extraArgs)

  if (action === 'list') {
    printTenantList(filePath)
    return
  }

  if (!key && !readOption(extraArgs, '--host')) {
    throw new Error(`请提供租户 key，例如：promptx relay tenant ${action} user1`)
  }

  const domain = readOption(extraArgs, '--domain')
    || String(process.env.PROMPTX_RELAY_BASE_DOMAIN || '').trim()
  const host = readOption(extraArgs, '--host')

  if (action === 'remove') {
    const result = removeRelayTenant({
      filePath,
      key,
      host,
    })
    console.log(`[promptx-relay] 已更新租户配置：${result.path}`)
    console.log(`[promptx-relay] 当前剩余 ${result.tenants.length} 个租户`)
    return
  }

  const result = addRelayTenant({
    filePath,
    key,
    domain,
    host,
    fallbackDomain: process.env.PROMPTX_RELAY_PUBLIC_URL,
    fallbackHost: process.env.PROMPTX_RELAY_PUBLIC_URL,
    deviceId: readOption(extraArgs, '--device-id'),
    deviceToken: readOption(extraArgs, '--device-token'),
    accessToken: readOption(extraArgs, '--access-token'),
  })

  console.log(`[promptx-relay] 已写入租户配置：${result.path}`)
  console.log(`- key: ${result.tenant.key}`)
  console.log(`- host: ${result.tenant.host}`)
  console.log(`- deviceId: ${result.tenant.deviceId}`)
  console.log(`- deviceToken: ${result.tenant.deviceToken}`)
  console.log(`- accessToken: ${result.tenant.accessToken}`)
  console.log('')
  console.log('本地 PromptX 可直接填写：')
  console.log(`- Relay 地址: https://${result.tenant.host}`)
  console.log(`- 设备 ID: ${result.tenant.deviceId}`)
  console.log(`- 设备 Token: ${result.tenant.deviceToken}`)
  console.log('')
  console.log('如果云端 relay 正在运行，修改配置文件后记得重启 relay。')
}

try {
  main()
} catch (error) {
  console.error(`[promptx-relay] ${error.message || error}`)
  process.exitCode = 1
}
