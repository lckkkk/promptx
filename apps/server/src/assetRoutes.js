import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { nanoid } from 'nanoid'
import { createApiError } from './apiErrors.js'

function scaleImageToFit(width = 0, height = 0, maxWidth = 1600, maxHeight = 1600) {
  const safeWidth = Math.max(1, Number(width) || 0)
  const safeHeight = Math.max(1, Number(height) || 0)
  const ratio = Math.min(maxWidth / safeWidth, maxHeight / safeHeight)

  return {
    width: Math.max(1, Math.round(safeWidth * ratio)),
    height: Math.max(1, Math.round(safeHeight * ratio)),
  }
}

function registerAssetRoutes(app, options = {}) {
  const {
    createTempFilePath,
    importPdfBlocks,
    normalizeUploadFileName,
    removeAssetFiles = () => {},
    tmpDir,
    uploadsDir,
  } = options

  app.post('/api/uploads', async (request, reply) => {
    const part = await request.file()
    if (!part) {
      return reply.code(400).send({ messageKey: 'errors.uploadFileMissing', message: '没有收到上传文件。' })
    }
    if (!String(part.mimetype || '').startsWith('image/')) {
      return reply.code(400).send({ messageKey: 'errors.uploadImageOnly', message: '只支持上传图片文件。' })
    }

    const tempPath = createTempFilePath(tmpDir, part.filename)
    let outputPath = ''
    let completed = false

    try {
      await pipeline(part.file, fs.createWriteStream(tempPath))

      const source = await loadImage(tempPath)
      const scaled = scaleImageToFit(source.width, source.height)
      const canvas = createCanvas(scaled.width, scaled.height)
      const context = canvas.getContext('2d')
      context.drawImage(source, 0, 0, scaled.width, scaled.height)

      const outputName = `${nanoid(16)}.jpg`
      outputPath = path.join(uploadsDir, outputName)
      const outputBuffer = canvas.toBuffer('image/jpeg', 82)
      fs.writeFileSync(outputPath, outputBuffer)

      const stats = fs.statSync(outputPath)
      completed = true
      return reply.code(201).send({
        url: `/uploads/${outputName}`,
        width: scaled.width,
        height: scaled.height,
        mimeType: 'image/jpeg',
        size: stats.size,
      })
    } finally {
      fs.rmSync(tempPath, { force: true })
      if (outputPath && !completed) {
        fs.rmSync(outputPath, { force: true })
      }
    }
  })

  app.post('/api/imports/pdf', async (request, reply) => {
    const part = await request.file()
    if (!part) {
      return reply.code(400).send({ messageKey: 'errors.pdfFileMissing', message: '没有收到 PDF 文件。' })
    }

    const fileName = normalizeUploadFileName(part.filename, 'task.pdf')
    const mimetype = String(part.mimetype || '').toLowerCase()
    if (mimetype !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
      return reply.code(400).send({ messageKey: 'errors.pdfOnly', message: '只支持导入 PDF 文件。' })
    }

    const tempPath = createTempFilePath(tmpDir, fileName, '.pdf')
    let createdAssets = []

    try {
      await pipeline(part.file, fs.createWriteStream(tempPath))
      const buffer = fs.readFileSync(tempPath)
      const imported = await importPdfBlocks(buffer, {
        uploadsDir,
      })
      createdAssets = imported.createdAssets || []

      if (!imported.blocks.length) {
        removeAssetFiles(createdAssets)
        return reply.code(422).send({
          messageKey: 'errors.pdfNoImportableContent',
          message: '没有从 PDF 中提取到可导入的文本或图片。',
        })
      }

      return reply.code(201).send({
        fileName,
        pageCount: imported.pageCount,
        blocks: imported.blocks,
      })
    } catch (error) {
      removeAssetFiles(error.createdAssets || createdAssets)
      throw createApiError(error?.messageKey || '', error?.message || 'PDF 导入失败。', error?.statusCode || 500, {
        createdAssets: error?.createdAssets || createdAssets,
        cause: error,
      })
    } finally {
      fs.rmSync(tempPath, { force: true })
    }
  })
}

export {
  registerAssetRoutes,
}
