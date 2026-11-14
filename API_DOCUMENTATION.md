# API Documentation

## Base URL

The API listens on `http://localhost:5000` by default. Set `PORT` to use another port. The Vite client proxies `/api` requests to this service in development.

## `GET /api/health`

Returns the API status and current MongoDB connection state.

### Example response

```json
{
  "status": "ok",
  "service": "reliable-job-queue-api",
  "database": "connected"
}
```

`database` is `disconnected`, `connecting`, `connected`, or `disconnecting`. The API loads `MONGODB_URI` from `server/.env` and connects before accepting requests, so missing configuration or a failed initial connection prevents the server from starting. The connection string is never included in startup error messages.

## Authentication and tenant isolation

All endpoints below `/api/jobs`, `/api/analytics`, `/api/workers`, and `/api/uploads` require a valid session cookie. `/api/health` and the session bootstrap/login endpoints are public. Registration and login return an `HttpOnly`, `SameSite=Strict` session cookie containing a 30-minute JWT; the token is not returned in JSON or stored in browser storage. Production cookies are `Secure`. Registration requires a password of at least 12 characters and rejects passwords longer than 72 UTF-8 bytes.

### `GET /api/auth/csrf`

Returns a CSRF token and sets the readable `rq_csrf` cookie:

```json
{
  "success": true,
  "data": { "csrfToken": "<random-token>" }
}
```

Before any state-changing request, send the cookie and the same value in the `X-CSRF-Token` header. The API also rejects a supplied `Origin` not present in the exact `CLIENT_ORIGIN` allowlist.

### `POST /api/auth/register`

```json
{ "name": "Queue Operator", "email": "operator@example.com", "password": "a-long-password-123" }
```

Returns `201` with `{ "success": true, "data": { "user": { "id": "...", "name": "...", "email": "..." } } }` and sets the session cookie. Email is trimmed and lowercased. Duplicate email returns `409 EMAIL_IN_USE`; invalid input returns `400 INVALID_REGISTRATION`. Authentication attempts are rate-limited.

### `POST /api/auth/login`

Send `{ "email": "operator@example.com", "password": "..." }` with CSRF cookie/header. Returns the same safe user shape and sets the session cookie. Invalid email/password returns `401 INVALID_CREDENTIALS` with the same message for unknown users and incorrect passwords.

### `GET /api/auth/me`

Returns the current safe user profile. Missing, invalid, expired, or deleted-user sessions return `401 AUTH_REQUIRED`.

### `POST /api/auth/logout`

Requires the CSRF cookie/header and clears session/CSRF cookies. Returns `204`. This is client-side session clearing; JWTs are not revocable and a copied token remains valid until expiry.

Job creation assigns `ownerId` from the authenticated session; clients cannot choose it. All job lookup/list/delete/replay queries, analytics, worker visibility, and real-time notifications are tenant-scoped. Reusing an idempotency key is independent between users; within one user, MongoDB's unique compound index makes duplicate requests conflict-safe. Legacy ownerless jobs are unavailable and unclaimable until explicitly mapped.

For local development only, `npm run migrate:tenant-indexes` builds the per-tenant idempotency index before dropping the legacy global index. It requires `ALLOW_TENANT_INDEX_MIGRATION=1`, loopback MongoDB, and a database name ending in `_dev` or `_test`. `npm run assign:legacy-job-owner` requires explicit `LEGACY_JOB_ID` and `LEGACY_OWNER_ID` values and applies to one record only. Neither script can target Atlas/production; production index and data migration require an independently reviewed procedure.

## Jobs

Job creation accepts `type`, object `payload`, and optional `priority`, `runAt`, `maxAttempts`, and `idempotencyKey`. The API controls `status`, `attempts`, timestamps, and `lastError`.

### `POST /api/jobs`

Creates a pending job.

```json
{
  "type": "send_email",
  "payload": { "to": "learner@example.com", "subject": "Welcome" },
  "priority": "high",
  "runAt": "2026-11-14T08:00:00.000Z",
  "maxAttempts": 4,
  "idempotencyKey": "welcome-email-user-42"
}
```

Returns `201 Created`:

```json
{
  "success": true,
  "data": {
    "job": {
      "_id": "6735a1b2c3d4e5f678901234",
      "type": "send_email",
      "payload": { "to": "learner@example.com", "subject": "Welcome" },
      "status": "pending",
      "priority": "high",
      "attempts": 0,
      "maxAttempts": 4,
      "runAt": "2026-11-14T08:00:00.000Z",
      "idempotencyKey": "welcome-email-user-42",
      "createdAt": "2026-11-13T10:00:00.000Z",
      "updatedAt": "2026-11-13T10:00:00.000Z"
    }
  }
}
```

Invalid input returns `400`; reusing an existing idempotency key returns `409` with `IDEMPOTENCY_KEY_CONFLICT`. MongoDB's partial unique index is the concurrency-safe enforcement point, so concurrent requests cannot insert two jobs with the same provided key. Reusing the key is reported as a conflict rather than returning/creating another job.

This key deduplicates job creation only. It does not ensure the handler's external side effect executes exactly once. Integrations such as email or payment providers need separate side-effect idempotency.

### `GET /api/jobs`

Lists jobs ordered newest first. `page` defaults to `1`, `limit` defaults to `20` (maximum `100`), and `status` is optional.

Example: `GET /api/jobs?page=1&limit=20&status=pending`

Returns `200 OK`:

```json
{
  "success": true,
  "data": {
    "jobs": [],
    "pagination": { "page": 1, "limit": 20, "total": 0, "totalPages": 0 }
  }
}
```

Invalid pagination or status returns `400`.

### `GET /api/jobs/:id`

Returns one job with `200 OK`; malformed MongoDB ObjectIds return `400`; valid IDs with no matching job return `404`.

### `GET /api/jobs/dead`

Lists dead-lettered jobs newest first by `deadAt` (then `_id`), with the same pagination defaults and maximum as `GET /api/jobs`.

Example: `GET /api/jobs/dead?page=1&limit=20`

The response uses `data.jobs` and `data.pagination`. Invalid page/limit values return `400 INVALID_PAGINATION`. Dead jobs remain in the original jobs collection and retain `type`, `payload`, attempts, `maxAttempts`, `lastError`, `deadAt`, and replay audit metadata.

### `POST /api/jobs/:id/replay`

Replays a dead job through the normal pending-job scheduling and worker flow. The body may be empty to schedule it now, or specify a future `runAt`:

```json
{
  "runAt": "2026-11-15T08:00:00.000Z"
}
```

Returns `200 OK`:

```json
{
  "success": true,
  "data": {
    "replayed": true,
    "job": {
      "_id": "6735a1b2c3d4e5f678901234",
      "type": "send_email",
      "payload": { "to": "learner@example.com", "subject": "Welcome" },
      "status": "pending",
      "attempts": 0,
      "maxAttempts": 4,
      "replayCount": 1,
      "replayHistory": [
        {
          "replayedAt": "2026-11-14T08:00:00.000Z",
          "previousAttempts": 4,
          "previousLastError": "Job processing failed (TypeError)."
        }
      ]
    }
  }
}
```

Only a `dead` job can be replayed. A malformed ID returns `400 INVALID_JOB_ID`, missing job returns `404 JOB_NOT_FOUND`, and non-dead or already concurrently replayed jobs return `409 JOB_NOT_REPLAYABLE`. Invalid replay bodies or non-future `runAt` values return `400`. Replay is one conditional database update: status changes only once, attempts reset to zero, `runAt` is set, and previous worker/lease/token fields are cleared. Type, payload, idempotency key, and final error are retained. The audit history stores prior attempts/error and replay time and is capped to 20 entries.

### `DELETE /api/jobs/:id`

Cancels a pending job by deleting its record. The conditional delete matches both the ID and `status: "pending"`. Returns `200 OK` with `{ "success": true, "data": { "cancelled": true, "job": {} } }`. Returns `409 JOB_NOT_CANCELLABLE` for processing/completed/other non-pending jobs, or `404` when the ID does not exist. This API does not introduce a `cancelled` status.

Job execution is handled by a separate worker process, not by an HTTP request. The worker claims due pending jobs and records `completed`, schedules a retry, or moves an exhausted job to `dead`. Expired executions that exhaust the attempt limit also become `dead`. Dead jobs are never claimed by normal workers; a successful replay returns one to the normal pending flow.

## Analytics

### `GET /api/analytics`

Returns an aggregation for jobs created in the preceding 30 days:

```json
{
  "success": true,
  "data": {
    "periodDays": 30,
    "jobs": {
      "total": 42,
      "pending": 4,
      "processing": 2,
      "completed": 32,
      "failed": 1,
      "dead": 3
    },
    "terminal": {
      "total": 36,
      "successRate": 88.9,
      "failureRate": 11.1
    },
    "averageExecutionDurationMs": 830,
    "generatedAt": "2026-11-14T08:00:00.000Z",
    "windowStart": "2026-10-15T08:00:00.000Z"
  }
}
```

Status counts are the current status of in-window jobs, not historical transition totals. Rates use terminal jobs only: success is `completed / (completed + failed + dead)`; failure is `(failed + dead) / terminal total`. Both rates are zero if there are no terminal jobs. Average duration is the arithmetic mean of `completedAt - claimedAt` for completed jobs with both timestamps and is `null` when no valid samples exist. This endpoint does not provide historical trends.

## Worker monitoring

### `GET /api/workers`

Returns at most 100 records, newest `lastSeenAt` first. State is derived from the latest stored worker heartbeat and configured heartbeat interval:

```json
{
  "success": true,
  "data": {
    "workers": [
      {
        "workerId": "worker-local-1",
        "state": "active",
        "lastSeenAt": "2026-11-14T08:00:00.000Z",
        "startedAt": "2026-11-14T07:55:00.000Z",
        "currentJobId": "6735a1b2c3d4e5f678901234",
        "currentJobType": "send_email"
      }
    ],
    "counts": {
      "active": 1,
      "idle": 0,
      "unresponsive": 0,
      "disconnected": 0,
      "total": 1
    },
    "checkedAt": "2026-11-14T08:00:01.000Z",
    "staleAfterMs": 30000
  }
}
```

`active` means a fresh heartbeat with a current job; `idle` means a fresh heartbeat without a current job; `unresponsive` means an active record is older than three heartbeat intervals; `disconnected` means a graceful stop was recorded. A hard crash is detected as unresponsive, not as a clean disconnect. Worker records expire after 30 days.

## Socket.IO notifications

Connect a Socket.IO client to the API origin (the `VITE_API_BASE_URL` host when configured) and include the session cookie. The development Vite server proxies `/socket.io` to port 5000. `CLIENT_ORIGIN` is a comma-separated exact-origin allowlist; when omitted, localhost and 127.0.0.1 origins are accepted. The handshake validates the JWT and current user; room membership is assigned by the server and clients cannot select another tenant's room. Sockets are disconnected when the token expires.

Events:

- `job:created`, `job:claimed`, `job:completed`, `job:failed`, `job:retried`, `job:dead`, `job:replayed`, `job:cancelled`
- `worker:updated`, `worker:heartbeat`

Job event example (fields are included when available):

```json
{
  "jobId": "6735a1b2c3d4e5f678901234",
  "type": "send_email",
  "status": "completed",
  "priority": "high",
  "attempts": 0,
  "maxAttempts": 4,
  "completedAt": "2026-11-14T08:00:00.000Z"
}
```

Event payloads intentionally omit job payloads, `lastError`, idempotency keys, claim tokens, and lease secrets. Worker events contain worker ID, state, last-seen timestamp, and the current job ID/type when available. They are notifications, not a read API or a delivery guarantee. The API stores events in MongoDB with a 24-hour TTL and polls them for socket forwarding; events written before API startup are skipped when the bridge initializes, and disconnected clients can miss notifications. Dashboard clients must refetch REST state on connect/reconnect. Each persisted event carries an owner ID and is emitted only to that owner's server-controlled room.

## Worker process

Run the API and worker in separate terminals from the `server` directory:

```powershell
npm run dev
```

```powershell
npm run worker
```

Start another worker in another terminal with `npm run worker` to process jobs concurrently. Workers read the same `MONGODB_URI` as the API. `WORKER_POLL_INTERVAL_MS` defaults to `2000`; `WORKER_ID` is optional and is generated uniquely if omitted. Workers register the `send_email`, `generate_pdf`, and `process_image` handlers described below.

### Retry behavior

Each failed handler execution increments `attempts` once. `maxAttempts` counts total executions, including the first: with `maxAttempts: 3`, failures after executions 1 and 2 schedule retries, while failure after execution 3 moves the job to `dead`. A crash-recovered abandoned execution also increments attempts once; if it exhausts the limit, the job is dead-lettered. Replay resets attempts to zero while preserving a bounded record of prior failures and replay times.

Claims, lease renewals, completions, failures, and replays use conditional MongoDB updates. A worker must still own the unexpired lease and matching claim token to persist completion/failure. An expired lease can be reclaimed, so handler execution is at least once; a completion-write outage after an external side effect can result in a repeated handler invocation. The queue does not guarantee exactly-once external effects. Resend idempotency and per-job artifact reuse are best-effort mitigations.

API/worker restarts do not discard MongoDB job state. If a worker exits while a job is `processing`, another worker can recover it after `leaseExpiresAt`; recovery counts that abandoned execution once and sends the job to `dead` if the configured attempt limit is exhausted. Socket notifications are best-effort and are not an alternative to reading the job through REST.

The retry number is the incremented `attempts` value:

```text
baseDelay = min(BASE_DELAY_MS × 2^(attempts - 1), MAX_RETRY_DELAY_MS)
jitter = random integer from 0 to min(baseDelay × RETRY_JITTER_RATIO, MAX_RETRY_DELAY_MS - baseDelay)
retryDelay = baseDelay + jitter
```

Defaults are `BASE_DELAY_MS=2000`, `MAX_RETRY_DELAY_MS=60000`, and `RETRY_JITTER_RATIO=0.2`. The jitter ratio must be between 0 and 1. `runAt` becomes the failure time plus `retryDelay`; workers do not claim the job before that time. A successful handler is completed and is not retried.

## Real job types and private artifacts

Job payloads are validated by their worker handler. The API stores only the payload supplied at creation; handler results are added to `job.result` only after a worker's current claim token and lease are verified in the atomic completion update. The result contains bounded public metadata, never file bytes, storage paths, email content, or API credentials.

### `send_email`

Requires server-only `RESEND_API_KEY`, `EMAIL_FROM`, and optionally `EMAIL_PROVIDER_TIMEOUT_MS` (default 10000 ms, minimum 100 ms). Keep these settings in `server/.env`, never in a `VITE_` variable. Configure a sender address/domain with Resend before use. Example:

```json
{
  "type": "send_email",
  "payload": {
    "to": "learner@example.com",
    "subject": "Weekly report",
    "text": "Your report is ready.",
    "html": "<p>Your report is ready.</p>"
  },
  "maxAttempts": 3
}
```

The recipient must have valid email syntax; subject is required and limited to 200 characters. At least one of `text` (maximum 10,000 characters) or `html` (maximum 20,000 characters) is required. On provider success, the job result has `type: "email"`, `provider: "resend"`, `status: "accepted"`, and may include `providerMessageId`. `accepted` is not inbox delivery confirmation. Provider 429/5xx/network/timeout failures enter the existing retry process; permanent provider rejection and missing configuration are safe failures. Retries reuse an idempotency key derived from job ID and replay count when supported by the provider. External exactly-once delivery is not guaranteed, particularly after worker lease loss or provider idempotency retention expiration.

### `generate_pdf`

Payload shape:

```json
{
  "type": "generate_pdf",
  "payload": {
    "title": "Weekly queue report",
    "sections": [
      {
        "heading": "Summary",
        "paragraphs": ["Twelve jobs completed successfully."]
      }
    ]
  }
}
```

Title is limited to 160 characters. Reports require 1–20 sections, headings up to 120 characters, at most 12 paragraphs per section, 2,000 characters per paragraph, and 80,000 total text characters. The generated document includes its UTC ISO-8601 generation timestamp. A rendered PDF is limited to 10 MB.

### `process_image`

Upload image bytes first to `POST /api/uploads/images` using an authenticated session, CSRF header/cookie, and the image's `Content-Type` (`image/jpeg`, `image/png`, or `image/webp`). The request body is the raw image bytes, not JSON or multipart. Uploads are limited to 5 MB, 4000 pixels on either side, and 16 megapixels. The API validates the actual image bytes and returns an opaque `asset.id`.

Upload response:

```json
{
  "success": true,
  "data": {
    "asset": {
      "id": "6735a1b2c3d4e5f678901234",
      "fileName": "source.jpg",
      "mediaType": "image/jpeg",
      "sizeBytes": 12345,
      "width": 640,
      "height": 480
    }
  }
}
```

Create an image job with the returned ID. Supported operations:

```json
{ "type": "process_image", "payload": { "assetId": "6735a1b2c3d4e5f678901234", "operation": "resize", "width": 800, "format": "webp" } }
{ "type": "process_image", "payload": { "assetId": "6735a1b2c3d4e5f678901234", "operation": "convert", "format": "png" } }
{ "type": "process_image", "payload": { "assetId": "6735a1b2c3d4e5f678901234", "operation": "thumbnail" } }
```

Resize requires width and/or height between 1 and 4000 and optionally accepts `jpeg`, `png`, or `webp`. Convert requires one of those formats. Thumbnail is fixed at 256×256 WebP. The source must be an upload owned by the authenticated job owner; remote URLs, arbitrary paths, and shell commands are not supported. Output images are limited to 10 MB.

### Output downloads

`job.result.artifacts` contains safe file metadata (`assetId`, `fileName`, `mediaType`, `sizeBytes`). Download via:

```http
GET /api/jobs/:jobId/artifacts/:artifactId
```

The session owner must own a completed job and the artifact must be associated with that job and listed in its persisted result. Otherwise the endpoint returns `404 ARTIFACT_NOT_FOUND`. PDF responses use attachment disposition; processed images use inline disposition for authenticated previews. Both use `private, no-store` and `nosniff` headers. The default private filesystem root is `server/storage`; set `JOB_STORAGE_DIR` in the server environment to use another directory. It must not be exposed as a static/public web directory. Artifacts are not stored in MongoDB. Storage retention/cleanup is currently a manual operational responsibility.
