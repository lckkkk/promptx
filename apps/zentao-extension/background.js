const APP_ORIGIN = 'http://localhost:5173'
const API_ORIGIN = 'http://localhost:3000'

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'CREATE_TMPPROMPT_FROM_ZENTAO') {
    return false
  }

  createTmppromptDocument(message.payload)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error.message || '生成 TmpPrompt 链接失败。' }))

  return true
})

async function readJson(response) {
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(payload.message || '请求失败。')
  }
  return payload
}

function getFileNameFromUrl(url = '', mimeType = '') {
  const fallbackExt = (() => {
    if (mimeType.includes('png')) return 'png'
    if (mimeType.includes('webp')) return 'webp'
    if (mimeType.includes('gif')) return 'gif'
    return 'jpg'
  })()

  try {
    const parsed = new URL(url)
    const lastSegment = parsed.pathname.split('/').filter(Boolean).pop() || ''
    const safeName = lastSegment.replace(/[^a-zA-Z0-9._-]/g, '-')
    if (safeName && /\.[a-zA-Z0-9]+$/.test(safeName)) {
      return safeName
    }
    if (safeName) {
      return `${safeName}.${fallbackExt}`
    }
  } catch {}

  return `zentao-image.${fallbackExt}`
}

function buildDocumentContent(payload = {}) {
  const lines = []

  if (Array.isArray(payload.metaPairs) && payload.metaPairs.length) {
    lines.push('基本信息：')
    payload.metaPairs.forEach((item) => {
      lines.push(`- ${item.label}：${item.value}`)
    })
    lines.push('')
  }

  if (Array.isArray(payload.sections)) {
    payload.sections.forEach((section) => {
      if (!section?.title || !section.content) {
        return
      }
      lines.push(`${section.title}：`, section.content, '')
    })
  }

  if (payload.mainContent) {
    lines.push('正文内容：', payload.mainContent, '')
  }

  if (Array.isArray(payload.comments) && payload.comments.length) {
    lines.push('评论 / 处理记录：')
    payload.comments.forEach((item, index) => {
      const title = item?.title ? `${index + 1}. ${item.title}` : `${index + 1}.`
      lines.push(title)
      if (item?.content) {
        lines.push(item.content)
      }
      lines.push('')
    })
  }

  if (Array.isArray(payload.attachments) && payload.attachments.length) {
    lines.push('附件 / 关联链接：')
    payload.attachments.forEach((item) => {
      const label = item.label ? `${item.label}：` : ''
      lines.push(`- ${label}${item.url}`)
    })
    lines.push('')
  }

  if (payload.pageExcerpt) {
    lines.push('页面摘录：', payload.pageExcerpt, '')
  }

  const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!content) {
    throw new Error('没有提取到可用内容。')
  }

  return content
}

function buildBlocksFromPayload(payload = {}) {
  const source = Array.isArray(payload.blocks) ? payload.blocks : []
  const blocks = source
    .map((block) => {
      if (!block || !block.content) {
        return null
      }
      if (block.type === 'image') {
        return {
          type: 'image',
          content: String(block.content).trim(),
          meta: {},
        }
      }
      return {
        type: 'text',
        content: String(block.content).trim(),
        meta: {},
      }
    })
    .filter(Boolean)

  if (blocks.length) {
    return blocks
  }

  const fallbackContent = buildDocumentContent(payload)
  return [
    {
      type: 'text',
      content: fallbackContent,
      meta: {},
    },
  ]
}

async function transferImageToTmpprompt(settings, imageUrl) {
  const sourceResponse = await fetch(imageUrl, {
    credentials: 'include',
  })

  if (!sourceResponse.ok) {
    throw new Error(`抓取禅道图片失败：${sourceResponse.status}`)
  }

  const blob = await sourceResponse.blob()
  const formData = new FormData()
  formData.append('file', blob, getFileNameFromUrl(imageUrl, blob.type || ''))

  const uploaded = await fetch(`${settings.apiOrigin}/api/uploads`, {
    method: 'POST',
    body: formData,
  }).then(readJson)

  return uploaded.url
}

async function normalizeBlocksWithHostedImages(settings, blocks = []) {
  const normalized = []

  for (const block of blocks) {
    if (!block || !block.content) {
      continue
    }

    if (block.type !== 'image') {
      normalized.push(block)
      continue
    }

    try {
      const hostedUrl = await transferImageToTmpprompt(settings, block.content)
      normalized.push({
        ...block,
        content: hostedUrl,
      })
    } catch (error) {
      normalized.push(block)
    }
  }

  return normalized
}

async function createTmppromptDocument(payload = {}) {
  const title = String(payload.title || '').trim() || '禅道 Bug'
  const blocks = await normalizeBlocksWithHostedImages(
    {
      appOrigin: APP_ORIGIN,
      apiOrigin: API_ORIGIN,
    },
    buildBlocksFromPayload(payload)
  )

  const created = await fetch(`${API_ORIGIN}/api/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      expiry: '24h',
      visibility: 'listed',
    }),
  }).then(readJson)

  await fetch(`${API_ORIGIN}/api/documents/${created.slug}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      expiry: '24h',
      visibility: 'listed',
      blocks,
    }),
  }).then(readJson)

  const publicUrl = `${APP_ORIGIN}/p/${created.slug}`
  const rawUrl = `${API_ORIGIN}/p/${created.slug}/raw`

  return {
    publicUrl,
    rawUrl,
    editUrl: `${APP_ORIGIN}/edit/${created.slug}`,
    promptText: `请先阅读这个需求文档，再继续开发：\n${rawUrl}`,
  }
}
