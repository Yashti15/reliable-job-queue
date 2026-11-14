import { createEmailHandler } from './email-handler.js'
import { createImageHandler } from './image-handler.js'
import { createPdfHandler } from './pdf-handler.js'

const handlers = new Map()

export function registerJobHandler(type, handler) {
  if (typeof type !== 'string' || !type.trim()) {
    throw new TypeError('Handler type must be a non-empty string.')
  }
  if (typeof handler !== 'function') {
    throw new TypeError('Handler must be a function.')
  }
  if (handlers.has(type)) {
    throw new Error(`A handler is already registered for "${type}".`)
  }

  handlers.set(type, handler)
}

export function getJobHandler(type) {
  return handlers.get(type)
}

export function getRegisteredJobTypes() {
  return [...handlers.keys()]
}

registerJobHandler('send_email', createEmailHandler())
registerJobHandler('generate_pdf', createPdfHandler())
registerJobHandler('process_image', createImageHandler())
