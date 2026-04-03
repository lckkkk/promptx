import test from 'node:test'
import assert from 'node:assert/strict'
import { parseProcessDetailTextBlocks, sanitizeProcessDetailText } from './processDetailBlocks.js'

test('sanitizeProcessDetailText strips ansi sequences and control output', () => {
  const value = sanitizeProcessDetailText('\u001b[31merror\u001b[0m\n\u001b[2Kdone')
  assert.equal(value, 'error\ndone')
})

test('parseProcessDetailTextBlocks parses xml-like directory output', () => {
  const blocks = parseProcessDetailTextBlocks([
    'read: /tmp/project/src',
    '',
    '<path>/tmp/project/src</path>',
    '<type>directory</type>',
    '<entries>',
    'base.js',
    'hooks/',
    '(2 entries)',
    '</entries>',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'meta')
  assert.deepEqual(blocks[0]?.items, [{ label: 'read', value: '/tmp/project/src' }])
  assert.equal(blocks[1]?.type, 'directory_list')
  assert.equal(blocks[1]?.path, '/tmp/project/src')
  assert.equal(blocks[1]?.entryType, 'directory')
  assert.deepEqual(blocks[1]?.entries, ['base.js', 'hooks/'])
})

test('parseProcessDetailTextBlocks keeps grep snippets with line numbers as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    'Grep: /tmp/project/file.js',
    '',
    '473:function startFocusFollow(index, options = {}) {',
    '535:function placeCursor(index, position = null, options = {}) {',
    '644:  nextTick(() => placeCursor(index, 0))',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'meta')
  assert.equal(blocks[1]?.type, 'text')
  assert.match(blocks[1]?.text || '', /473:function startFocusFollow/)
})

test('parseProcessDetailTextBlocks keeps ripgrep-like search output as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    'apps/web/src/lib/i18n.js:126:      relay: {',
    "apps/web/src/lib/i18n.js:132:        relayUrl: 'Relay 地址',",
    "apps/web/src/lib/i18n.js:149:        relayConfigLoadFailed: '远程访问配置读取失败。',",
    "apps/server/src/relayServer.js:264:  <form class=\"card\" action=\"/relay/admin/login\" method=\"post\">",
    "apps/server/src/relayServer.js:272:    <div class=\"hint\">可通过环境变量 <code>PROMPTX_RELAY_ADMIN_TOKEN</code> 配置。</div>",
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text || '', /apps\/web\/src\/lib\/i18n\.js:126:/)
  assert.match(blocks[0]?.text || '', /apps\/server\/src\/relayServer\.js:264:/)
})

test('parseProcessDetailTextBlocks keeps single ripgrep match as text', () => {
  const blocks = parseProcessDetailTextBlocks(
    "apps/web/src/lib/i18n.js:132:        relayUrl: 'Relay 地址',"
  )

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text || '', /i18n\.js:132:/)
})

test('parseProcessDetailTextBlocks keeps build failure code frames as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    'Build failed with 1 error:',
    '',
    '[MISSING_EXPORT] Error:',
    '"Sonner" is not exported by "web/src/components/ui/sonner/index.js".',
    '╭─[ web/src/App.vue:13:10 ]',
    '│',
    "13 │ import { Sonner } from '@/components/ui/sonner'",
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text || '', /\[MISSING_EXPORT\] Error:/)
  assert.match(blocks[0]?.text || '', /web\/src\/App\.vue:13:10/)
})

test('parseProcessDetailTextBlocks keeps shell-like command text as text', () => {
  const blocks = parseProcessDetailTextBlocks('/bin/zsh -lc "pnpm --filter web exec node --test src/composables/useCodexSessionPanel.test.js"')

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text, /pnpm --filter web/)
})

test('parseProcessDetailTextBlocks keeps diff stat output as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    'apps/web/src/components/ProcessDetailRenderer.vue  |  77 ++++++++-',
    'apps/web/src/lib/processDetailBlocks.js            | 176 ++++++++++++++++++++-',
    '6 files changed, 510 insertions(+), 25 deletions(-)',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text, /files changed/)
})

test('parseProcessDetailTextBlocks keeps git status output as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    'M apps/web/src/components/ProcessDetailRenderer.vue',
    'M apps/web/src/composables/codexSessionPanelTurns.js',
    '?? apps/web/src/lib/processDetailBlocks.test.js',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text, /ProcessDetailRenderer/)
})

test('parseProcessDetailTextBlocks keeps prose with inline flags as text', () => {
  const blocks = parseProcessDetailTextBlocks('这里的 --filter 只是说明文字，不应该被识别成终端代码。')

  assert.equal(blocks[0]?.type, 'text')
})

test('parseProcessDetailTextBlocks keeps workspace build logs as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    '@muyichengshayu/promptx@0.1.30 build',
    '/Users/bravf/code/promptx',
    'pnpm -r build',
    '',
    'Scope: 5 of 6 workspace projects',
    'apps/zentao-extension build$ node --check background.js && node --check content.js',
    'packages/shared build: shared: nothing to build',
    'packages/shared build: Done',
    'apps/web build$ vite build',
    'apps/web build: vite v5.4.21 building for production...',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text, /pnpm -r build/)
})

test('parseProcessDetailTextBlocks keeps unified diff output as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    'diff --git a/apps/web/src/components/CodexSessionPanel.vue b/apps/web/src/components/CodexSessionPanel.vue',
    'index 32ba088..78ca751 100644',
    '--- a/apps/web/src/components/CodexSessionPanel.vue',
    '+++ b/apps/web/src/components/CodexSessionPanel.vue',
    '@@ -391,7 +391,7 @@ defineExpose({',
    '-                    class=\"old\"',
    '+                    class=\"new\"',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text, /^diff --git/m)
})

test('parseProcessDetailTextBlocks keeps mixed prose and terminal output together as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    '准备开始构建，先看一下当前输出。',
    '',
    '/bin/zsh -lc "pnpm build"',
    'apps/web build$ vite build',
    'apps/web build: transforming...',
    '',
    '构建结束后继续检查。',
  ].join('\n'))

  assert.deepEqual(blocks.map((block) => block.type), ['text'])
  assert.match(blocks[0]?.text || '', /vite build/)
})

test('parseProcessDetailTextBlocks keeps leading indentation in mixed content code blocks', () => {
  const blocks = parseProcessDetailTextBlocks([
    '下面是需要保留缩进的片段：',
    '',
    '    if (value) {',
    '      console.log(value)',
    '    }',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.equal(blocks[0]?.text, [
    '下面是需要保留缩进的片段：',
    '',
    '    if (value) {',
    '      console.log(value)',
    '    }',
  ].join('\n'))
})

test('parseProcessDetailTextBlocks keeps html-like command output as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    '</div>',
    '',
    '  <div v-else-if="block.type === \'bullet_list\'" class="process-detail-panel">',
    '    <ul class="list-disc space-y-1.5 pl-5">',
    '      <li>{{ item }}</li>',
    '    </ul>',
    '  </div>',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text || '', /<div v-else-if=/)
})

test('parseProcessDetailTextBlocks keeps numbered lines as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    '1-# Repository Guidelines',
    '2-',
    '3-## 沟通约定',
    '4-',
    '5-- 这个项目后续默认使用中文沟通。',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text || '', /1-# Repository Guidelines/)
})

test('parseProcessDetailTextBlocks keeps spaced numbered source lines as text', () => {
  const blocks = parseProcessDetailTextBlocks([
    '618\t    line-height: 1.5;',
    '',
    '619\t    word-break: break-all;',
    '',
    '620\t  }',
    '',
    '621',
    '',
    '622\t  .process-detail-code {',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'text')
  assert.match(blocks[0]?.text || '', /618\t    line-height: 1\.5;/)
})

test('parseProcessDetailTextBlocks parses checklist', () => {
  const blocks = parseProcessDetailTextBlocks([
    '[x] 梳理现有实现',
    '[ ] 设计 detailBlocks',
    '[ ] 重做渲染组件',
  ].join('\n'))

  assert.equal(blocks[0]?.type, 'checklist')
  assert.deepEqual(blocks[0]?.items, [
    { completed: true, text: '梳理现有实现' },
    { completed: false, text: '设计 detailBlocks' },
    { completed: false, text: '重做渲染组件' },
  ])
})
