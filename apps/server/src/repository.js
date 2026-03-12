import { customAlphabet } from 'nanoid'
import {
  BLOCK_TYPES,
  buildRawText,
  clampText,
  deriveTitleFromBlocks,
  getExpiryValue,
  normalizeExpiry,
  normalizeVisibility,
  resolveExpiresAt,
  slugifyTitle,
  summarizeDocument,
} from '@tmpprompt/shared'
import { all, get, run, transaction } from './db.js'

const slugTail = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 6)
const tokenId = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 20)

function toBlock(row) {
  return {
    id: Number(row.id),
    type: row.type,
    content: row.content,
    sortOrder: Number(row.sort_order),
    meta: JSON.parse(row.meta_json || '{}'),
  }
}

function toDocument(row, blocks = []) {
  const displayTitle = row.title || deriveTitleFromBlocks(blocks)
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    displayTitle,
    visibility: row.visibility,
    expiresAt: row.expires_at,
    expiry: getExpiryValue(row.expires_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blocks,
  }
}

function ensureSlug(title) {
  const base = slugifyTitle(title)
  let slug = `${base}-${slugTail()}`
  while (get('SELECT 1 FROM documents WHERE slug = ?', [slug])) {
    slug = `${base}-${slugTail()}`
  }
  return slug
}

function isExpired(document) {
  return Boolean(document.expiresAt && new Date(document.expiresAt).getTime() <= Date.now())
}

function loadBlocks(documentId) {
  return all(
    `SELECT id, type, content, sort_order, meta_json
     FROM blocks
     WHERE document_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [documentId]
  ).map(toBlock)
}

function loadBlocksForDocuments(documentIds = []) {
  if (!documentIds.length) {
    return new Map()
  }

  const placeholders = documentIds.map(() => '?').join(', ')
  const rows = all(
    `SELECT document_id, type, content, sort_order, id
     FROM blocks
     WHERE document_id IN (${placeholders})
     ORDER BY document_id ASC, sort_order ASC, id ASC`,
    documentIds
  )

  const grouped = new Map()
  rows.forEach((row) => {
    const documentId = Number(row.document_id)
    if (!grouped.has(documentId)) {
      grouped.set(documentId, [])
    }
    grouped.get(documentId).push({
      type: row.type,
      content: row.content,
    })
  })

  return grouped
}

function loadListMetadata(documentIds = []) {
  if (!documentIds.length) {
    return {
      blockCountByDocumentId: new Map(),
      firstTextByDocumentId: new Map(),
    }
  }

  const placeholders = documentIds.map(() => '?').join(', ')
  const countRows = all(
    `SELECT document_id, COUNT(*) AS block_count
     FROM blocks
     WHERE document_id IN (${placeholders})
     GROUP BY document_id`,
    documentIds
  )
  const firstTextRows = all(
    `SELECT document_id, content
     FROM (
       SELECT
         document_id,
         content,
         ROW_NUMBER() OVER (PARTITION BY document_id ORDER BY sort_order ASC, id ASC) AS row_num
       FROM blocks
       WHERE document_id IN (${placeholders})
         AND type IN (?, ?)
         AND TRIM(content) != ''
     ) ranked
     WHERE row_num = 1`,
    [...documentIds, BLOCK_TYPES.TEXT, BLOCK_TYPES.IMPORTED_TEXT]
  )

  return {
    blockCountByDocumentId: new Map(
      countRows.map((row) => [Number(row.document_id), Number(row.block_count)])
    ),
    firstTextByDocumentId: new Map(
      firstTextRows.map((row) => [Number(row.document_id), row.content || ''])
    ),
  }
}

function collectImagePaths(blocks = []) {
  return blocks
    .filter((block) => block.type === BLOCK_TYPES.IMAGE && block.content)
    .map((block) => block.content)
}

function mapDocumentSummary(row, firstText = '', blockCount = 0) {
  const textBlock = firstText
    ? [{ type: BLOCK_TYPES.TEXT, content: firstText }]
    : []

  return {
    slug: row.slug,
    title: row.title || deriveTitleFromBlocks(textBlock) || '未命名文档',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visibility: row.visibility,
    expiresAt: row.expires_at,
    preview: summarizeDocument({ blocks: textBlock }),
    blockCount,
  }
}

function normalizeBlockInput(block = {}) {
  const type =
    block.type === BLOCK_TYPES.IMAGE
      ? BLOCK_TYPES.IMAGE
      : block.type === BLOCK_TYPES.IMPORTED_TEXT
        ? BLOCK_TYPES.IMPORTED_TEXT
        : BLOCK_TYPES.TEXT
  const content = clampText(
    block.content || '',
    type === BLOCK_TYPES.IMAGE ? 1000 : 50000
  )
  const meta =
    type === BLOCK_TYPES.IMPORTED_TEXT
      ? {
          fileName: clampText(block.meta?.fileName || '', 180),
          collapsed: Boolean(block.meta?.collapsed),
        }
      : {}

  return {
    id: Number.isInteger(Number(block.id)) ? Number(block.id) : null,
    type,
    content,
    meta,
    metaJson: JSON.stringify(meta),
  }
}

export function listDocuments(limit = 30) {
  const now = new Date().toISOString()
  const rows = all(
    `SELECT id, slug, title, visibility, expires_at, created_at, updated_at
     FROM documents
     WHERE visibility = 'listed'
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY created_at DESC
     LIMIT ?`,
    [now, limit]
  )

  const documentIds = rows.map((row) => Number(row.id))
  const {
    blockCountByDocumentId,
    firstTextByDocumentId,
  } = loadListMetadata(documentIds)

  return rows
    .map((row) =>
      mapDocumentSummary(
        row,
        firstTextByDocumentId.get(Number(row.id)) || '',
        blockCountByDocumentId.get(Number(row.id)) || 0
      )
    )
}

export function getDocumentBySlug(slug) {
  const row = get(
    `SELECT id, slug, title, visibility, expires_at, created_at, updated_at
     FROM documents
     WHERE slug = ?`,
    [slug]
  )

  if (!row) {
    return null
  }

  const document = toDocument(row, loadBlocks(row.id))
  return isExpired(document) ? { ...document, expired: true } : document
}

export function createDocument(input = {}) {
  const now = new Date().toISOString()
  const title = clampText(input.title || '', 140)
  const visibility = normalizeVisibility(input.visibility)
  const expiresAt = resolveExpiresAt(normalizeExpiry(input.expiry || '24h'))
  const slug = ensureSlug(title)
  const editToken = tokenId()

  transaction(() => {
    run(
      `INSERT INTO documents (slug, edit_token, title, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [slug, editToken, title, visibility, expiresAt, now, now]
    )
  })

  return {
    ...getDocumentBySlug(slug),
    editToken,
  }
}

export function updateDocument(slug, input = {}) {
  const existing = get('SELECT id, edit_token FROM documents WHERE slug = ?', [slug])
  if (!existing) {
    return { error: 'not_found' }
  }

  const title = clampText(input.title || '', 140)
  const visibility = normalizeVisibility(input.visibility)
  const expiresAt = resolveExpiresAt(normalizeExpiry(input.expiry || '24h'))
  const updatedAt = new Date().toISOString()
  const blocks = Array.isArray(input.blocks) ? input.blocks.map(normalizeBlockInput) : []
  const currentBlocks = loadBlocks(existing.id)
  const currentBlockMap = new Map(currentBlocks.map((block) => [block.id, block]))

  transaction(() => {
    run(
      `UPDATE documents
       SET title = ?, visibility = ?, expires_at = ?, updated_at = ?
       WHERE slug = ?`,
      [title, visibility, expiresAt, updatedAt, slug]
    )

    const incomingIds = new Set()

    blocks.forEach((block, index) => {
      const currentBlock = block.id ? currentBlockMap.get(block.id) : null

      if (currentBlock) {
        incomingIds.add(currentBlock.id)

        const currentMetaJson = JSON.stringify(currentBlock.meta || {})
        const unchanged =
          currentBlock.type === block.type
          && currentBlock.content === block.content
          && currentBlock.sortOrder === index
          && currentMetaJson === block.metaJson

        if (!unchanged) {
          run(
            `UPDATE blocks
             SET type = ?, content = ?, sort_order = ?, meta_json = ?
             WHERE id = ? AND document_id = ?`,
            [block.type, block.content, index, block.metaJson, currentBlock.id, existing.id]
          )
        }
        return
      }

      run(
        `INSERT INTO blocks (document_id, type, content, sort_order, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [existing.id, block.type, block.content, index, block.metaJson, updatedAt]
      )
    })

    currentBlocks.forEach((block) => {
      if (!incomingIds.has(block.id)) {
        run('DELETE FROM blocks WHERE id = ? AND document_id = ?', [block.id, existing.id])
      }
    })
  })

  return getDocumentBySlug(slug)
}

export function deleteDocument(slug) {
  const row = get('SELECT id, edit_token FROM documents WHERE slug = ?', [slug])
  if (!row) {
    return { error: 'not_found' }
  }

  const blocks = loadBlocks(row.id)
  const removedAssets = collectImagePaths(blocks)

  transaction(() => {
    run('DELETE FROM documents WHERE slug = ?', [slug])
  })
  return { ok: true, removedAssets }
}

export function purgeExpiredDocuments(now = new Date().toISOString()) {
  const rows = all(
    `SELECT id
     FROM documents
     WHERE expires_at IS NOT NULL
       AND expires_at <= ?`,
    [now]
  )

  if (!rows.length) {
    return { removedAssets: [], removedCount: 0 }
  }

  const documentIds = rows.map((row) => Number(row.id))
  const blocksByDocumentId = loadBlocksForDocuments(documentIds)
  const removedAssets = documentIds.flatMap((documentId) =>
    collectImagePaths(blocksByDocumentId.get(documentId) || [])
  )

  const placeholders = documentIds.map(() => '?').join(', ')
  transaction(() => {
    run(`DELETE FROM documents WHERE id IN (${placeholders})`, documentIds)
  })

  return {
    removedAssets,
    removedCount: documentIds.length,
  }
}

export function buildDocumentExports(document) {
  return {
    raw: buildRawText(document),
  }
}

export function canEditDocument(slug) {
  return Boolean(get('SELECT 1 FROM documents WHERE slug = ?', [slug]))
}
