FROM node:22-alpine

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source
COPY src ./src

# Create private storage directory
RUN mkdir -p /app/storage && chmod 700 /app/storage

ENV NODE_ENV=production \
    PORT=5000 \
    JOB_STORAGE_DIR=/app/storage

EXPOSE 5000

CMD ["node", "src/server.js"]
