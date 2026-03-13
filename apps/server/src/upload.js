import path from 'node:path'
import { nanoid } from 'nanoid'

export function normalizeUploadFileName(fileName = '', fallback = 'file') {
  const normalized = String(fileName || '')
    .trim()
    .split(/[\\/]/)
    .pop()
  return normalized || fallback
}

export function getSafeTempExtension(fileName = '', fallback = '') {
  const extension = path.extname(normalizeUploadFileName(fileName)).toLowerCase()
  if (/^\.[a-z0-9]{1,10}$/.test(extension)) {
    return extension
  }
  return fallback
}

export function createTempFilePath(tmpDir, fileName = '', fallbackExt = '') {
  return path.join(tmpDir, `${nanoid(12)}${getSafeTempExtension(fileName, fallbackExt)}`)
}
