# QueueOps — Free-Tier Deployment Guide
### Target Architecture: Vercel (Frontend) + Render (Backend + Worker) + MongoDB Atlas (Database)
**Budget: Strict ₹0 / $0 — 100% Free Tier**

---

## 1. Architecture Overview

```
   ┌──────────────────────────────────────────────────────────────┐
   │                       PUBLIC USERS                           │
   └──────────────────────────────┬───────────────────────────────┘
                                  │ HTTPS
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │             VERCEL HOBBY (FRONTEND)                          │
   │  - Framework: React 19 + Vite 7 + Tailwind CSS 4             │
   │  - Hosting: Vercel Global Edge Network                       │
   │  - URL: https://<your-app>.vercel.app                        │
   │  - Routing: SPA + API reverse proxy via client/vercel.json   │
   └──────────────────────────────┬───────────────────────────────┘
                                  │ HTTPS (/api/* proxied) + WSS
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │             RENDER FREE WEB SERVICE (BACKEND)                │
   │  - Service: Express API + Background Worker in 1 Container   │
   │  - Process: npm run start:production                         │
   │  - URL: https://<your-service>.onrender.com                  │
   │  - Port: Dynamic $PORT injected by Render                    │
   │  - Health Check: GET /health (returns 200 OK)                │
   │  - Security: First-party cookies via Vercel Edge Proxy       │
   └──────────────────────────────┬───────────────────────────────┘
                                  │ mongodb+srv://
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │             MONGODB ATLAS M0 (DATABASE)                      │
   │  - Plan: Shared M0 Free Cluster (512 MB Storage)             │
   │  - Network Access: 0.0.0.0/0 (Dynamic Render IPs)            │
   │  - Engine: MongoDB 7.x with Replica Set Support              │
   │  - Multi-tenant Isolation: User-scoped collections           │
   └──────────────────────────────────────────────────────────────┘
```

---

## 2. Free-Tier Limitations & Architectural Realities

Deploying on free hosting tiers comes with specific platform constraints. Understanding them ensures realistic expectations:

| Platform & Feature | Free Tier Constraint | Operational Impact | Recommended Free Workaround |
| :--- | :--- | :--- | :--- |
| **Render Web Service** | Spins down after 15 minutes of inactivity | First request takes ~45–60s cold start; worker pauses while asleep | Use a free external uptime monitor (e.g. [UptimeRobot](https://uptimerobot.com) or [cron-job.org](https://cron-job.org)) hitting `GET /health` every 10 minutes |
| **Render Filesystem** | Ephemeral storage (wiped on spin-down or redeploy) | Uploaded input images and generated PDFs persist only while container is running | For permanent production artifacts, an S3-compatible bucket (e.g. Cloudflare R2 free 10 GB) can be connected in future iterations |
| **Render Concurrency** | 512 MB RAM limit | Sufficient for Express + Sharp + PDFKit (~120 MB baseline) | Concurrency limited to 1 internal worker process (`start-production.js`) |
| **Render Workers** | Standalone "Background Worker" service is paid ($7/mo) | Separate worker service cannot be created on free plan | **Solved:** `server/src/start-production.js` runs both Express API and the Worker loop in the single free Web Service container |
| **Vercel Frontend** | Serverless static edge | Cannot run long-lived WebSockets directly through edge functions | **Solved:** Socket.IO connects directly to Render backend (`https://<service>.onrender.com`) with `withCredentials: true` |
| **MongoDB Atlas** | M0 Cluster limit: 512 MB data & 500 connections | Exceeding 512 MB requires pruning or manual cleanup | Artifact cleanup command (`npm run cleanup:artifacts`) and quota reservations keep data bounded |

---

## 3. Environment Variables Checklist

### A. Render Free Web Service (Backend)

Configure these in **Render Dashboard $\rightarrow$ Environment**:

| Variable Name | Required | Example / Recommended Value | Purpose |
| :--- | :---: | :--- | :--- |
| `NODE_ENV` | **Yes** | `production` | Enforces production security, HTTPS cookies, and error silencing |
| `PORT` | Auto | *Injected by Render automatically* | Port the API listens on |
| `MONGODB_URI` | **Yes** | `mongodb+srv://<user>:<password>@cluster0.abcde.mongodb.net/queueops_prod?retryWrites=true&w=majority` | Atlas connection string |
| `AUTH_JWT_SECRET` | **Yes** | *(Generate $\ge 32$ bytes)* | Secret used to sign session tokens (HS256) |
| `CLIENT_ORIGIN` | **Yes** | `https://<your-app>.vercel.app` | Exact HTTPS origin of your Vercel frontend |
| `COOKIE_SAME_SITE` | **Yes** | `none` | **Critical for Vercel + Render**: Enables cross-site cookies with `Secure` flag |
| `JOB_STORAGE_DIR` | **Yes** | `./storage` | Local directory for ephemeral image and PDF storage |
| `EMAIL_DEMO_MODE` | **Yes** | `true` | Safe mock email delivery (no external provider needed) |
| `EMAIL_SENDING_ENABLED`| No | `false` | Set to `true` only if Resend API key is configured |
| `RESEND_API_KEY` | No | *(Empty)* | Optional: Real transactional email API key |
| `WORKER_POLL_INTERVAL_MS`| No | `2000` | Worker queue polling frequency (2 seconds) |
| `WORKER_LEASE_DURATION_MS`| No| `30000` | Job claim lease lock duration (30 seconds) |
| `WORKER_HEARTBEAT_INTERVAL_MS`| No | `10000` | Lease renewal heartbeat interval (10 seconds) |

> [!IMPORTANT]
> **Generate JWT Secret**: Run this locally to generate a secure secret:
> ```bash
> node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
> ```

---

### B. Vercel Hobby (Frontend)

Configure in **Vercel Dashboard $\rightarrow$ Project Settings $\rightarrow$ Environment Variables**:

| Variable Name | Required | Example Value | Purpose |
| :--- | :---: | :--- | :--- |
| `VITE_API_BASE_URL` | Optional | `/api` | Base URL used by Axios (defaults to `/api`). Proxied by `client/vercel.json` to Render, ensuring 100% first-party cookies on Safari, Brave, Chrome Incognito, and Firefox. |

---

### C. MongoDB Atlas M0 (Database)

Obtain from **MongoDB Atlas Dashboard**:
- Connection string: `mongodb+srv://<username>:<password>@<cluster-url>/queueops_prod?retryWrites=true&w=majority`
- Never commit this string or expose credentials.

---

## 4. Step-by-Step Deployment Instructions

### Step 1: Set Up Free MongoDB Atlas M0 Cluster
1. Log in to [mongodb.com/cloud/atlas](https://www.mongodb.com/cloud/atlas).
2. Click **Create** $\rightarrow$ Select **M0 (Free)** cluster.
3. Choose a provider and region close to your Render region (e.g. AWS `us-east-1` / `oregon`).
4. **Security $\rightarrow$ Database Access**:
   - Add a new Database User (e.g., `queueops_admin`).
   - Choose **Password** authentication and generate a strong password (alphanumeric only, avoid special characters like `@` or `/`).
   - Assign role: **Read and write to any database**.
5. **Security $\rightarrow$ Network Access**:
   - Click **Add IP Address**.
   - Select **Allow Access from Anywhere** (`0.0.0.0/0`). *(Required because Render Free uses dynamic outbound IP addresses)*.
6. **Deployment $\rightarrow$ Database**:
   - Click **Connect** $\rightarrow$ **Drivers** (Node.js).
   - Copy the SRV connection string:
     `mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/queueops_prod?retryWrites=true&w=majority`

---

### Step 2: Deploy Backend to Render Free Web Service
1. Log in to [dashboard.render.com](https://dashboard.render.com).
2. Click **New +** $\rightarrow$ **Web Service**.
3. Connect your GitHub repository: `reliable-job-queue`.
4. Configure the service:
   - **Name**: `queueops-api` (or your preferred name)
   - **Region**: Choose closest to MongoDB Atlas (e.g. `Oregon (US West)`).
   - **Branch**: `development` (or `main`)
   - **Root Directory**: `server`
   - **Runtime**: `Node`
   - **Build Command**: `npm ci`
   - **Start Command**: `npm run start:production`
   - **Instance Type**: `Free` (512 MB RAM, 0.1 CPU)
5. Expand **Advanced**:
   - **Health Check Path**: `/health`
   - **Auto-Deploy**: `Yes`
6. Add the **Environment Variables** listed in Section 3A:
   - `NODE_ENV`: `production`
   - `MONGODB_URI`: *(Your Atlas SRV connection string)*
   - `AUTH_JWT_SECRET`: *(Your 32+ byte secret)*
   - `CLIENT_ORIGIN`: `https://<your-vercel-app>.vercel.app` *(You can update this after Vercel deployment)*
   - `COOKIE_SAME_SITE`: `none`
   - `JOB_STORAGE_DIR`: `./storage`
   - `EMAIL_DEMO_MODE`: `true`
7. Click **Create Web Service**.
8. Wait for deployment to complete (~2–3 minutes). Note the public service URL:
   `https://queueops-api.onrender.com`
9. Verify health in browser:
   Visit `https://queueops-api.onrender.com/health` $\rightarrow$ should return:
   ```json
   { "status": "ok", "service": "reliable-job-queue-api", "database": "connected" }
   ```

---

### Step 3: Deploy Frontend to Vercel Hobby
1. Log in to [vercel.com](https://vercel.com).
2. Click **Add New...** $\rightarrow$ **Project**.
3. Import your GitHub repository: `reliable-job-queue`.
4. Configure the project:
   - **Framework Preset**: `Vite`
   - **Root Directory**: Click `Edit` and select `client`.
   - **Build Command**: `npm run build` (detected automatically)
   - **Output Directory**: `dist` (detected automatically)
   - **Install Command**: `npm ci` (detected automatically)
5. Expand **Environment Variables**:
   - Key: `VITE_API_BASE_URL`
   - Value: `/api` *(or leave unset, as `client/src/api/jobs.js` defaults to `/api` which matches the rewrite in `client/vercel.json`)*
6. Click **Deploy**.
7. In ~60 seconds, your frontend will be live at:
   `https://<your-app>.vercel.app`

---

### Step 4: Finalize CORS on Render
1. Return to the Render dashboard for `queueops-api`.
2. Go to **Environment**.
3. Verify or update `CLIENT_ORIGIN` to match your actual Vercel URL:
   `CLIENT_ORIGIN` = `https://<your-app>.vercel.app`
4. Render will automatically redeploy the service with the updated origin.

---

## 5. Post-Deployment Smoke-Test Checklist

Verify these 10 items in order:

- [ ] **1. Public Frontend Load**: Open `https://<your-app>.vercel.app`. The QueueOps login page should render cleanly with styled Tailwind CSS.
- [ ] **2. Health Check**: Visit `https://<your-render-service>.onrender.com/health`. Verify `database: "connected"`.
- [ ] **3. User Registration**: Register a new user account with email and password. Verify successful redirect to the dashboard.
- [ ] **4. Cross-Domain Session Cookie**: Open Browser DevTools $\rightarrow$ Application $\rightarrow$ Cookies. Verify `rq_session` is present with `SameSite=None` and `Secure`.
- [ ] **5. Realtime Socket.IO**: Confirm the dashboard indicator in the top navbar shows "Connected" (green dot).
- [ ] **6. PDF Generation**:
  - Click **New Job** $\rightarrow$ Select `generate_pdf`.
  - Enter a title and section, submit.
  - Watch the status transition in real time from `pending` $\rightarrow$ `processing` $\rightarrow$ `completed`.
  - Click **Download** $\rightarrow$ confirm the generated PDF opens in a new tab.
- [ ] **7. Image Upload & Processing**:
  - Go to **Uploads** $\rightarrow$ upload a test image.
  - Submit a `process_image` resize job.
  - Verify the processed image thumbnail displays and can be downloaded.
- [ ] **8. Scheduled Job**:
  - Submit a job with `Run At` set 2 minutes in the future.
  - Verify it remains `pending` and executes automatically after 2 minutes.
- [ ] **9. Dead Letter Queue & Replay**:
  - Verify dead jobs appear under the **Dead Letter Queue** tab.
  - Test the **Replay** button to confirm the job returns to the queue and executes.
- [ ] **10. Worker Monitoring**:
  - Open the **Workers** view. Confirm the worker ID and active heartbeat are updating.
