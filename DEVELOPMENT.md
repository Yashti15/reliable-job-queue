# Development Log

## Day 1 — Project foundation

### Goal

Create the client/server foundation and verify API health without claiming queue functionality.

### Planned work

- [x] Create the React/Vite client structure.
- [x] Create the Express API and MongoDB connection setup.
- [x] Add `GET /api/health` and a small client connection indicator.
- [x] Add initial README, architecture, API, and environment guidance.
- [x] Install dependencies and run the API test and client production build.

### Validation

- `npm test --prefix server` — passed (1 health-route test).
- `npm run build --prefix client` — passed (Vite production build).
- `npm install --prefix client` — reported 0 vulnerabilities.
- `npm audit --prefix server` — 0 vulnerabilities after pinning the transitive `minimatch` override to `^11.0.1` (resolved to 11.0.8). The earlier moderate advisory was for denial-of-service risk in `minimatch`, pulled in by `nodemon`.
- The dependency advisory scan found no known issues in the patched `minimatch` version or the directly declared dependencies.
- A live MongoDB connection was not tested because no database URI or running database was provided.

### Notes

No queue engine, worker, retry, lease, dead-letter, replay, or analytics behavior is complete yet.

## Day 1.5 — Atlas and Git setup

### Goal

Require a valid MongoDB connection before the backend listens, document local Atlas setup, and inspect Git safeguards.

### Changes

- Backend startup loads `server/.env` explicitly, independent of the current working directory.
- Missing MongoDB configuration now stops startup. Failed connection errors give safe troubleshooting hints without printing the URI or credentials.
- `.env.example` uses Atlas-style placeholders only; `.gitignore` excludes environment files, dependencies, build output, coverage, and logs.
- README, architecture, and API setup notes now describe the required database connection before the API listens.

### Validation

- `npm test --prefix server` — passed (3 tests: missing URI, malformed URI without secret disclosure, and health route).
- `node server/src/server.js` with no `server/.env` — exited with code 1 and `MONGODB_URI is missing`; the API did not start listening.
- MongoDB Atlas connection verified successfully through the `dev` script and `GET /api/health`; response reported `database: "connected"`.
- `server/.env` exists locally and is ignored by Git; its contents were not displayed.
- Git repository has no commits or remotes. Global Git user name and email are configured; values were not printed. GitHub CLI is not installed.

### Manual steps

- Review the pending project files before the initial commit.
- Never share or commit `server/.env`.

## Day 2 — Job model and submission APIs

### Goal

Persist validated jobs and expose APIs to create, list, retrieve, and cancel pending jobs.

### Changes

- Added the timestamped Mongoose `Job` schema, validation, and indexes.
- Added `POST /api/jobs`, paginated/filterable `GET /api/jobs`, `GET /api/jobs/:id`, and pending-only `DELETE /api/jobs/:id`.
- Route tests use an injected in-memory model; schema tests do not connect to Atlas or modify persistent data.
- Worker processing, retries, atomic claiming, frontend changes, and email delivery remain out of scope.

### Validation

- `npm test --prefix server` — passed (11 tests, 0 failures).
- Job route tests use an in-memory model and ephemeral HTTP ports; no Atlas data is modified.
- Mongoose schema tests validate defaults, required fields, enums, numeric bounds, timestamps, and idempotency index metadata without opening a database connection.

## Day 3 — Custom worker and atomic claiming

### Goal

Run independent workers that atomically claim and execute due jobs from MongoDB.

### Changes

- Added atomic priority-ordered job claiming and conditional owner-checked completion/failure updates.
- Added a standalone worker entry point, configurable polling, graceful shutdown, and a handler registry with a simulated `send_email` handler.
- Added worker ownership fields and a polling index to the Job model.
- Added local-only MongoDB integration tests. They require `MONGODB_TEST_URI` pointing to `localhost`/`127.0.0.1` with a database name ending in `_test`; test code generates a unique database name and drops only that database. Never point this setting at Atlas or a production database.

### Validation

- `MONGODB_TEST_URI=mongodb://127.0.0.1:27017/rq_test npm test --prefix server` (PowerShell environment-variable equivalent) — passed (24 tests, 0 failures, 0 skipped).
- Real local MongoDB tests issued concurrent `findOneAndUpdate()` claims from two worker IDs; exactly one claimed the same job. Priority order, oldest-first tie breaking, and future schedule exclusion were also tested against MongoDB.
- Worker integration tests exercised simulated success, handler failure, unknown job types, and owner-conditional completion/failure. Unit tests verified idle and in-flight graceful shutdown.
- Test fixture connected only to loopback MongoDB, created unique `_test` databases, and dropped those generated databases. Atlas was not used by tests.

## Day 4 — Automatic retries and exponential backoff

### Goal

Schedule failed executions for bounded exponential-backoff retries and mark jobs failed after their total attempt limit.

### Changes

- Added deterministic exponential-backoff/jitter calculation and validated worker retry configuration.
- Failure updates now atomically match job ID, processing status, worker ID, and the claimed attempt count; increment attempts once; schedule pending retries or finalize failed jobs; and clear ownership.
- Worker handler failures and completion-update failures now follow separate paths, so a successful handler is not retried because completion persistence later failed.
- Added retry settings to `.env.example` and documented `maxAttempts` semantics.

### Validation

- `MONGODB_TEST_URI=mongodb://127.0.0.1:27017/rq_test npm test --prefix server` (PowerShell environment-variable equivalent) — passed (**36 tests, 0 failures, 0 skipped**).
- The local MongoDB integration tests covered real concurrent claims, priority order, scheduled eligibility, retry scheduling, one-time attempt increments, final failure at `maxAttempts`, owner clearing, stale-worker rejection, and succeeding on a later attempt.
- Deterministic utility tests covered exponential growth, jitter bounds, delay cap, and invalid configuration/randomness. Worker unit tests confirmed successful handlers do not enter the retry path and shutdown still waits for an in-flight job.
- The integration fixture was configured to loopback MongoDB only and generated isolated `_test` database names. Atlas was not used.

## Day 5 — Worker leases, heartbeats, and crash recovery

### Goal

Give processing jobs temporary ownership, renew it while handlers run, and safely recover jobs from workers that stop before completing.

### Changes

- Added `leaseExpiresAt` and a per-claim `claimToken`, with an index for finding processing jobs by lease expiration.
- Claims now atomically lease pending jobs and reclaim only expired processing jobs. A reclaimed execution increments `attempts` once; expired jobs reaching `maxAttempts` are marked `failed`.
- Added conditional lease renewal, and require current worker ID, claim token, processing status, and an unexpired lease for heartbeat, success, and ordinary failure/retry updates.
- Added validated lease and heartbeat settings. Heartbeat loss or errors are logged and prevent stale handler results from being saved.
- Documented that a generic handler's external side effect cannot always be cancelled after lease loss; stale queue-state writes are still rejected.

### Validation

- `$env:MONGODB_TEST_URI='mongodb://127.0.0.1:27017/reliable_job_queue_test'; npm test --prefix server` — passed (**47 tests, 0 failures, 0 skipped**); the environment variable was removed after the run.
- Local MongoDB integration tests covered lease expiry, heartbeat renewal, claim-token rotation, rejection of stale completion/failure/renewal (including a re-claim by the same worker ID), concurrent expired-lease recovery, and max-attempt terminal failure.
- Worker unit tests covered heartbeat cleanup, lost ownership preventing result persistence, heartbeat/lease configuration validation, and graceful shutdown. Existing API, scheduling, priority, retry, and successful execution tests passed.
- The test fixture accepted only the explicit loopback MongoDB URI, generated an isolated test database, and removed only that generated database. Atlas was not used. `git diff --check` passed.

## Day 6 — Dead-letter queue, manual replay, and idempotency

### Goal

Move jobs that exhaust attempts into a dead-letter state, expose safe inspection/replay APIs, and verify job-creation idempotency under concurrent requests.

### Changes

- Exhausted ordinary failures and expired-lease executions now transition the original job document to `dead`, record `deadAt` and `lastError`, and clear active worker/lease/token ownership.
- Added paginated `GET /api/jobs/dead` and atomic `POST /api/jobs/:id/replay`, with optional future `runAt`, attempt reset, stale ownership clearing, and a replay history capped at 20 entries.
- Preserved MongoDB's partial unique index for `idempotencyKey`; concurrent duplicate creation remains a consistent `409 IDEMPOTENCY_KEY_CONFLICT`. Replay retains the same key and updates the same job rather than inserting a second record.
- Documented that request-key uniqueness does not provide exactly-once external side effects.

### Validation

- `$env:MONGODB_TEST_URI='mongodb://127.0.0.1:27017/reliable_job_queue_test'; npm test --prefix server` — passed (**57 tests, 0 failures, 0 skipped**); the environment variable was removed after the run.
- Local MongoDB integration tests exercised concurrent duplicate creation, concurrent replay, idempotency-key retention, stale-worker rejection after replay/re-claim, dead-letter transitions, lease recovery, retries, priority, and scheduling.
- API tests covered dead-list pagination, job detail retrieval, replay body/date validation, replay audit data, and concurrent replay/duplicate handling. The integration fixture allowed only local MongoDB and used an isolated generated test database; Atlas was not used.
- `git diff --check` passed.

## Day 7 — React dashboard and job management

### Goal

Replace the starter health page with a responsive operator dashboard integrated with existing job APIs.

### Changes

- Added overview metrics from the API's actual filtered totals and a recent-jobs table.
- Added jobs listing with server-backed status filtering and pagination, plus current-page search/priority filtering and pending-job cancellation.
- Added a validated `send_email` job form, job details/replay audit view, and paginated dead-letter list with confirmation and replay.
- Centralized Axios operations and API error formatting; default API base is `/api` with the existing Vite proxy. Documented optional `VITE_API_BASE_URL`.
- No backend changes or frontend test framework were added; no dedicated frontend test runner is configured in the project.

### Validation

- `npm run build --prefix client` — passed.
- Frontend tests — none configured.
- Full browser/API smoke test used a temporary API and worker connected only to a loopback MongoDB database: live metrics loaded, a valid job was created and displayed in details and the jobs table, the worker completed a valid simulated email job, an invalid handler payload was blocked in the form, a failing job entered the DLQ, and confirmed replay returned it to the pending flow with success feedback.
- `MONGODB_TEST_URI='mongodb://127.0.0.1:27017/reliable_job_queue_test' npm test --prefix server` — passed (**57 tests, 0 failures, 0 skipped**). Integration tests used generated local `_test` databases; Atlas was not used.
- `git diff --check` — passed.

## Day 8 — Socket.IO updates, worker monitoring, and analytics

### Goal

Notify the dashboard of persisted queue lifecycle changes across separate API/worker processes, monitor worker liveness, and show bounded analytics derived from MongoDB.

### Changes

- Added a MongoDB-backed queue event collection with 24-hour retention. API and worker processes publish allowlisted job/worker notifications; the API polls and broadcasts them through Socket.IO. Payloads exclude job data, errors, idempotency keys, claim tokens, and credentials.
- Attached Socket.IO to the API HTTP server and added graceful shutdown for the event bridge, sockets, and MongoDB connection. The Vite development server proxies the Socket.IO endpoint.
- Registered worker records and heartbeats in MongoDB. The worker API distinguishes active, idle, unresponsive (stale heartbeat), and gracefully stopped workers.
- Added `/api/analytics` with a 30-day aggregation, terminal success/failure rates, and average duration for completed jobs with both execution timestamps.
- Added a shared React Socket.IO connection with listener cleanup, connection state, and REST refetch on connect/reconnect and lifecycle events. Dashboard metrics and worker status now use the analytics/worker APIs and refresh without manual reload.
- Documented event names, payloads, origin configuration, metric definitions, and the best-effort delivery/authentication limitations.

### Validation

- `$env:MONGODB_TEST_URI='mongodb://127.0.0.1:27017/reliable_job_queue_test'; npm test --prefix server` — passed (**68 tests, 0 failures, 0 skipped**). Integration tests ran only against loopback MongoDB and generated isolated `_test` databases; the environment variable was removed after the run. Atlas was not used.
- `npm run build --prefix client` — passed (Vite production build).
- No frontend test runner is configured. A browser smoke test connected the dashboard to the local API and worker, created a simulated `send_email` job, observed the worker complete it, and verified dashboard totals/recent jobs updated from socket notifications without manual refresh.
- The browser smoke test used only a temporary loopback MongoDB database ending in `_test`; API, worker, and Vite processes were stopped and that exact temporary database was dropped afterward.
- `git diff --check` — passed.

### Delivery limitations

At the Day 8 checkpoint, socket events were best-effort notifications stored for at most 24 hours; the API bridge started from the latest event and did not replay prior notifications after restart. Clients refetched REST state on reconnect. Day 9 adds authenticated, tenant-scoped access but does not change the event-delivery guarantee.

## Day 9 — Authentication and tenant isolation

### Goal

Add account sessions and ensure jobs, worker visibility, analytics, idempotency, and real-time events are isolated by authenticated user.

### Changes

- Added registration/login/logout/current-user/CSRF endpoints, bcrypt password hashing, IP-based authentication throttling, and short-lived HS256 sessions in `HttpOnly`, `SameSite=Strict` cookies. Unsafe requests require a double-submit CSRF token and allowed origin; production cookies are `Secure`.
- Protected job, analytics, and worker APIs. Job ownership is derived only from the verified session and included in data reads/writes; job creation uses a compound per-owner idempotency index.
- Authenticated Socket.IO handshakes, server-controlled per-user rooms, token-expiry disconnects, and owner-required queue event records prevent cross-tenant event delivery.
- Added frontend session restoration, login/register forms, protected dashboard views, signed-in identity/sign-out controls, and socket cleanup on user change.
- Added local-only index migration and explicit single-job legacy owner assignment scripts. Ownerless legacy jobs remain hidden and are not claimable until verified. Both scripts reject non-loopback hosts and database names not ending in `_dev` or `_test`; production migration is intentionally not automated.
- Documented session/CSRF configuration, tenant query scoping, worker-sharing limitations, migration steps, and known session/legacy-data limitations.

### Validation

- `$env:MONGODB_TEST_URI='mongodb://127.0.0.1:27017/reliable_job_queue_test'; npm test --prefix server` — passed (**81 tests, 0 failures, 0 skipped**). MongoDB integration tests used unique generated databases on the local MongoDB service; no Atlas/production database was used.
- `npm run build --prefix client` — passed (Vite production build).
- No frontend test runner is configured. Backend integration tests exercised registration/password hashing, login, session validation, tenant-scoped job access, same-key isolation across tenants, worker/analytics isolation, concurrent job creation/replay, and queue/worker regression behavior.
- Index migration and explicit legacy-owner assignment commands were run twice each against a disposable loopback `_test` database; repeat runs were safe and the exact database was dropped afterward.
- `git diff --check` — passed.

### Limitations

JWT sessions are not revocable before expiry, and logout clears only the client cookie. There is no password recovery/email verification, role system, dedicated per-tenant worker process, or production/Atlas data migration utility. Legacy ownerless jobs remain inaccessible and unclaimable until ownership is explicitly verified. Socket events remain best-effort notifications, and job creation idempotency does not guarantee exactly-once external side effects.

## Day 10 — Real-world job execution

### Goal

Replace simulated worker behavior with actual email submission, PDF generation, and image processing while preserving queue lease, retry, DLQ, and tenant ownership guarantees.

### Changes

- Replaced the simulated email handler with a server-only Resend HTTP integration, validated email/PDF/image payloads, bounded timeouts, safe provider errors, and acceptance-only result metadata.
- Added real PDFKit report output with a UTC generation timestamp and Sharp resize/convert/thumbnail handlers. Uploaded source images are validated as actual JPEG/PNG/WebP bytes; arbitrary paths and remote URLs are not accepted. Processed images render as authenticated inline previews; PDF downloads remain attachments.
- Added authenticated/CSRF-protected raw image uploads and owner/job-checked artifact downloads. Output bytes live under private owner-scoped filesystem directories; MongoDB stores only bounded metadata.
- Persisted handler result metadata only within the existing conditional atomic completion update. Added per-job unique output metadata and reuse for retry/replay protection; replay clears prior result.
- Extended the dashboard job form for all three job types and exposed safe result metadata/private artifact downloads on job details.
- Documented server environment setup, payload constraints, storage, authorization, retries, and external-effect idempotency limitations.

### Manual configuration

- To send actual email locally, create a Resend account, generate a server API key, and configure a permitted sender/domain. Set the server-only provider credentials and explicit safety policy in ignored `server/.env`; never put the key in frontend settings or chat. Email tests use a mock and do not send messages.
- Shared-provider sending remains disabled unless `EMAIL_SENDING_ENABLED=true` and a non-empty `EMAIL_ALLOWED_RECIPIENTS` allowlist are configured. The allowlist supports exact email addresses and exact domains prefixed with `@`. Daily per-user/global quotas default to 5/100 and the per-user minute limit defaults to 3. MongoDB atomic counters enforce separate submission/replay limits in the API and actual send limits immediately before provider calls, preventing scheduled-job bursts from bypassing daily controls. A provider attempt is conservatively counted even if its acceptance is uncertain. Email job attempts are capped at 3. Other job types are unaffected.
- PDF/image handlers work without provider configuration. Files are stored under `server/storage` by default; `JOB_STORAGE_DIR` can point to another private server-side directory.

### Validation

- `$env:MONGODB_TEST_URI='mongodb://127.0.0.1:27017/reliable_job_queue_test'; npm test --prefix server` — passed (**93 tests, 0 failures, 0 skipped**). Tests used only loopback MongoDB with isolated `_test` databases and temporary filesystem storage.
- `npm run build --prefix client` — passed (Vite production build). No frontend test runner is configured.
- Handler tests covered mocked Resend configuration, success/acceptance metadata, rejection, rate limiting, timeout, actual PDF creation, image resize/conversion and corrupted inputs, storage-root environment loading, output reuse, and safe path handling. Route tests covered validated image upload and owner-checked artifact access. Queue integration tests verified result metadata is persisted only after the active claim and extra file-path metadata is excluded.
- Added a server-side email abuse policy: disabled-by-default provider calls, mandatory exact-address/domain allowlisting when enabled, per-user/minute and per-user/global-day MongoDB quota reservations at both submission and actual execution, restrictions on email replays, and a 3-attempt maximum for email jobs. Tests cover disabled sending, recipient rejection, rate limits, per-user/global quota boundaries, replay and execution quota enforcement, and unaffected PDF job creation.
- No email was sent and no Atlas/production database was used. Resend credentials were not configured, so actual external email delivery was not attempted.
- Dependency CVE assessment for the resolved server npm dependency set reported no known vulnerabilities.
- `git diff --check` — passed.

## Day 11 advanced reliability and fault-tolerance verification

### Changes

- Added real-MongoDB concurrency tests for 16 workers racing to claim one job, completion racing a failure update, and heartbeat renewal racing lease recovery. Assertions verify one persisted owner/outcome, token changes on recovery, and single attempt increments.
- Added a worker-restart failure-injection test: handler work succeeds but completion persistence throws; the job remains durably processing, expires, is reclaimed by a second worker, and completes with the abandoned execution counted once.
- Added API restart persistence, temporary MongoDB polling/heartbeat failure, and lease-expiry-during-handler tests. The recovery worker completes the reclaimed job while the stale handler's result is not persisted.
- Added safe monotonic handler-duration fields to worker completion/failure logs. Logs continue to omit payloads, credentials, JWTs, and claim tokens.
- Added a local-only REST enqueue and concurrent claim/completion benchmark. It uses the process-specific isolated test-database helper and fails closed for non-loopback MongoDB URIs.
- Added a PDF-storage outage test verifying filesystem details are not exposed through the job-safe error.

### Measured benchmark

Run on 2026-11-14 using Node.js v25.6.0 on Windows x64 (22 logical processors, 15.5 GiB reported memory) with a local MongoDB test server. MongoDB server version was not captured. Each cell was run once; treat these as a machine-specific baseline, not a statistically stable or production-capacity result. Submission concurrency was 16. The workload submitted through the REST router, then drained using the stated number of concurrent claim/completion loops; it did not execute real job handlers.

| Jobs | Workers | Submit jobs/s | Submit request p95 ms | Claim + completion jobs/s | Mean queue latency ms | Completion write p95 ms | Completed |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 100 | 1 | 260.21 | 138.07 | 119.73 | 569.12 | 2.16 | 100 |
| 100 | 4 | 509.84 | 37.55 | 140.70 | 457.37 | 6.20 | 100 |
| 500 | 1 | 304.08 | 65.81 | 90.70 | 3579.37 | 2.84 | 500 |
| 500 | 4 | 361.34 | 61.23 | 172.76 | 2121.57 | 4.84 | 500 |

Mean queue latency is measured from persisted creation time to claim, after the entire submission batch is enqueued; it includes batch-submission wait. Completion write p95 is only the conditional completion update duration. The small sample and local database make these figures unsuitable for comparing hardware or forecasting deployment capacity.

### Validation

- Complete backend suite: **114 passed, 0 failed, 0 skipped** using `MONGODB_TEST_URI=mongodb://127.0.0.1:27017/reliable_job_queue_test`; integration helper created/dropped isolated local `_test` databases.
- Concurrency, replay, API restart, and worker recovery integration subset: **30 passed, 0 failed, 0 skipped**.
- Handler, storage outage, worker observability, and artifact route tests: **29 passed, 0 failed, 0 skipped** across the focused runs.
- Frontend production build: passed. No frontend test runner is configured.
- Local benchmark: all four scenarios completed their expected job count (100/100, 100/100, 500/500, 500/500); reported metrics above are from the latest run.
- `git diff --check`: passed.

### Guarantees and limits

- MongoDB atomic filters ensure only one valid claim/transition wins; the tests exercise actual concurrent database operations. They do not prove behavior under every network partition, clock skew, storage hardware failure, or MongoDB topology.
- Worker crash recovery is lease-based. A running handler may continue an external side effect after lease loss; stale queue persistence is rejected, but an email may be duplicated if provider idempotency is unavailable or expires.
- Local file storage is not replicated. API and workers on separate machines need a shared private filesystem. Orphans after abrupt process/filesystem failures and retention cleanup remain operational responsibilities.
- The benchmark is a local microbenchmark, not a load test of production topology or real handler cost. No external penetration test was performed.

## Docker Compose security hardening

- Bound the Compose MongoDB, API, and UI ports to loopback only.
- Removed the fixed JWT signing secret. Compose now requires a locally supplied `AUTH_JWT_SECRET`, and API startup rejects missing or shorter-than-32-byte secrets.
- Enabled MongoDB root authentication using locally supplied Compose environment variables; the API, worker, and MongoDB healthcheck authenticate against the local database.
- Updated `.env.example` and the README with local secret-generation and setup guidance. No credentials were added to tracked files.
