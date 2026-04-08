import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_ENGINES } from '../../../../packages/shared/src/index.js'
import { getAgentSlashCommands, searchAgentSlashCommands } from './agentSlashCommands.js'

test('getAgentSlashCommands returns engine-specific commands', () => {
  const commands = getAgentSlashCommands(AGENT_ENGINES.CLAUDE_CODE)
  assert.ok(commands.length > 0)
  assert.ok(commands.every((item) => item.engine === AGENT_ENGINES.CLAUDE_CODE))
  assert.ok(commands.some((item) => item.command === 'permissions'))
})

test('searchAgentSlashCommands prioritizes exact and prefix matches', () => {
  const commands = searchAgentSlashCommands(AGENT_ENGINES.CODEX, 'mo')
  assert.equal(commands[0]?.command, 'model')

  const exact = searchAgentSlashCommands(AGENT_ENGINES.CODEX, 'approval')
  assert.equal(exact[0]?.command, 'approval')
})

