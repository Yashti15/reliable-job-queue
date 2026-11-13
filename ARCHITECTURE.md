# Architecture

## Current foundation (Day 1)

This is a JavaScript monorepo with two separate applications:

- `client/`: React user interface served by Vite. In development, Vite proxies `/api` requests to the Express API.
- `server/`: Express API and Mongoose connection management.
- MongoDB: persistence layer, enabled by `MONGODB_URI`.

The current API contains only a health endpoint. Queue behavior, job data, workers, and dashboard analytics are not implemented yet.

## Queue design direction

The queue engine will be implemented in this codebase with MongoDB and Mongoose, not with BullMQ or another queue library. MongoDB atomic document updates will be the basis for claiming work so that concurrent workers cannot successfully claim the same available job.

The planned reliability flow is:

1. Store each job's state, priority, scheduled time, attempt count, and idempotency key.
2. Atomically claim eligible jobs and assign a worker lease.
3. Recover work whose lease expires after a worker crash.
4. Retry failures with exponential backoff; move exhausted jobs to a dead-letter state.
5. Record attempts and allow an operator to replay a dead-lettered job.
6. Expose status and history for the React monitoring dashboard.

These are project goals, not completed features. Indexes, exact state transitions, and API contracts will be documented as they are implemented and tested.

## Day 1 runtime flow

```text
Browser (React/Vite) -- /api proxy --> Express API -- Mongoose --> MongoDB
```

The API loads `server/.env` from the backend entry-point directory and connects to MongoDB before it starts listening. Missing or invalid configuration prevents the API from accepting requests.
