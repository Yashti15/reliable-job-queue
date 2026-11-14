import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const defaultRoot = fileURLToPath(new URL('../../storage/', import.meta.url))
const storageKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:pdf|jpg|png|webp)$/
const ownerIdPattern = /^[0-9a-f]{24}$/i

export function createFileStore({ root } = {}) {
  const fixedRoot = root === undefined ? undefined : path.resolve(root)

  function getStorageRoot() {
    return fixedRoot ?? path.resolve(process.env.JOB_STORAGE_DIR || defaultRoot)
  }

  function resolvePath(ownerId, storageKey, category) {
    if (!ownerIdPattern.test(String(ownerId))) {
      throw new TypeError('Invalid file owner.')
    }
    if (!storageKeyPattern.test(storageKey)) {
      throw new TypeError('Invalid stored file key.')
    }
    if (!['uploads', 'outputs'].includes(category)) {
      throw new TypeError('Invalid file category.')
    }

    const userDirectory = path.resolve(
      getStorageRoot(),
      'users',
      String(ownerId),
      category,
    )
    const filePath = path.resolve(userDirectory, storageKey)
    if (!filePath.startsWith(`${userDirectory}${path.sep}`)) {
      throw new TypeError('Invalid stored file path.')
    }
    return { userDirectory, filePath }
  }

  async function save(ownerId, category, extension, buffer) {
    const normalizedExtension = extension.toLowerCase().replace(/^\./, '')
    if (!['pdf', 'jpg', 'png', 'webp'].includes(normalizedExtension)) {
      throw new TypeError('Unsupported output file extension.')
    }
    if (!Buffer.isBuffer(buffer) || buffer.length < 1) {
      throw new TypeError('File content must be a non-empty Buffer.')
    }

    const storageKey = `${randomUUID()}.${normalizedExtension}`
    const { userDirectory, filePath } = resolvePath(ownerId, storageKey, category)
    await mkdir(userDirectory, { recursive: true, mode: 0o700 })
    await writeFile(filePath, buffer, { flag: 'wx', mode: 0o600 })
    return { storageKey, sizeBytes: buffer.length }
  }

  async function load(ownerId, storageKey, category) {
    const { filePath } = resolvePath(ownerId, storageKey, category)
    return readFile(filePath)
  }

  async function remove(ownerId, storageKey, category) {
    const { filePath } = resolvePath(ownerId, storageKey, category)
    await rm(filePath, { force: true })
  }

  return {
    get root() {
      return getStorageRoot()
    },
    save,
    load,
    remove,
  }
}

export const fileStore = createFileStore()
