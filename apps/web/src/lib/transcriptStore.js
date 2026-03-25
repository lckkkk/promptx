import { translate } from '../composables/useI18n.js'

const DB_NAME = 'promptx-transcripts'
const STORE_NAME = 'turns'
const DB_VERSION = 1

let dbPromise = null

function isIndexedDbAvailable() {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined'
}

function openDatabase() {
  if (!isIndexedDbAvailable()) {
    return Promise.resolve(null)
  }

  if (dbPromise) {
    return dbPromise
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = window.indexedDB.open(DB_NAME, DB_VERSION)

    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'storageKey' })
      }
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onerror = () => {
      reject(request.error || new Error(translate('errors.transcriptOpenFailed')))
    }
  }).catch((error) => {
    dbPromise = null
    throw error
  })

  return dbPromise
}

function runTransaction(mode, handler) {
  return openDatabase().then((database) => {
    if (!database) {
      return null
    }

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode)
      const store = transaction.objectStore(STORE_NAME)
      const request = handler(store)

      transaction.oncomplete = () => {
        if (typeof request?.result === 'undefined') {
          resolve(null)
          return
        }
        resolve(request.result)
      }

      transaction.onerror = () => {
        reject(transaction.error || request?.error || new Error(translate('errors.transcriptOperationFailed')))
      }

      transaction.onabort = () => {
        reject(transaction.error || new Error(translate('errors.transcriptAborted')))
      }
    })
  })
}

export async function getTranscript(storageKey) {
  const key = String(storageKey || '').trim()
  if (!key) {
    return null
  }

  const record = await runTransaction('readonly', (store) => store.get(key))
  return record?.turns || null
}

export async function setTranscript(storageKey, turns) {
  const key = String(storageKey || '').trim()
  if (!key) {
    return
  }

  await runTransaction('readwrite', (store) => store.put({
    storageKey: key,
    turns,
    updatedAt: Date.now(),
  }))
}

export async function deleteTranscript(storageKey) {
  const key = String(storageKey || '').trim()
  if (!key) {
    return
  }

  await runTransaction('readwrite', (store) => store.delete(key))
}
