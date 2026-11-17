import sharp from 'sharp'
import JobAsset from '../models/job-asset.model.js'
import { fileStore } from '../storage/file-store.js'
import { JobHandlerError } from '../errors/job-handler-error.js'
import { validateImagePayload } from './job-payloads.js'

const maxImageBytes = 5 * 1024 * 1024
const maxInputPixels = 16_000_000
const outputFormats = {
  jpeg: { extension: 'jpg', mediaType: 'image/jpeg' },
  png: { extension: 'png', mediaType: 'image/png' },
  webp: { extension: 'webp', mediaType: 'image/webp' },
}

export function createImageHandler({
  AssetModel = JobAsset,
  store = fileStore,
  imageProcessor = sharp,
} = {}) {
  return async function processImage(payload, { job, reportProgress } = {}) {
    const operation = validateImagePayload(payload)
    const ownerId = String(job?.ownerId ?? '')
    const jobId = String(job?._id ?? '')
    if (!/^[0-9a-f]{24}$/i.test(ownerId) || !/^[0-9a-f]{24}$/i.test(jobId)) {
      throw new JobHandlerError('Image job ownership context is missing.', {
        name: 'JobExecutionContextError',
      })
    }

    const existing = await AssetModel.findOne({
      ownerId,
      jobId,
      kind: 'output',
      mediaType: { $in: ['image/jpeg', 'image/png', 'image/webp'] },
    }).lean()
    if (existing) {
      await reportProgress?.({ percent: 100, stage: 'completed', message: 'Reusing previously completed image artifact' })
      return imageResult(existing, operation, existing.mediaType.slice(6))
    }

    await reportProgress?.({ percent: 20, stage: 'reading', message: 'Loading uploaded image from storage' })

    const upload = await AssetModel.findOne({
      _id: operation.assetId,
      ownerId,
      kind: 'upload',
    }).lean()
    if (!upload) {
      throw new JobHandlerError('The uploaded image was not found for this account.', {
        name: 'ImageInputNotFoundError',
      })
    }

    let input
    try {
      input = await store.load(ownerId, upload.storageKey, 'uploads')
    } catch (error) {
      console.error(`Image input storage read failed (${error?.name ?? 'UnknownError'}).`)
      throw new JobHandlerError('The uploaded image is no longer available.', {
        name: 'ImageInputNotFoundError',
      })
    }
    if (input.length > maxImageBytes) {
      throw new JobHandlerError('Image input exceeds the 5 MB limit.', {
        name: 'InvalidImageError',
      })
    }

    let outputBuffer
    let outputInfo
    let outputFormat
    try {
      await reportProgress?.({ percent: 50, stage: 'processing', message: 'Applying image transformations with Sharp' })
      const pipeline = imageProcessor(input, {
        limitInputPixels: maxInputPixels,
        failOn: 'error',
      }).rotate()
      const metadata = await pipeline.metadata()
      if (
        !['jpeg', 'png', 'webp'].includes(metadata.format) ||
        !metadata.width ||
        !metadata.height ||
        metadata.width > 4000 ||
        metadata.height > 4000 ||
        metadata.width * metadata.height > maxInputPixels
      ) {
        throw new Error('Unsupported or excessive image dimensions.')
      }

      outputFormat =
        operation.operation === 'thumbnail'
          ? 'webp'
          : operation.operation === 'convert'
            ? operation.format
            : operation.format ?? metadata.format
      if (operation.operation === 'resize') {
        pipeline.resize(operation.width, operation.height, {
          fit: 'inside',
          withoutEnlargement: true,
        })
      } else if (operation.operation === 'thumbnail') {
        pipeline.resize(256, 256, { fit: 'cover', position: 'centre' })
      }

      const output = await pipeline
        .toFormat(outputFormat)
        .toBuffer({ resolveWithObject: true })
      outputBuffer = output.data
      outputInfo = output.info
    } catch (error) {
      if (error instanceof JobHandlerError) throw error
      throw new JobHandlerError('Image input is corrupt or uses an unsupported format.', {
        name: 'InvalidImageError',
      })
    }

    const format = outputFormats[outputFormat]
    if (outputBuffer.length > 10 * 1024 * 1024) {
      throw new JobHandlerError('Processed image exceeds the 10 MB output limit.', {
        name: 'ImageOutputTooLargeError',
      })
    }
    let saved
    try {
      await reportProgress?.({ percent: 85, stage: 'saving', message: 'Saving processed image artifact' })
      saved = await store.save(ownerId, 'outputs', format.extension, outputBuffer)
      const asset = await AssetModel.create({
        ownerId,
        jobId,
        kind: 'output',
        storageKey: saved.storageKey,
        fileName: `processed.${format.extension}`,
        mediaType: format.mediaType,
        sizeBytes: saved.sizeBytes,
        width: outputInfo.width,
        height: outputInfo.height,
      })
      return imageResult(asset, operation, outputFormat)
    } catch (error) {
      if (saved) {
        try {
          await store.remove(ownerId, saved.storageKey, 'outputs')
        } catch (cleanupError) {
          console.error(
            `Processed image cleanup failed (${cleanupError?.name ?? 'UnknownError'}).`,
          )
        }
      }
      if (error?.code === 11000) {
        const winner = await AssetModel.findOne({
          ownerId,
          jobId,
          kind: 'output',
          mediaType: format.mediaType,
        }).lean()
        if (winner) return imageResult(winner, operation, outputFormat)
      }
      throw new JobHandlerError('Could not save the processed image.', {
        name: 'ImageStorageError',
      })
    }
  }
}

function imageResult(asset, operation, format) {
  return {
    type: 'image',
    operation: operation.operation,
    width: asset.width,
    height: asset.height,
    format,
    artifacts: [
      {
        assetId: String(asset._id),
        fileName: asset.fileName,
        mediaType: asset.mediaType,
        sizeBytes: asset.sizeBytes,
      },
    ],
  }
}

export { maxImageBytes, maxInputPixels }
