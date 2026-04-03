import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import multipart from '@fastify/multipart'
import test from 'node:test'
import { createCanvas } from '@napi-rs/canvas'

import { registerAssetRoutes } from './assetRoutes.js'

function createMultipartBody(fileName, mimeType, buffer) {
  const boundary = `----promptx-test-${Date.now()}`
  const head = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`
    + `Content-Type: ${mimeType}\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)

  return {
    boundary,
    body: Buffer.concat([head, buffer, tail]),
  }
}

function createTestPngBuffer(width = 2000, height = 1000) {
  const canvas = createCanvas(width, height)
  const context = canvas.getContext('2d')
  context.fillStyle = '#0ea5e9'
  context.fillRect(0, 0, width, height)
  return canvas.toBuffer('image/png')
}

test('asset routes reject missing upload file', async () => {
  const app = Fastify()
  await app.register(multipart)
  registerAssetRoutes(app, {
    createTempFilePath: () => '',
    importPdfBlocks: async () => ({ blocks: [] }),
    normalizeUploadFileName: (name) => name,
    removeAssetFiles: () => {},
    tmpDir: 'tmp',
    uploadsDir: 'uploads',
  })
  await app.ready()

  try {
    const uploadResponse = await app.inject({
      method: 'POST',
      url: '/api/uploads',
    })
    assert.equal(uploadResponse.statusCode, 406)

    const pdfResponse = await app.inject({
      method: 'POST',
      url: '/api/imports/pdf',
    })
    assert.equal(pdfResponse.statusCode, 406)
  } finally {
    await app.close()
  }
})

test('asset routes resize uploaded images and convert them to jpeg', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-asset-routes-'))
  const uploadsDir = path.join(rootDir, 'uploads')
  const tmpDir = path.join(rootDir, 'tmp')
  fs.mkdirSync(uploadsDir, { recursive: true })
  fs.mkdirSync(tmpDir, { recursive: true })

  const app = Fastify()
  await app.register(multipart)
  registerAssetRoutes(app, {
    createTempFilePath: (_dir, fileName) => path.join(tmpDir, fileName),
    importPdfBlocks: async () => ({ blocks: [] }),
    normalizeUploadFileName: (name) => name,
    removeAssetFiles: () => {},
    tmpDir,
    uploadsDir,
  })
  await app.ready()

  try {
    const payload = createMultipartBody('demo.png', 'image/png', createTestPngBuffer())
    const response = await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: {
        'content-type': `multipart/form-data; boundary=${payload.boundary}`,
      },
      payload: payload.body,
    })

    assert.equal(response.statusCode, 201)
    const body = response.json()
    assert.match(body.url || '', /^\/uploads\/.+\.jpg$/)
    assert.equal(body.width, 1600)
    assert.equal(body.height, 800)
    assert.equal(body.mimeType, 'image/jpeg')
    assert.equal(typeof body.size, 'number')
    assert.ok(body.size > 0)

    const outputPath = path.join(uploadsDir, path.basename(body.url))
    assert.equal(fs.existsSync(outputPath), true)
    const outputHeader = fs.readFileSync(outputPath).subarray(0, 2)
    assert.deepEqual([...outputHeader], [0xff, 0xd8])
  } finally {
    await app.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  }
})
