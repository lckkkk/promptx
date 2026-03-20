import MarkdownIt from 'markdown-it'

const markdown = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
})

const defaultLinkOpenRule = markdown.renderer.rules.link_open
const defaultTableOpenRule = markdown.renderer.rules.table_open
const defaultTableCloseRule = markdown.renderer.rules.table_close

markdown.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx]
  token.attrSet('target', '_blank')
  token.attrSet('rel', 'noreferrer noopener')

  if (typeof defaultLinkOpenRule === 'function') {
    return defaultLinkOpenRule(tokens, idx, options, env, self)
  }

  return self.renderToken(tokens, idx, options)
}

markdown.renderer.rules.table_open = (tokens, idx, options, env, self) => {
  const rendered = typeof defaultTableOpenRule === 'function'
    ? defaultTableOpenRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)

  return `<div class="codex-table-wrap">${rendered}`
}

markdown.renderer.rules.table_close = (tokens, idx, options, env, self) => {
  const rendered = typeof defaultTableCloseRule === 'function'
    ? defaultTableCloseRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options)

  return `${rendered}</div>`
}

export function renderCodexMarkdown(value = '') {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }

  return markdown.render(text)
}
