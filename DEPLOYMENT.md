# Production Deployment Guide

This guide details the procedures for deploying, configuring, monitoring, and maintaining the Reliable Job Queue platform across cloud and containerized infrastructure.

---

## Architecture Overview

The system consists of five decoupled services:

1. **MongoDB (Database)**: Stores tenant credentials, job records, atomic lease states, dead-letter history, audit logs, and ephemeral Socket.IO queue events.
2. **API Server (Node.js/Express)**: Authenticated REST API and Socket.IO real-time notification bridge. Handles session management, CSRF validation, tenant isolation, quota enforcement, and job scheduling.
3. **Background Worker(s) (Node.js)**: Standalone processes claiming jobs with atomic conditional updates, maintaining renewable heartbeat leases, and executing handlers (`send_email`, `generate_pdf`, `process_image`).
4. **Web Dashboard (React/Vite/Nginx)**: Lightweight SPA served via Nginx with automated reverse proxying for `/api/` and `/socket.io/`.
5. **Shared Private Storage (Filesystem Volume)**: Persistent directory holding private image uploads and generated PDF/image outputs. Mounted by both API and Worker containers.

---

## Prerequisites & Pre-flight Checklist

- [ ] **Domain & SSL**: A registered domain pointing to your server with TLS/HTTPS configured.
- [ ] **JWT Secret**: Generate at least 32 cryptographically secure random bytes:
  ```bash
  node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
  ```
- [ ] **MongoDB Credentials**: Strong alphanumeric username and URL-safe base64url password.
- [ ] **Production Origins**: Set `CLIENT_ORIGIN` to exact HTTPS origin(s), e.g. `https://queue.example.com`.
- [ ] **Storage Mount**: Ensure `/app/storage` (or your custom `JOB_STORAGE_DIR`) is mounted to a persistent volume with read/write access for API and workers.

---

## Deployment Option 1: Docker Compose on VPS (Recommended)

This is the most direct deployment path for dedicated virtual private servers (AWS EC2, DigitalOcean Droplet, Hetzner Cloud, Linode).

### 1. Provision Server & Install Docker

Install Docker Engine and Docker Compose v2 following official documentation:
```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg
# Install Docker and Compose plugin
```

### 2. Clone Repository & Setup Environment

```bash
git clone https://github.com/Yashti15/reliable-job-queue.git /opt/jobqueue
cd /opt/jobqueue
cp .env.production.example .env.production
```

Edit `.env.production` with your secure secrets:
```bash
nano .env.production
```

### 3. Launch Services

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

### 4. Verify Health & Running Containers

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs api
docker compose -f docker-compose.prod.yml logs worker
curl -f http://127.0.0.1:5000/api/health
```

### 5. Setup TLS Termination with Nginx & Let's Encrypt

Configure a host-level reverse proxy (or Caddy/Traefik) terminating HTTPS on port 443 and proxying to `http://127.0.0.1:80`:

```nginx
server {
    listen 80;
    server_name queue.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name queue.example.com;

    ssl_certificate /etc/letsencrypt/live/queue.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/queue.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:80;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

---

## Deployment Option 2: Managed Platforms (Render / Railway / Fly.io)

For deployments using managed MongoDB (Atlas) and container hosts:

1. **Database**: Create a MongoDB Atlas M10+ cluster. Whitelist your application host IPs.
2. **Persistent Disk**: Attach a persistent disk or NFS/EFS volume mounted at `/app/storage` to both API and Worker services.
3. **API Service**:
   - Build: `server/Dockerfile`
   - Command: `node src/server.js`
   - Environment: See `.env.production.example`
4. **Worker Service**:
   - Build: `server/Dockerfile`
   - Command: `node src/worker.js`
   - Environment: Matches API settings
   - Autoscaling: Scale worker replicas based on queue backlog (`pending` job count)
5. **Client Service**:
   - Build: `client/Dockerfile`
   - Exposes Port 80
   - Reverse proxies `/api/` to internal API URL

---

## Tenant Quotas & Resource Management

The platform enforces multi-tenant limits to protect cluster resources:

| Quota Setting | Default | Description |
|---|---|---|
| `USER_STORAGE_QUOTA_BYTES` | `52428800` (50 MB) | Total artifact bytes stored per tenant |
| `USER_MAX_UPLOAD_COUNT` | `50` | Maximum active image uploads per tenant |
| `USER_MAX_PENDING_JOBS` | `50` | Maximum concurrent pending jobs per tenant |
| `EMAIL_DAILY_QUOTA_PER_USER`| `5` | Outbound email submissions allowed per day |
| `EMAIL_JOBS_PER_MINUTE` | `3` | Rate limit for email job queuing |

---

## Backup & Recovery Procedures

### 1. Database Backups

Run daily MongoDB backups:
```bash
docker compose -f docker-compose.prod.yml exec mongo mongodump \
  --username "$MONGO_ROOT_USERNAME" \
  --password "$MONGO_ROOT_PASSWORD" \
  --authenticationDatabase admin \
  --db reliable_job_queue \
  --archive=/data/db/backup-$(date +%Y%m%d).gz --gzip
```

### 2. Artifact Storage Backups

Archive the shared private storage volume:
```bash
docker run --rm \
  -v jobqueue_artifact_prod_storage:/storage:ro \
  -v $(pwd)/backups:/backup \
  alpine tar czf /backup/artifacts-$(date +%Y%m%d).tar.gz -C /storage .
```

---

## Upgrades & Maintenance

### Zero-Downtime Rolling Restarts

Workers can be safely restarted or scaled without losing in-flight jobs. On `SIGTERM` or `SIGINT`, workers finish processing their active job before stopping:

```bash
# Pull updated images
docker compose -f docker-compose.prod.yml pull

# Recreate API with minimal disruption
docker compose -f docker-compose.prod.yml up -d --no-deps api

# Scale workers or restart workers
docker compose -f docker-compose.prod.yml up -d --no-deps worker
```
