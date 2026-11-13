# Reliable Job Queue with Dead-Letter Recovery

A learning project for building a reliable background job queue with MongoDB atomic operations. The queue engine will be implemented in this project; it will not use BullMQ or another ready-made queue library.

## Day 1 status

The initial React/Vite client and Express API foundation are in place. The API exposes a health endpoint and requires MongoDB to connect before accepting requests. Queue processing is not implemented yet.

## Prerequisites

- Node.js and npm
- A MongoDB Atlas cluster (or another MongoDB deployment)

## Run locally

1. In MongoDB Atlas, create a cluster, create a database user, and add your current development IP address under **Network Access**.
2. In the cluster's **Connect** dialog, select **Drivers** and copy the Node.js connection string.
3. Copy `.env.example` to `server/.env`. Replace `<db_username>`, `<db_password>`, and `<cluster-host>` in `MONGODB_URI` with the database user's credentials and the host from Atlas. URL-encode special characters in the username or password. Do not paste credentials into chat or commit `server/.env`.
4. In a terminal, run the API:

   ```powershell
   cd server
   npm install
   npm run dev
   ```

5. In another terminal, run the client:

   ```powershell
   cd client
   npm install
   npm run dev
   ```

6. Open the Vite URL shown in the client terminal. The dashboard checks `http://localhost:5000/api/health` through the Vite development proxy.

The API reads `MONGODB_URI` from `server/.env` and only starts listening after a successful database connection. If the URI is missing or the connection fails, startup exits with a safe diagnostic that does not print the connection string.

## Current API

- `GET /api/health` — API and database connection status.

See [API_DOCUMENTATION.md](./API_DOCUMENTATION.md) for the response shape and [DEVELOPMENT.md](./DEVELOPMENT.md) for the day-by-day progress log.
