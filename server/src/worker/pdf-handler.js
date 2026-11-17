import PDFDocument from 'pdfkit'
import JobAsset from '../models/job-asset.model.js'
import { fileStore } from '../storage/file-store.js'
import { JobHandlerError } from '../errors/job-handler-error.js'
import { validatePdfPayload } from './job-payloads.js'

export function createPdfHandler({
  AssetModel = JobAsset,
  store = fileStore,
  now = () => new Date(),
} = {}) {
  return async function generatePdf(payload, { job, reportProgress } = {}) {
    const report = validatePdfPayload(payload)
    const { ownerId, jobId } = getExecutionIdentity(job)
    const existing = await AssetModel.findOne({
      ownerId,
      jobId,
      kind: 'output',
      mediaType: 'application/pdf',
    }).lean()
    if (existing) {
      await reportProgress?.({ percent: 100, stage: 'completed', message: 'Reusing existing PDF artifact' })
      return pdfResult(existing, report.title)
    }

    const generatedAt = now()
    if (!(generatedAt instanceof Date) || !Number.isFinite(generatedAt.getTime())) {
      throw new JobHandlerError('PDF generation time is unavailable.', {
        name: 'PdfGenerationError',
      })
    }
    await reportProgress?.({ percent: 35, stage: 'rendering', message: 'Rendering PDF pages and typography' })
    const pdf = await renderReport(report, generatedAt)
    if (pdf.length > 10 * 1024 * 1024) {
      throw new JobHandlerError('Generated PDF exceeds the 10 MB output limit.', {
        name: 'PdfOutputTooLargeError',
      })
    }
    let saved
    try {
      await reportProgress?.({ percent: 80, stage: 'saving', message: 'Writing PDF artifact to secure file store' })
      saved = await store.save(ownerId, 'outputs', 'pdf', pdf)
      const asset = await AssetModel.create({
        ownerId,
        jobId,
        kind: 'output',
        storageKey: saved.storageKey,
        fileName: 'report.pdf',
        mediaType: 'application/pdf',
        sizeBytes: saved.sizeBytes,
      })
      await reportProgress?.({ percent: 100, stage: 'completed', message: 'PDF report generated and saved' })
      return pdfResult(asset, report.title)
    } catch (error) {
      if (saved) {
        try {
          await store.remove(ownerId, saved.storageKey, 'outputs')
        } catch (cleanupError) {
          console.error(
            `Generated PDF cleanup failed (${cleanupError?.name ?? 'UnknownError'}).`,
          )
        }
      }
      if (error?.code === 11000) {
        const winner = await AssetModel.findOne({
          ownerId,
          jobId,
          kind: 'output',
          mediaType: 'application/pdf',
        }).lean()
        if (winner) return pdfResult(winner, report.title)
      }
      throw new JobHandlerError('Could not save the generated PDF report.', {
        name: 'PdfStorageError',
      })
    }
  }
}

function pdfResult(asset, title) {
  return {
    type: 'pdf',
    title,
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

async function renderReport(report, generatedAt) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({
      autoFirstPage: true,
      margin: 54,
      compress: false,
    })
    const chunks = []
    document.on('data', (chunk) => chunks.push(chunk))
    document.once('error', () =>
      reject(
        new JobHandlerError('Could not render the PDF report.', {
          name: 'PdfGenerationError',
        }),
      ),
    )
    document.once('end', () => resolve(Buffer.concat(chunks)))
    try {
      document.fontSize(22).fillColor('#172554').text(report.title, { align: 'left' })
      document.moveDown()
      document
        .fontSize(9)
        .fillColor('#64748b')
        .text(`Generated: ${generatedAt.toISOString()}`)
      document.moveDown()
      for (const section of report.sections) {
        document.fontSize(15).fillColor('#1e3a8a').text(section.heading)
        document.moveDown(0.35)
        for (const paragraph of section.paragraphs) {
          document.fontSize(10).fillColor('#1f2937').text(paragraph, {
            lineGap: 3,
          })
          document.moveDown(0.5)
        }
        document.moveDown(0.5)
      }
      document.end()
    } catch {
      reject(
        new JobHandlerError('Could not render the PDF report.', {
          name: 'PdfGenerationError',
        }),
      )
    }
  })
}

function getExecutionIdentity(job) {
  const ownerId = String(job?.ownerId ?? '')
  const jobId = String(job?._id ?? '')
  if (!/^[0-9a-f]{24}$/i.test(ownerId) || !/^[0-9a-f]{24}$/i.test(jobId)) {
    throw new JobHandlerError('PDF job ownership context is missing.', {
      name: 'JobExecutionContextError',
    })
  }
  return { ownerId, jobId }
}
