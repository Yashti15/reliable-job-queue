import { Router } from 'express'
import sharp from 'sharp'
import mongoose from 'mongoose'
import JobAsset from '../models/job-asset.model.js'
import QuotaReservation from '../models/quota-reservation.model.js'
import { fileStore } from '../storage/file-store.js'
import { maxImageBytes, maxInputPixels } from '../worker/image-handler.js'
import {
  reserveStorageSlot,
  getOwnerStorageUsage,
} from '../worker/quota-reservation.js'

const imageTypes = {
  jpeg: { extension: 'jpg', mediaType: 'image/jpeg' },
  png: { extension: 'png', mediaType: 'image/png' },
  webp: { extension: 'webp', mediaType: 'image/webp' },
}

const defaultStorageQuotaBytes = 50 * 1024 * 1024 // 50 MB
const defaultMaxUploadCount = 50

export function getUploadQuotaOptions(env = process.env) {
  const parseQuotaNumber = (value, defaultValue) => {
    if (value === undefined) return defaultValue
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue
  }
  return {
    maxStorageBytes: parseQuotaNumber(
      env.USER_STORAGE_QUOTA_BYTES,
      defaultStorageQuotaBytes,
    ),
    maxUploadCount: parseQuotaNumber(
      env.USER_MAX_UPLOAD_COUNT,
      defaultMaxUploadCount,
    ),
  }
}

export { getOwnerStorageUsage }

function sendError(response, status, code, message) {
  response.status(status).json({ success: false, error: { code, message } })
}

export function createUploadsRouter({
  AssetModel = JobAsset,
  store = fileStore,
  imageProcessor = sharp,
  quotaOptions = getUploadQuotaOptions(),
  ReservationModel = QuotaReservation,
} = {}) {
  const router = Router()

  router.post(
    '/images',
    (request, response, next) => {
      if (!request.is('image/*')) {
        sendError(response, 415, 'UNSUPPORTED_IMAGE_TYPE', 'Upload a JPEG, PNG, or WebP image.')
        return
      }
      next()
    },
    async (request, response) => {
      const ownerId = request.authUser._id
      const contentType = request.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (!Buffer.isBuffer(request.body) || request.body.length < 1) {
        sendError(response, 400, 'INVALID_IMAGE', 'Image file content is required.')
        return
      }
      if (request.body.length > maxImageBytes) {
        sendError(response, 413, 'IMAGE_TOO_LARGE', 'Image uploads are limited to 5 MB.')
        return
      }

      let metadata
      let normalizedBuffer
      try {
        metadata = await imageProcessor(request.body, {
          limitInputPixels: maxInputPixels,
          failOn: 'error',
        }).metadata()
        const format = imageTypes[metadata.format]
        if (
          !format ||
          format.mediaType !== contentType ||
          !metadata.width ||
          !metadata.height ||
          metadata.width > 4000 ||
          metadata.height > 4000 ||
          metadata.width * metadata.height > maxInputPixels
        ) {
          sendError(
            response,
            400,
            'INVALID_IMAGE',
            'Image must be a valid JPEG, PNG, or WebP no larger than 4000 by 4000 pixels.',
          )
          return
        }
        normalizedBuffer = await imageProcessor(request.body, {
          limitInputPixels: maxInputPixels,
          failOn: 'error',
        })
          .rotate()
          .toFormat(metadata.format)
          .toBuffer()
        if (normalizedBuffer.length > maxImageBytes) {
          sendError(response, 413, 'IMAGE_TOO_LARGE', 'Normalized image exceeds the 5 MB storage limit.')
          return
        }
      } catch (error) {
        console.error(`Image upload validation failed (${error?.name ?? 'UnknownError'}).`)
        sendError(response, 400, 'INVALID_IMAGE', 'Image content is corrupted or unsupported.')
        return
      }

      const { maxStorageBytes, maxUploadCount } = quotaOptions
      let storageReservation = null
      try {
        const reservation = await reserveStorageSlot({
          ownerId,
          bufferLength: normalizedBuffer.length,
          maxStorageBytes,
          maxUploadCount,
          AssetModel,
          ReservationModel,
        })
        if (!reservation.allowed) {
          sendError(response, 429, reservation.code, reservation.message)
          return
        }
        storageReservation = reservation
      } catch (quotaError) {
        console.error(
          `Storage quota check failed (${quotaError?.name ?? 'UnknownError'}).`,
        )
      }

      let saved
      try {
        saved = await store.save(
          ownerId,
          'uploads',
          imageTypes[metadata.format].extension,
          normalizedBuffer,
        )
        const asset = await AssetModel.create({
          ownerId,
          kind: 'upload',
          storageKey: saved.storageKey,
          fileName: `source.${imageTypes[metadata.format].extension}`,
          mediaType: imageTypes[metadata.format].mediaType,
          sizeBytes: saved.sizeBytes,
          width: metadata.width,
          height: metadata.height,
        })
        if (storageReservation?.release) {
          await storageReservation.release()
          storageReservation = null
        }
        response.status(201).json({
          success: true,
          data: {
            asset: {
              id: String(asset._id),
              fileName: asset.fileName,
              mediaType: asset.mediaType,
              sizeBytes: asset.sizeBytes,
              width: metadata.width,
              height: metadata.height,
            },
          },
        })
      } catch (error) {
        if (storageReservation?.release) {
          try {
            await storageReservation.release()
          } catch (releaseErr) {
            console.error(
              `Storage reservation release failed (${releaseErr?.name ?? 'UnknownError'}).`,
            )
          }
        }
        if (saved) {
          try {
            await store.remove(ownerId, saved.storageKey, 'uploads')
          } catch (cleanupError) {
            console.error(
              `Image upload cleanup failed (${cleanupError?.name ?? 'UnknownError'}).`,
            )
          }
        }
        const name = error instanceof Error ? error.name : 'UnknownError'
        console.error(`Image upload could not be stored (${name}).`)
        sendError(response, 500, 'IMAGE_STORAGE_FAILED', 'Image upload could not be stored.')
      }
    },
  )

  return router
}

export default createUploadsRouter()
