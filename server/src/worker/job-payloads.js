import mongoose from 'mongoose'
import { JobHandlerError } from '../errors/job-handler-error.js'

const emailAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const imageFormats = new Set(['jpeg', 'png', 'webp'])
const maxImageDimension = 4000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function onlyFields(value, fields) {
  return Object.keys(value).every((field) => fields.includes(field))
}

function payloadError(message) {
  return new JobHandlerError(message, { name: 'InvalidJobPayloadError' })
}

export function validateEmailPayload(payload) {
  if (
    !isRecord(payload) ||
    !onlyFields(payload, ['to', 'subject', 'text', 'html']) ||
    typeof payload.to !== 'string' ||
    payload.to.length > 254 ||
    !emailAddressPattern.test(payload.to.trim()) ||
    typeof payload.subject !== 'string' ||
    !payload.subject.trim() ||
    payload.subject.length > 200 ||
    (payload.text !== undefined &&
      (typeof payload.text !== 'string' || payload.text.length > 10_000)) ||
    (payload.html !== undefined &&
      (typeof payload.html !== 'string' || payload.html.length > 20_000)) ||
    (!payload.text?.trim() && !payload.html?.trim())
  ) {
    throw payloadError(
      'send_email requires a valid recipient, subject, and non-empty text or HTML message within the documented size limits.',
    )
  }

  return {
    to: payload.to.trim(),
    subject: payload.subject.trim(),
    ...(payload.text !== undefined ? { text: payload.text } : {}),
    ...(payload.html !== undefined ? { html: payload.html } : {}),
  }
}

export function validatePdfPayload(payload) {
  if (
    !isRecord(payload) ||
    !onlyFields(payload, ['title', 'sections']) ||
    typeof payload.title !== 'string' ||
    !payload.title.trim() ||
    payload.title.trim().length > 160 ||
    !Array.isArray(payload.sections) ||
    payload.sections.length < 1 ||
    payload.sections.length > 20
  ) {
    throw payloadError(
      'generate_pdf requires a title of at most 160 characters and 1 to 20 report sections.',
    )
  }

  let totalCharacters = payload.title.length
  const sections = payload.sections.map((section) => {
    if (
      !isRecord(section) ||
      !onlyFields(section, ['heading', 'paragraphs']) ||
      typeof section.heading !== 'string' ||
      !section.heading.trim() ||
      section.heading.length > 120 ||
      !Array.isArray(section.paragraphs) ||
      section.paragraphs.length > 12 ||
      section.paragraphs.some(
        (paragraph) =>
          typeof paragraph !== 'string' ||
          !paragraph.trim() ||
          paragraph.length > 2000,
      )
    ) {
      throw payloadError(
        'Each PDF section needs a heading (max 120 characters) and up to 12 non-empty paragraphs (max 2000 characters each).',
      )
    }
    totalCharacters +=
      section.heading.length +
      section.paragraphs.reduce((sum, paragraph) => sum + paragraph.length, 0)
    if (totalCharacters > 80_000) {
      throw payloadError('PDF report content must not exceed 80,000 characters.')
    }
    return {
      heading: section.heading.trim(),
      paragraphs: section.paragraphs.map((paragraph) => paragraph.trim()),
    }
  })

  return { title: payload.title.trim(), sections }
}

export function validateImagePayload(payload) {
  if (
    !isRecord(payload) ||
    !onlyFields(payload, ['assetId', 'operation', 'width', 'height', 'format']) ||
    typeof payload.assetId !== 'string' ||
    !mongoose.isObjectIdOrHexString(payload.assetId)
  ) {
    throw payloadError('process_image requires a valid uploaded assetId.')
  }
  if (!['resize', 'convert', 'thumbnail'].includes(payload.operation)) {
    throw payloadError('Image operation must be resize, convert, or thumbnail.')
  }
  if (payload.operation === 'resize') {
    validateDimensions(payload.width, payload.height)
    if (payload.format !== undefined && !imageFormats.has(payload.format)) {
      throw payloadError('Image output format must be jpeg, png, or webp.')
    }
  } else if (payload.operation === 'convert') {
    if (!imageFormats.has(payload.format)) {
      throw payloadError('Image conversion format must be jpeg, png, or webp.')
    }
    if (payload.width !== undefined || payload.height !== undefined) {
      throw payloadError('Image conversion does not accept resize dimensions.')
    }
  } else if (
    (payload.width !== undefined && payload.width !== 256) ||
    (payload.height !== undefined && payload.height !== 256) ||
    (payload.format !== undefined && payload.format !== 'webp')
  ) {
    throw payloadError('Thumbnail output is fixed at 256x256 WebP.')
  }

  return {
    assetId: payload.assetId,
    operation: payload.operation,
    ...(payload.width !== undefined ? { width: payload.width } : {}),
    ...(payload.height !== undefined ? { height: payload.height } : {}),
    ...(payload.format !== undefined ? { format: payload.format } : {}),
  }
}

function validateDimensions(width, height) {
  if (
    (width === undefined && height === undefined) ||
    (width !== undefined &&
      (!Number.isInteger(width) || width < 1 || width > maxImageDimension)) ||
    (height !== undefined &&
      (!Number.isInteger(height) || height < 1 || height > maxImageDimension))
  ) {
    throw payloadError(
      `Image resize requires width or height between 1 and ${maxImageDimension} pixels.`,
    )
  }
}

export { maxImageDimension }
