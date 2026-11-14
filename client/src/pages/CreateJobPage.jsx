import { useState } from 'react'
import { createJob, getApiErrorMessage, uploadImage } from '../api/jobs.js'
import { AppLink, navigate } from '../components/AppLink.jsx'
import { PageHeader } from '../components/PageHeader.jsx'

const initialPayload = JSON.stringify(
  { to: 'learner@example.test', subject: 'Welcome to QueueOps', text: 'Your job has completed.' },
  null,
  2,
)
const pdfPayload = JSON.stringify(
  {
    title: 'Queue processing report',
    sections: [{ heading: 'Summary', paragraphs: ['This is a generated report.'] }],
  },
  null,
  2,
)

export function CreateJobPage() {
  const [type, setType] = useState('send_email')
  const [payloadText, setPayloadText] = useState(initialPayload)
  const [priority, setPriority] = useState('normal')
  const [runAt, setRunAt] = useState('')
  const [maxAttempts, setMaxAttempts] = useState('3')
  const [idempotencyKey, setIdempotencyKey] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [requestError, setRequestError] = useState('')
  const [createdJob, setCreatedJob] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [imageFile, setImageFile] = useState(null)
  const [imageOperation, setImageOperation] = useState('thumbnail')
  const [imageWidth, setImageWidth] = useState('800')
  const [imageHeight, setImageHeight] = useState('')
  const [imageFormat, setImageFormat] = useState('webp')

  async function handleSubmit(event) {
    event.preventDefault()
    setFieldError('')
    setRequestError('')
    setCreatedJob(null)

    let payload = {}
    if (type !== 'process_image') {
      try {
        payload = JSON.parse(payloadText)
      } catch {
        setFieldError('Payload must be valid JSON.')
        return
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        setFieldError('Payload must be a JSON object.')
        return
      }
    } else if (!imageFile) {
      setFieldError('Choose a JPEG, PNG, or WebP image to process.')
      return
    } else if (
      imageOperation === 'resize' &&
      (!imageWidth && !imageHeight ||
        [imageWidth, imageHeight].some(
          (dimension) =>
            dimension !== '' &&
            (!Number.isInteger(Number(dimension)) ||
              Number(dimension) < 1 ||
              Number(dimension) > 4000),
        ))
    ) {
      setFieldError('Image resize needs a width or height from 1 to 4000 pixels.')
      return
    }
    if (!Number.isInteger(Number(maxAttempts)) || Number(maxAttempts) < 1) {
      setFieldError('Maximum attempts must be a positive whole number.')
      return
    }

    setSubmitting(true)
    try {
      if (type === 'process_image') {
        const uploadResponse = await uploadImage(imageFile)
        const assetId = uploadResponse.data.data.asset.id
        payload = { assetId, operation: imageOperation }
        if (imageOperation === 'resize') {
          if (imageWidth) payload.width = Number(imageWidth)
          if (imageHeight) payload.height = Number(imageHeight)
          if (imageFormat) payload.format = imageFormat
        } else if (imageOperation === 'convert') {
          payload.format = imageFormat
        }
      }
      const response = await createJob({
        type,
        payload,
        priority,
        maxAttempts: Number(maxAttempts),
        ...(runAt ? { runAt: new Date(runAt).toISOString() } : {}),
        ...(idempotencyKey.trim() ? { idempotencyKey: idempotencyKey.trim() } : {}),
      })
      setCreatedJob(response.data.data.job)
      setType('send_email')
      setPayloadText(initialPayload)
      setImageFile(null)
      setRunAt('')
      setIdempotencyKey('')
    } catch (error) {
      setRequestError(getApiErrorMessage(error))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Queue submission"
        title="Create a job"
        description="Submit a validated job to MongoDB. A separate worker will execute it when it becomes eligible."
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40 md:p-7">
          {createdJob && (
            <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
              <p className="font-semibold">Job submitted successfully.</p>
              <p className="mt-1 break-all font-mono text-xs text-emerald-800">{createdJob._id}</p>
              <button type="button" onClick={() => navigate(`/jobs/${createdJob._id}`)} className="mt-2 font-semibold underline underline-offset-2">
                View job details
              </button>
            </div>
          )}

          {(fieldError || requestError) && (
            <div role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {fieldError || requestError}
            </div>
          )}

          <label className="block text-sm font-semibold text-slate-700">
            Job type <span className="text-rose-500">*</span>
            <select
              value={type}
              onChange={(event) => {
                const nextType = event.target.value
                setType(nextType)
                setPayloadText(nextType === 'generate_pdf' ? pdfPayload : initialPayload)
              }}
              className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
            >
              <option value="send_email">send_email · Resend provider</option>
              <option value="generate_pdf">generate_pdf · PDF report</option>
              <option value="process_image">process_image · image transform</option>
            </select>
            <span className="mt-1.5 block text-xs font-normal text-slate-500">Only registered worker handlers are available.</span>
          </label>

          {type === 'process_image' ? (
            <section className="space-y-4 rounded-xl border border-slate-200 p-4">
              <label className="block text-sm font-semibold text-slate-700">
                Image file <span className="text-rose-500">*</span>
                <input
                  key={imageFile?.name ?? 'empty'}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={(event) => setImageFile(event.target.files?.[0] ?? null)}
                  className="mt-2 block w-full text-sm font-normal text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:px-3 file:py-2 file:font-semibold file:text-indigo-700"
                />
                <span className="mt-1 block text-xs font-normal text-slate-500">JPEG, PNG, or WebP; maximum 5 MB and 4000×4000 pixels.</span>
              </label>
              <label className="block text-sm font-semibold text-slate-700">
                Operation
                <select value={imageOperation} onChange={(event) => setImageOperation(event.target.value)} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-normal">
                  <option value="thumbnail">Thumbnail (256×256 WebP)</option>
                  <option value="resize">Resize</option>
                  <option value="convert">Convert format</option>
                </select>
              </label>
              {imageOperation === 'resize' && (
                <div className="grid gap-3 sm:grid-cols-3">
                  <input aria-label="Width" type="number" min="1" max="4000" placeholder="Width" value={imageWidth} onChange={(event) => setImageWidth(event.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                  <input aria-label="Height" type="number" min="1" max="4000" placeholder="Height" value={imageHeight} onChange={(event) => setImageHeight(event.target.value)} className="rounded-lg border border-slate-200 px-3 py-2 text-sm" />
                  <span className="self-center text-xs text-slate-500">At least one size is required.</span>
                </div>
              )}
              {imageOperation !== 'thumbnail' && (
                <label className="block text-sm font-semibold text-slate-700">
                  Output format
                  <select value={imageFormat} onChange={(event) => setImageFormat(event.target.value)} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-normal">
                    <option value="webp">WebP</option>
                    <option value="jpeg">JPEG</option>
                    <option value="png">PNG</option>
                  </select>
                </label>
              )}
            </section>
          ) : (
            <label className="block text-sm font-semibold text-slate-700">
              Payload JSON <span className="text-rose-500">*</span>
              <textarea
                value={payloadText}
                onChange={(event) => setPayloadText(event.target.value)}
                rows={8}
                spellCheck="false"
                className="mt-2 block w-full resize-y rounded-xl border border-slate-200 bg-slate-950 px-4 py-3 font-mono text-sm leading-6 text-emerald-100 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
                aria-describedby="payload-help"
              />
              <span id="payload-help" className="mt-1.5 block text-xs font-normal text-slate-500">
                {type === 'send_email'
                  ? 'Provide to, subject, and at least one of text or html. Provider acceptance does not confirm inbox delivery.'
                  : 'Provide a title and 1–20 sections; each section has a heading and paragraphs.'}
              </span>
            </label>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm font-semibold text-slate-700">
              Priority
              <select value={priority} onChange={(event) => setPriority(event.target.value)} className="mt-2 block w-full rounded-xl border border-slate-200 bg-white px-3.5 py-3 text-sm font-normal outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100">
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="text-sm font-semibold text-slate-700">
              Maximum attempts
              <input type="number" min="1" step="1" value={maxAttempts} onChange={(event) => setMaxAttempts(event.target.value)} className="mt-2 block w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-normal outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
            </label>
            <label className="text-sm font-semibold text-slate-700">
              Schedule for later <span className="font-normal text-slate-400">(optional)</span>
              <input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} className="mt-2 block w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-normal outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
            </label>
            <label className="text-sm font-semibold text-slate-700">
              Idempotency key <span className="font-normal text-slate-400">(optional)</span>
              <input maxLength="200" value={idempotencyKey} onChange={(event) => setIdempotencyKey(event.target.value)} placeholder="e.g. welcome-user-42" className="mt-2 block w-full rounded-xl border border-slate-200 px-3.5 py-3 text-sm font-normal outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
            </label>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-5">
            <AppLink href="/jobs" className="text-sm font-semibold text-slate-500 hover:text-slate-800">Cancel</AppLink>
            <button type="submit" disabled={submitting} className="rounded-xl bg-indigo-600 px-5 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-200 transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
              {submitting ? 'Submitting…' : 'Submit job'}
            </button>
          </div>
        </form>

        <aside className="h-fit rounded-2xl border border-indigo-100 bg-indigo-50/70 p-5">
          <p className="text-sm font-bold text-indigo-950">Before you submit</p>
          <ul className="mt-3 space-y-3 text-sm leading-6 text-indigo-900/80">
            <li className="flex gap-2"><span className="font-bold text-indigo-600">1.</span><span>Payload is stored as data and is never executed as code.</span></li>
            <li className="flex gap-2"><span className="font-bold text-indigo-600">2.</span><span>Repeated idempotency keys are rejected with a conflict response.</span></li>
            <li className="flex gap-2"><span className="font-bold text-indigo-600">3.</span><span>Generated files are private and can be downloaded only by their owner.</span></li>
          </ul>
        </aside>
      </div>
    </>
  )
}
