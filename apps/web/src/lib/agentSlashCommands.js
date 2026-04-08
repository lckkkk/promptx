import {
  AGENT_ENGINES,
  normalizeAgentEngine,
} from '../../../../packages/shared/src/index.js'

const AGENT_SLASH_COMMANDS = {
  [AGENT_ENGINES.CODEX]: [
    { command: 'help', aliases: ['docs'], description: '查看 Codex 可用命令与快捷入口。' },
    { command: 'status', aliases: ['state'], description: '查看当前会话、模型与运行状态。' },
    { command: 'model', aliases: [], description: '切换或查看当前使用的模型。' },
    { command: 'approval', aliases: ['approvals'], description: '调整审批策略与执行权限。' },
    { command: 'sandbox', aliases: [], description: '查看或切换沙箱访问级别。' },
    { command: 'compact', aliases: ['summarize'], description: '压缩上下文，保留重点继续执行。' },
    { command: 'diff', aliases: ['patch'], description: '查看当前改动摘要或 diff。' },
    { command: 'clear', aliases: ['reset'], description: '清空当前对话输入上下文。' },
    { command: 'new', aliases: ['thread'], description: '开启新的会话线程。' },
  ],
  [AGENT_ENGINES.CLAUDE_CODE]: [
    { command: 'help', aliases: ['docs'], description: '查看 Claude Code 命令帮助。' },
    { command: 'status', aliases: ['state'], description: '查看当前会话与运行状态。' },
    { command: 'model', aliases: [], description: '切换或查看当前模型。' },
    { command: 'permissions', aliases: ['permission'], description: '查看或调整权限设置。' },
    { command: 'compact', aliases: ['summarize'], description: '压缩上下文，减少对话体积。' },
    { command: 'clear', aliases: ['reset'], description: '清空当前输入上下文。' },
    { command: 'review', aliases: ['code-review'], description: '进入代码审查相关流程。' },
    { command: 'memory', aliases: [], description: '查看或维护记忆内容。' },
    { command: 'cost', aliases: ['usage'], description: '查看本次会话成本或用量。' },
  ],
  [AGENT_ENGINES.OPENCODE]: [
    { command: 'help', aliases: ['docs'], description: '查看 OpenCode 支持的命令。' },
    { command: 'status', aliases: ['state'], description: '查看当前会话与运行状态。' },
    { command: 'model', aliases: [], description: '切换或查看当前模型。' },
    { command: 'theme', aliases: [], description: '调整终端主题或展示风格。' },
    { command: 'diff', aliases: ['patch'], description: '查看当前改动与 patch。' },
    { command: 'init', aliases: ['bootstrap'], description: '初始化当前工作目录。' },
    { command: 'clear', aliases: ['reset'], description: '清空当前输入上下文。' },
    { command: 'new', aliases: ['thread'], description: '开启新的会话线程。' },
    { command: 'agents', aliases: ['agent'], description: '查看或调用多代理相关能力。' },
  ],
}

function normalizeSlashQuery(query = '') {
  return String(query || '').trim().toLowerCase()
}

function scoreCommand(item, query = '') {
  const normalizedQuery = normalizeSlashQuery(query)
  if (!normalizedQuery) {
    return 0
  }

  const command = String(item.command || '').toLowerCase()
  const aliases = Array.isArray(item.aliases) ? item.aliases.map((alias) => String(alias || '').toLowerCase()) : []
  const haystacks = [command, ...aliases]

  if (command === normalizedQuery) {
    return 100
  }
  if (aliases.includes(normalizedQuery)) {
    return 90
  }
  if (command.startsWith(normalizedQuery)) {
    return 80
  }
  if (aliases.some((alias) => alias.startsWith(normalizedQuery))) {
    return 70
  }
  if (command.includes(normalizedQuery)) {
    return 60
  }
  if (haystacks.some((value) => value.includes(normalizedQuery))) {
    return 50
  }
  return -1
}

export function getAgentSlashCommands(engine = AGENT_ENGINES.CODEX) {
  const normalizedEngine = normalizeAgentEngine(engine)
  return (AGENT_SLASH_COMMANDS[normalizedEngine] || []).map((item) => ({
    ...item,
    engine: normalizedEngine,
  }))
}

export function searchAgentSlashCommands(engine = AGENT_ENGINES.CODEX, query = '') {
  return getAgentSlashCommands(engine)
    .map((item) => ({
      ...item,
      score: scoreCommand(item, query),
    }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score
      }
      return String(left.command || '').localeCompare(String(right.command || ''))
    })
}

