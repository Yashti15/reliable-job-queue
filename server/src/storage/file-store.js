import { randomUUID } from 'node:crypto'
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  stat as statFile,
  writeFile,
} from 'node:fs/promises'
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

  function resolvePath(ownerId, storageKey, category, root = getStorageRoot()) {
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
      root,
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

  async function resolveSafePath(ownerId, storageKey, category) {
    const configuredRoot = path.resolve(getStorageRoot())
    const rootStats = await lstat(configuredRoot)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw unsafeStoragePathError()
    }
    const root = await realpath(configuredRoot)
    const usersDirectory = path.join(root, 'users')
    const ownerDirectory = path.join(usersDirectory, String(ownerId))
    const { userDirectory, filePath } = resolvePath(
      ownerId,
      storageKey,
      category,
      root,
    )

    for (const directory of [usersDirectory, ownerDirectory, userDirectory]) {
      const directoryStats = await lstat(directory)
      if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
        throw unsafeStoragePathError()
      }

      const resolvedDirectory = await realpath(directory)
      if (!isPathWithin(root, resolvedDirectory)) {
        throw unsafeStoragePathError()
      }
    }

    const safeFilePath = path.join(await realpath(userDirectory), path.basename(filePath))
    try {
      const fileStats = await lstat(safeFilePath)
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
        throw unsafeStoragePathError()
      }

      const resolvedFile = await realpath(safeFilePath)
      if (!isPathWithin(root, resolvedFile)) {
        throw unsafeStoragePathError()
      }
      return resolvedFile
    } catch (error) {
      if (error?.code === 'ENOENT') return safeFilePath
      throw error
    }
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
    const safeFilePath = await resolveSafePath(ownerId, storageKey, category)
    return readFile(safeFilePath)
  }

  async function stat(ownerId, storageKey, category) {
    return statFile(await resolveSafePath(ownerId, storageKey, category))
  }

  async function remove(ownerId, storageKey, category) {
    let safeFilePath
    try {
      safeFilePath = await resolveSafePath(ownerId, storageKey, category)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await rm(safeFilePath, { force: true })
  }

  return {
    get root() {
      return getStorageRoot()
    },
    save,
    load,
    stat,
    remove,
  }
}

export const fileStore = createFileStore()

function isPathWithin(root, candidate) {
  const relativePath = path.relative(root, candidate)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

function unsafeStoragePathError() {
  const error = new TypeError('Stored artifact path contains a symbolic link.')
  error.code = 'ERR_UNSAFE_STORAGE_PATH'
  return error
}
