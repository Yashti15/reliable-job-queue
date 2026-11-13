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

Queue, job, replay, and analytics endpoints are not implemented yet.
